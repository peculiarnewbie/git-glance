use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;
use axum::extract::ws::{Message as AxumMessage, WebSocket};
use futures::{SinkExt, StreamExt};
use serde_json::json;

use crate::cache::CacheService;
use crate::git::GitService;
use crate::opencode;
use crate::peer::PeerManager;
use crate::scanner;
use crate::types::*;

pub struct ServerDeps {
    pub git: Arc<GitService>,
    pub cache: Arc<CacheService>,
    pub peers: Arc<PeerManager>,
    pub local_name: String,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

pub async fn handle_ws_connection(socket: WebSocket, deps: Arc<ServerDeps>) {
    println!("WS client connected");

    let (mut write, mut read) = socket.split();
    let (tx, mut rx) = mpsc::channel::<String>(128);

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(AxumMessage::Text(msg.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(AxumMessage::Text(t)) => t,
            Ok(_) => continue,
            Err(_) => break,
        };

        let req: WSRequest = match serde_json::from_str(&msg) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let tx = tx.clone();
        let deps = deps.clone();
        tokio::spawn(async move {
            handle_action(req, deps, tx).await;
        });
    }
}

async fn send_response(tx: &mpsc::Sender<String>, resp: WSResponse) {
    if let Ok(data) = serde_json::to_string(&resp) {
        let _ = tx.send(data).await;
    }
}

async fn handle_action(req: WSRequest, deps: Arc<ServerDeps>, tx: mpsc::Sender<String>) {
    match req.action.as_str() {
        "getRepos" => handle_get_repos(&req, &deps, &tx).await,
        "getConfig" => handle_get_config(&req, &deps, &tx).await,
        "setConfig" => handle_set_config(&req, &deps, &tx).await,
        "pull" => handle_pull(&req, &deps, &tx).await,
        "push" => handle_push(&req, &deps, &tx).await,
        "rescanRepo" => handle_rescan_repo(&req, &deps, &tx).await,
        "checkPull" => handle_check_pull(&req, &deps, &tx).await,
        "updateRepoSettings" => handle_update_repo_settings(&req, &deps, &tx).await,
        "cancelScan" => {
            scanner::cancel_scan();
            send_response(&tx, WSResponse::result(&req.id, json!({"ok": true}))).await;
        }
        "cancelCommit" | "cancelFetch" | "cancel" => {
            send_response(&tx, WSResponse::result(&req.id, json!({"ok": true}))).await;
        }
        "scan" => handle_scan(&req, &deps, &tx).await,
        "scanOnly" => handle_scan_only(&req, &deps, &tx).await,
        "commitPush" => handle_commit_push(&req, &deps, &tx).await,
        "fetchAll" => handle_fetch_all(&req, &deps, &tx).await,
        "getDiff" => handle_get_diff(&req, &deps, &tx).await,
        _ => {
            send_response(
                &tx,
                WSResponse::error(&req.id, &format!("unknown action: {}", req.action)),
            )
            .await;
        }
    }
}

async fn handle_get_repos(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let all_repos = deps.cache.get_all_repos().await;
    let all_repos: Vec<GitRepo> = all_repos
        .into_iter()
        .map(|mut r| {
            if r.machine.is_empty() {
                r.machine = deps.local_name.clone();
            }
            r
        })
        .collect();
    let statuses = deps.peers.get_statuses().await;
    let scanned_dirs = deps.cache.get_scanned_dirs().await;

    let now = now_millis();
    let mut machines = vec![MachineStatus {
        name: deps.local_name.clone(),
        url: String::new(),
        online: true,
        last_seen: Some(now),
    }];
    machines.extend(statuses);

    send_response(
        tx,
        WSResponse::result(
            &req.id,
            json!(ReposResponse {
                repos: all_repos,
                scanned_at: now_millis(),
                scanned_dirs,
                machines,
            }),
        ),
    )
    .await;
}

async fn handle_get_config(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let cfg = deps.cache.load_config().await;
    let statuses = deps.peers.get_statuses().await;

    let root_dir = if cfg.root_dir.is_empty() {
        None
    } else {
        Some(cfg.root_dir.clone())
    };

    let model = if cfg.opencode_model.is_empty() {
        "deepseek/deepseek-v4-flash".to_string()
    } else {
        cfg.opencode_model.clone()
    };

    let now = now_millis();
    let mut machines_with_online = vec![MachineStatus {
        name: deps.local_name.clone(),
        url: String::new(),
        online: true,
        last_seen: Some(now),
    }];

    for m in &cfg.machines {
        if m.name == deps.local_name {
            continue;
        }
        let online = statuses.iter().any(|s| s.name == m.name && s.online);
        machines_with_online.push(MachineStatus {
            name: m.name.clone(),
            url: m.url.clone(),
            online,
            last_seen: None,
        });
    }

    send_response(
        tx,
        WSResponse::result(
            &req.id,
            json!({
                "rootDir": root_dir,
                "opencodeModel": model,
                "token": cfg.token,
                "machines": machines_with_online,
            }),
        ),
    )
    .await;
}

async fn handle_set_config(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let mut existing = deps.cache.load_config().await;
    let params = &req.params;

    if let Some(v) = params.get("rootDir").and_then(|v| v.as_str()) {
        existing.root_dir = v.to_string();
        deps.cache.add_scanned_dir(v).await;
    }
    if let Some(v) = params.get("opencodeModel").and_then(|v| v.as_str()) {
        existing.opencode_model = v.to_string();
    }
    if let Some(machines) = params.get("machines").and_then(|v| v.as_array()) {
        let cfg_machines: Vec<ServerConfigMachine> = machines
            .iter()
            .filter_map(|m| {
                let name = m.get("name")?.as_str()?;
                let url = m.get("url")?.as_str()?;
                let token = m.get("token").and_then(|t| t.as_str()).unwrap_or("");
                if !name.is_empty() && !url.is_empty() {
                    Some(ServerConfigMachine {
                        name: name.to_string(),
                        url: url.to_string(),
                        token: token.to_string(),
                    })
                } else {
                    None
                }
            })
            .collect();
        existing.machines = cfg_machines;
        deps.peers.update_config(&existing).await;
    }

    deps.cache.save_config(&existing).await;
    send_response(tx, WSResponse::result(&req.id, json!({"ok": true}))).await;
}

async fn handle_pull(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");
    let machine = params.get("machine").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "repo" parameter"#)).await;
        return;
    }

    let machine = if machine.is_empty() || machine == deps.local_name {
        deps.local_name.clone()
    } else {
        machine.to_string()
    };

    if machine != deps.local_name {
        match deps.peers.proxy_pull(&machine, repo).await {
            Ok(result) => {
                send_response(tx, WSResponse::result(&req.id, json!(result))).await;
            }
            Err(e) => {
                send_response(tx, WSResponse::error(&req.id, &e)).await;
            }
        }
        return;
    }

    match deps
        .git
        .run_with_lock("pull", repo, Duration::from_secs(30))
        .await
    {
        Ok(output) => {
            update_repo_in_cache(deps, repo).await;
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(PullPushResult { ok: true, output: Some(output), error: None }),
                ),
            )
            .await;
        }
        Err(e) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(PullPushResult { ok: false, output: None, error: Some(e.to_string()) }),
                ),
            )
            .await;
        }
    }
}

async fn handle_push(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");
    let machine = params.get("machine").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "repo" parameter"#)).await;
        return;
    }

    let machine = if machine.is_empty() || machine == deps.local_name {
        deps.local_name.clone()
    } else {
        machine.to_string()
    };

    if machine != deps.local_name {
        match deps.peers.proxy_push(&machine, repo).await {
            Ok(result) => {
                send_response(tx, WSResponse::result(&req.id, json!(result))).await;
            }
            Err(e) => {
                send_response(tx, WSResponse::error(&req.id, &e)).await;
            }
        }
        return;
    }

    match deps
        .git
        .run_with_lock("push", repo, Duration::from_secs(60))
        .await
    {
        Ok(output) => {
            update_repo_in_cache(deps, repo).await;
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(PullPushResult { ok: true, output: Some(output), error: None }),
                ),
            )
            .await;
        }
        Err(e) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(PullPushResult { ok: false, output: None, error: Some(e.to_string()) }),
                ),
            )
            .await;
        }
    }
}

async fn handle_rescan_repo(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "repo" parameter"#)).await;
        return;
    }

    match update_repo_in_cache(deps, repo).await {
        Some(updated) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult { ok: true, repo: Some(updated), error: None }),
                ),
            )
            .await;
        }
        None => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult { ok: false, repo: None, error: Some("Failed to rescan repo".to_string()) }),
                ),
            )
            .await;
        }
    }
}

async fn handle_check_pull(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "repo" parameter"#)).await;
        return;
    }

    let _ = deps
        .git
        .run_with_lock("fetch origin", repo, Duration::from_secs(30))
        .await;

    match update_repo_in_cache(deps, repo).await {
        Some(updated) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult { ok: true, repo: Some(updated), error: None }),
                ),
            )
            .await;
        }
        None => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult { ok: false, repo: None, error: Some("Failed to rescan repo after fetch".to_string()) }),
                ),
            )
            .await;
        }
    }
}

async fn handle_update_repo_settings(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "repo" parameter"#)).await;
        return;
    }

    let mut repos = deps.cache.load().await;

    for r in &mut repos {
        if r.path != repo {
            continue;
        }
        let settings = r.settings.get_or_insert_with(|| GitRepoSettings {
            skip_untracked: false,
            skip_pull_check: false,
            hidden: false,
        });
        if let Some(v) = params.get("skipUntracked").and_then(|v| v.as_bool()) {
            settings.skip_untracked = v;
        }
        if let Some(v) = params.get("skipPullCheck").and_then(|v| v.as_bool()) {
            settings.skip_pull_check = v;
        }
        if let Some(v) = params.get("hidden").and_then(|v| v.as_bool()) {
            settings.hidden = v;
        }
        break;
    }

    deps.cache.save(&repos).await;
    send_response(tx, WSResponse::result(&req.id, json!({"ok": true}))).await;
}

async fn handle_scan(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let root_dir = params.get("rootDir").and_then(|v| v.as_str()).unwrap_or("");

    if root_dir.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "rootDir" parameter"#)).await;
        return;
    }

    scanner::reset_cancel();
    deps.cache.add_scanned_dir(root_dir).await;

    let (progress_tx, mut progress_rx) = mpsc::channel(100);
    let git = deps.git.clone();
    let cache = deps.cache.clone();
    let machine = deps.local_name.clone();
    let root = root_dir.to_string();

    tokio::spawn(async move {
        scanner::scan_all(git, cache, root, machine, progress_tx).await;
    });

    while let Some(p) = progress_rx.recv().await {
        let resp = WSResponse::progress(&req.id, serde_json::to_value(&p).unwrap());
        if tx.send(serde_json::to_string(&resp).unwrap()).await.is_err() {
            scanner::cancel_scan();
            return;
        }
    }
    deps.peers.notify_repos_updated().await;
    send_response(tx, WSResponse::done(&req.id)).await;
}

async fn handle_scan_only(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let root_dir = params.get("rootDir").and_then(|v| v.as_str()).unwrap_or("");

    if root_dir.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "rootDir" parameter"#)).await;
        return;
    }

    scanner::reset_cancel();
    deps.cache.add_scanned_dir(root_dir).await;

    let (progress_tx, mut progress_rx) = mpsc::channel(100);
    let git = deps.git.clone();
    let cache = deps.cache.clone();
    let machine = deps.local_name.clone();
    let root = root_dir.to_string();

    tokio::spawn(async move {
        scanner::scan_only(git, cache, root, machine, progress_tx).await;
    });

    while let Some(p) = progress_rx.recv().await {
        let resp = WSResponse::progress(&req.id, serde_json::to_value(&p).unwrap());
        if tx.send(serde_json::to_string(&resp).unwrap()).await.is_err() {
            scanner::cancel_scan();
            return;
        }
    }
    deps.peers.notify_repos_updated().await;
    send_response(tx, WSResponse::done(&req.id)).await;
}

async fn handle_commit_push(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(tx, WSResponse::error(&req.id, r#"Missing "repo" parameter"#)).await;
        return;
    }

    // Staging
    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(CommitProgress {
                phase: "staging".to_string(),
                error: None,
                subject: None,
                body: None,
                repo_path: Some(repo.to_string()),
            }),
        ),
    )
    .await;

    if let Err(e) = deps
        .git
        .run_with_lock("add .", repo, Duration::from_secs(15))
        .await
    {
        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(CommitProgress {
                    phase: "error".to_string(),
                    error: Some(e.to_string()),
                    subject: None,
                    body: None,
                    repo_path: Some(repo.to_string()),
                }),
            ),
        )
        .await;
        send_response(tx, WSResponse::done(&req.id)).await;
        return;
    }

    let branch = match deps
        .git
        .run_with_lock("rev-parse --abbrev-ref HEAD", repo, Duration::from_secs(5))
        .await
    {
        Ok(b) => b,
        Err(e) => {
            send_response(
                tx,
                WSResponse::progress(
                    &req.id,
                    json!(CommitProgress {
                        phase: "error".to_string(),
                        error: Some(e.to_string()),
                        subject: None,
                        body: None,
                        repo_path: Some(repo.to_string()),
                    }),
                ),
            )
            .await;
            send_response(tx, WSResponse::done(&req.id)).await;
            return;
        }
    };

    let staged_summary = deps
        .git
        .run("diff --cached --stat", repo, Duration::from_secs(10))
        .await
        .unwrap_or_default();
    let staged_patch = deps
        .git
        .run("diff --cached", repo, Duration::from_secs(10))
        .await
        .unwrap_or_default();

    if staged_patch.is_empty() {
        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(CommitProgress {
                    phase: "error".to_string(),
                    error: Some("No changes to commit".to_string()),
                    subject: None,
                    body: None,
                    repo_path: Some(repo.to_string()),
                }),
            ),
        )
        .await;
        send_response(tx, WSResponse::done(&req.id)).await;
        return;
    }

    // Generating
    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(CommitProgress {
                phase: "generating".to_string(),
                error: None,
                subject: None,
                body: None,
                repo_path: Some(repo.to_string()),
            }),
        ),
    )
    .await;

    let cfg = deps.cache.load_config().await;
    let model = if cfg.opencode_model.is_empty() {
        "deepseek/deepseek-v4-flash".to_string()
    } else {
        cfg.opencode_model
    };

    println!("[commitPush] repo={} model={}", repo, model);

    let commit_msg = match opencode::generate_commit_message(
        repo,
        &branch,
        &staged_summary,
        &staged_patch,
        &model,
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            send_response(
                tx,
                WSResponse::progress(
                    &req.id,
                    json!(CommitProgress {
                        phase: "error".to_string(),
                        error: Some(e),
                        subject: None,
                        body: None,
                        repo_path: Some(repo.to_string()),
                    }),
                ),
            )
            .await;
            send_response(tx, WSResponse::done(&req.id)).await;
            return;
        }
    };

    // Committing
    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(CommitProgress {
                phase: "committing".to_string(),
                error: None,
                subject: None,
                body: None,
                repo_path: Some(repo.to_string()),
            }),
        ),
    )
    .await;

    let full_message = if commit_msg.body.is_empty() {
        commit_msg.subject.clone()
    } else {
        format!("{}\n\n{}", commit_msg.subject, commit_msg.body)
    };

    if let Err(e) = deps
        .git
        .run_with_stdin_and_lock(
            &["commit", "-F", "-"],
            &full_message,
            repo,
            Duration::from_secs(15),
        )
        .await
    {
        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(CommitProgress {
                    phase: "error".to_string(),
                    error: Some(e.to_string()),
                    subject: None,
                    body: None,
                    repo_path: Some(repo.to_string()),
                }),
            ),
        )
        .await;
        send_response(tx, WSResponse::done(&req.id)).await;
        return;
    }

    // Pushing
    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(CommitProgress {
                phase: "pushing".to_string(),
                error: None,
                subject: None,
                body: None,
                repo_path: Some(repo.to_string()),
            }),
        ),
    )
    .await;

    if let Err(e) = deps
        .git
        .run_with_lock("push", repo, Duration::from_secs(60))
        .await
    {
        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(CommitProgress {
                    phase: "error".to_string(),
                    error: Some(e.to_string()),
                    subject: None,
                    body: None,
                    repo_path: Some(repo.to_string()),
                }),
            ),
        )
        .await;
        send_response(tx, WSResponse::done(&req.id)).await;
        return;
    }

    update_repo_in_cache(deps, repo).await;

    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(CommitProgress {
                phase: "done".to_string(),
                error: None,
                subject: Some(commit_msg.subject),
                body: Some(commit_msg.body),
                repo_path: Some(repo.to_string()),
            }),
        ),
    )
    .await;
    send_response(tx, WSResponse::done(&req.id)).await;
}

async fn handle_fetch_all(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    scanner::reset_cancel();

    let all_repos = deps.cache.get_all_repos().await;
    let local_repos: Vec<GitRepo> = all_repos
        .into_iter()
        .filter(|r| {
            !(r.settings.as_ref().map_or(false, |s| s.hidden)
                || r.settings.as_ref().map_or(false, |s| s.skip_pull_check))
        })
        .collect();

    let total = local_repos.len();
    if total == 0 {
        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(FetchProgress {
                    phase: "done".to_string(),
                    repo_path: None,
                    repo_name: None,
                    current: 0,
                    total: 0,
                    ahead: None,
                    behind: None,
                    branch: None,
                    error: None,
                }),
            ),
        )
        .await;
        send_response(tx, WSResponse::done(&req.id)).await;
        return;
    }

    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(FetchProgress {
                phase: "fetching".to_string(),
                repo_path: None,
                repo_name: None,
                current: 0,
                total,
                ahead: None,
                behind: None,
                branch: None,
                error: None,
            }),
        ),
    )
    .await;

    for (i, repo) in local_repos.iter().enumerate() {
        if scanner::SCAN_CANCELED.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }

        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(FetchProgress {
                    phase: "repo".to_string(),
                    repo_path: Some(repo.path.clone()),
                    repo_name: Some(repo.name.clone()),
                    current: i,
                    total,
                    ahead: None,
                    behind: None,
                    branch: None,
                    error: None,
                }),
            ),
        )
        .await;

        let _ = deps
            .git
            .run_with_lock("fetch origin", &repo.path, Duration::from_secs(30))
            .await;

        let status = deps.git.get_status_with_lock(&repo.path).await.ok();
        let (a, b) = if let Some(ref s) = status {
            (Some(s.ahead), Some(s.behind))
        } else {
            (None, None)
        };

        if status.is_some() {
            update_repo_in_cache(deps, &repo.path).await;
        }

        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(FetchProgress {
                    phase: "repo".to_string(),
                    repo_path: Some(repo.path.clone()),
                    repo_name: Some(repo.name.clone()),
                    current: i + 1,
                    total,
                    ahead: a,
                    behind: b,
                    branch: repo.branch.clone(),
                    error: None,
                }),
            ),
        )
        .await;
    }

    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(FetchProgress {
                phase: "done".to_string(),
                repo_path: None,
                repo_name: None,
                current: total,
                total,
                ahead: None,
                behind: None,
                branch: None,
                error: None,
            }),
        ),
    )
    .await;
    scanner::release_memory();
    scanner::log_rss("fetch_all end");
    send_response(tx, WSResponse::done(&req.id)).await;
}

async fn handle_get_diff(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");
    let file = params.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let status_type = params.get("status").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() || file.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" or "file" parameter"#),
        )
        .await;
        return;
    }

    println!(
        "[diff] request repo={:?} file={:?} status={:?}",
        repo, file, status_type
    );

    let diff_result: Result<String, String> = match status_type {
        "staged" => deps
            .git
            .run_args_with_lock(
                &["diff", "--cached", "--", file],
                repo,
                Duration::from_secs(15),
            )
            .await
            .map_err(|e| e.to_string()),
        "unstaged" => deps
            .git
            .run_args_with_lock(&["diff", "--", file], repo, Duration::from_secs(15))
            .await
            .map_err(|e| e.to_string()),
        "untracked" => {
            let path = std::path::Path::new(repo).join(file);
            match tokio::fs::read_to_string(&path).await {
                Ok(content) => {
                    let lines: Vec<&str> = content.lines().collect();
                    let mut diff = format!(
                        "diff --git a/{} b/{}\nnew file mode 100644\n--- /dev/null\n+++ b/{}\n@@ -0,0 +1,{} @@\n",
                        file,
                        file,
                        file,
                        lines.len()
                    );
                    for line in &lines {
                        diff.push('+');
                        diff.push_str(line);
                        diff.push('\n');
                    }
                    Ok(diff)
                }
                Err(e) => Err(format!("Cannot read untracked file: {}", e)),
            }
        }
        _ => {
            send_response(
                tx,
                WSResponse::error(
                    &req.id,
                    r#"Invalid "status" parameter (must be staged, unstaged, or untracked)"#,
                ),
            )
            .await;
            return;
        }
    };

    match diff_result {
        Ok(diff) => {
            if diff.is_empty() && status_type != "untracked" {
                send_response(
                    tx,
                    WSResponse::error(
                        &req.id,
                        &format!(
                            "No {} diff for {}. The repo status is probably stale.",
                            status_type, file
                        ),
                    ),
                )
                .await;
                return;
            }
            println!(
                "[diff] response repo={:?} file={:?} status={:?} bytes={}",
                repo,
                file,
                status_type,
                diff.len()
            );
            send_response(
                tx,
                WSResponse::result(&req.id, json!({"file": file, "diff": diff})),
            )
            .await;
        }
        Err(e) => {
            println!(
                "[diff] error repo={:?} file={:?} status={:?} err={:?}",
                repo, file, status_type, e
            );
            send_response(
                tx,
                WSResponse::error(&req.id, &format!("Git diff failed: {}", e)),
            )
            .await;
        }
    }
}

async fn update_repo_in_cache(deps: &ServerDeps, repo_path: &str) -> Option<GitRepo> {
    let status = deps.git.get_status(repo_path).await.ok()?;
    let repos = deps.cache.load().await;

    let name = PathBuf::from(repo_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let commit_time_ms = status.last_commit_time.map(|t| t * 1000).unwrap_or(0);

    let mut updated = GitRepo {
        name,
        path: repo_path.to_string(),
        branch: Some(status.branch),
        has_changes: status.has_changes,
        staged: status.staged,
        staged_files: status.staged_files,
        unstaged: status.unstaged,
        unstaged_files: status.unstaged_files,
        untracked: status.untracked,
        untracked_files: status.untracked_files,
        ahead: status.ahead,
        behind: status.behind,
        remote: status.remote,
        last_commit_time: Some(commit_time_ms),
        week_commits: status.week_commits,
        last_scan_time: Some(now_millis()),
        machine: deps.local_name.clone(),
        error: None,
        settings: None,
    };

    let mut new_repos = repos;
    for r in &new_repos {
        if r.path == repo_path {
            updated.settings = r.settings.clone();
            break;
        }
    }

    let mut found = false;
    for r in &mut new_repos {
        if r.path == repo_path {
            *r = updated.clone();
            found = true;
            break;
        }
    }
    if !found {
        new_repos.push(updated.clone());
    }

    deps.cache.save(&new_repos).await;
    deps.peers.notify_repos_updated().await;

    Some(updated)
}
