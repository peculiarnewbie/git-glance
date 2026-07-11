use futures::{stream, StreamExt};
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use crate::cache::CacheService;
use crate::git::GitService;
use crate::opencode;
use crate::scanner;
use crate::types::*;

pub struct ServerDeps {
    pub git: Arc<GitService>,
    pub cache: Arc<CacheService>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn send_response(tx: &mpsc::Sender<String>, resp: WSResponse) {
    if let Ok(data) = serde_json::to_string(&resp) {
        let _ = tx.send(data).await;
    }
}

pub async fn handle_action(req: WSRequest, deps: Arc<ServerDeps>, tx: mpsc::Sender<String>) {
    match req.action.as_str() {
        "getRepos" => handle_get_repos(&req, &deps, &tx).await,
        "getWorkspaceStatus" => handle_get_workspace_status(&req, &deps, &tx).await,
        "getRepoStatus" => handle_get_repo_status(&req, &deps, &tx).await,
        "searchRepos" => handle_search_repos(&req, &deps, &tx).await,
        "getRecentActivity" => handle_get_recent_activity(&req, &deps, &tx).await,
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
        "cancelFetch" => {
            scanner::cancel_scan();
            send_response(&tx, WSResponse::result(&req.id, json!({"ok": true}))).await;
        }
        "cancelCommit" | "cancel" => {
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

async fn cached_repos(deps: &ServerDeps) -> Vec<GitRepo> {
    deps.cache.get_all_repos().await
}

async fn cached_repo_exists(deps: &ServerDeps, repo_path: &str) -> bool {
    cached_repos(deps)
        .await
        .iter()
        .any(|repo| repo.path == repo_path)
}

async fn handle_get_repos(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let all_repos = cached_repos(deps).await;
    let scanned_dirs = deps.cache.get_scanned_dirs().await;

    send_response(
        tx,
        WSResponse::result(
            &req.id,
            json!(ReposResponse {
                repos: all_repos,
                scanned_at: now_millis(),
                scanned_dirs,
            }),
        ),
    )
    .await;
}

async fn handle_get_workspace_status(
    req: &WSRequest,
    deps: &ServerDeps,
    tx: &mpsc::Sender<String>,
) {
    let repos = cached_repos(deps).await;
    let response = WorkspaceStatusResponse {
        generated_at: now_millis(),
        total_repos: repos.len(),
        dirty_repos: repos.iter().filter(|r| r.has_changes).count(),
        ahead_repos: repos.iter().filter(|r| r.ahead > 0).count(),
        behind_repos: repos.iter().filter(|r| r.behind > 0).count(),
        errored_repos: repos.iter().filter(|r| r.error.is_some()).count(),
        hidden_repos: repos
            .iter()
            .filter(|r| r.settings.as_ref().map_or(false, |s| s.hidden))
            .count(),
        repos,
    };
    send_response(tx, WSResponse::result(&req.id, json!(response))).await;
}

async fn handle_get_repo_status(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let repo_path = req
        .params
        .get("repo")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let refresh = req
        .params
        .get("refresh")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if repo_path.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
        return;
    }

    let cached_repo = cached_repos(deps)
        .await
        .into_iter()
        .find(|repo| repo.path == repo_path);
    if cached_repo.is_none() {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the workspace cache"),
        )
        .await;
        return;
    }
    let refreshed = if refresh {
        update_repo_in_cache(deps, repo_path).await.is_some()
    } else {
        false
    };

    let repo = if refreshed {
        cached_repos(deps)
            .await
            .into_iter()
            .find(|repo| repo.path == repo_path)
    } else {
        cached_repo
    };
    match repo {
        Some(repo) => {
            send_response(
                tx,
                WSResponse::result(&req.id, json!({ "repo": repo, "fresh": refreshed })),
            )
            .await
        }
        None => {
            send_response(
                tx,
                WSResponse::error(&req.id, "Repository not found in the workspace cache"),
            )
            .await
        }
    }
}

async fn handle_search_repos(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let query = req
        .params
        .get("query")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let state = req.params.get("state").and_then(|v| v.as_str());
    let include_hidden = req
        .params
        .get("includeHidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let limit = req
        .params
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(100)
        .clamp(1, 1_000) as usize;

    let repos: Vec<GitRepo> = cached_repos(deps)
        .await
        .into_iter()
        .filter(|repo| {
            include_hidden
                || !repo
                    .settings
                    .as_ref()
                    .map_or(false, |settings| settings.hidden)
        })
        .filter(|repo| match state {
            Some("dirty") => repo.has_changes,
            Some("ahead") => repo.ahead > 0,
            Some("behind") => repo.behind > 0,
            Some("error") => repo.error.is_some(),
            Some("clean") => {
                !repo.has_changes && repo.ahead == 0 && repo.behind == 0 && repo.error.is_none()
            }
            _ => true,
        })
        .filter(|repo| {
            query.is_empty()
                || [
                    repo.name.as_str(),
                    repo.path.as_str(),
                    repo.branch.as_deref().unwrap_or(""),
                    repo.remote.as_deref().unwrap_or(""),
                ]
                .iter()
                .any(|field| field.to_lowercase().contains(&query))
        })
        .take(limit)
        .collect();
    send_response(tx, WSResponse::result(&req.id, json!({ "repos": repos }))).await;
}

async fn handle_get_recent_activity(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let now = now_millis() / 1000;
    let since = req
        .params
        .get("since")
        .and_then(|v| v.as_i64())
        .unwrap_or(now - 24 * 60 * 60);
    let limit_per_repo = req
        .params
        .get("limitPerRepo")
        .and_then(|v| v.as_u64())
        .unwrap_or(20)
        .clamp(1, 100) as usize;
    let include_hidden = req
        .params
        .get("includeHidden")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let repos: Vec<GitRepo> = cached_repos(deps)
        .await
        .into_iter()
        .filter(|repo| include_hidden || !repo.settings.as_ref().map_or(false, |s| s.hidden))
        .collect();

    let git = deps.git.clone();
    let activities = stream::iter(repos.into_iter().map(|repo| {
        let git = git.clone();
        async move {
            let result = git
                .recent_commits_with_lock(&repo.path, since, limit_per_repo)
                .await;
            match result {
                Ok(commits) => RepoActivity {
                    repo,
                    commits,
                    error: None,
                },
                Err(error) => RepoActivity {
                    repo,
                    commits: Vec::new(),
                    error: Some(error.to_string()),
                },
            }
        }
    }))
    .buffer_unordered(4)
    .collect::<Vec<_>>()
    .await;

    send_response(
        tx,
        WSResponse::result(
            &req.id,
            json!(RecentActivityResponse {
                since,
                until: now,
                activities,
            }),
        ),
    )
    .await;
}

async fn handle_get_config(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let cfg = deps.cache.load_config().await;

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

    send_response(
        tx,
        WSResponse::result(
            &req.id,
            json!({
                "rootDir": root_dir,
                "opencodeModel": model,
                "excludedDirs": cfg.excluded_dirs,
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
    if let Some(arr) = params.get("excludedDirs").and_then(|v| v.as_array()) {
        existing.excluded_dirs = arr
            .iter()
            .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
            .filter(|s| !s.is_empty())
            .collect();
    }

    deps.cache.save_config(&existing).await;
    send_response(tx, WSResponse::result(&req.id, json!({"ok": true}))).await;
}

async fn handle_pull(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
        return;
    }

    if !cached_repo_exists(deps, repo).await {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the workspace cache"),
        )
        .await;
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
                    json!(PullPushResult {
                        ok: true,
                        output: Some(output),
                        error: None
                    }),
                ),
            )
            .await;
        }
        Err(e) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(PullPushResult {
                        ok: false,
                        output: None,
                        error: Some(e.to_string())
                    }),
                ),
            )
            .await;
        }
    }
}

async fn handle_push(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
        return;
    }

    if !cached_repo_exists(deps, repo).await {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the workspace cache"),
        )
        .await;
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
                    json!(PullPushResult {
                        ok: true,
                        output: Some(output),
                        error: None
                    }),
                ),
            )
            .await;
        }
        Err(e) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(PullPushResult {
                        ok: false,
                        output: None,
                        error: Some(e.to_string())
                    }),
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
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
        return;
    }

    if !cached_repo_exists(deps, repo).await {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the local workspace cache"),
        )
        .await;
        return;
    }

    match update_repo_in_cache(deps, repo).await {
        Some(updated) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult {
                        ok: true,
                        repo: Some(updated),
                        error: None
                    }),
                ),
            )
            .await;
        }
        None => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult {
                        ok: false,
                        repo: None,
                        error: Some("Failed to rescan repo".to_string())
                    }),
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
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
        return;
    }

    if !cached_repo_exists(deps, repo).await {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the local workspace cache"),
        )
        .await;
        return;
    }

    let _ = deps
        .git
        .run_with_lock("fetch origin", repo, Duration::from_secs(30))
        .await;

    if let Ok(status) = deps.git.get_status_with_lock(repo).await {
        let should_auto_pull = deps
            .cache
            .get_all_repos()
            .await
            .into_iter()
            .find(|r| r.path == repo)
            .and_then(|r| r.settings)
            .map_or(false, |s| s.auto_pull_if_clean)
            && status.behind > 0
            && status.ahead == 0
            && !status.has_changes
            && status.staged == 0
            && status.unstaged == 0
            && status.untracked == 0;

        if should_auto_pull {
            let _ = deps
                .git
                .run_with_lock("pull --ff-only", repo, Duration::from_secs(30))
                .await;
        }
    }

    match update_repo_in_cache(deps, repo).await {
        Some(updated) => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult {
                        ok: true,
                        repo: Some(updated),
                        error: None
                    }),
                ),
            )
            .await;
        }
        None => {
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!(RescanResult {
                        ok: false,
                        repo: None,
                        error: Some("Failed to rescan repo after fetch".to_string())
                    }),
                ),
            )
            .await;
        }
    }
}

async fn handle_update_repo_settings(
    req: &WSRequest,
    deps: &ServerDeps,
    tx: &mpsc::Sender<String>,
) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
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
            auto_pull_if_clean: false,
            hidden: false,
            pinned: false,
        });
        if let Some(v) = params.get("skipUntracked").and_then(|v| v.as_bool()) {
            settings.skip_untracked = v;
        }
        if let Some(v) = params.get("skipPullCheck").and_then(|v| v.as_bool()) {
            settings.skip_pull_check = v;
        }
        if let Some(v) = params.get("autoPullIfClean").and_then(|v| v.as_bool()) {
            settings.auto_pull_if_clean = v;
        }
        if let Some(v) = params.get("hidden").and_then(|v| v.as_bool()) {
            settings.hidden = v;
        }
        if let Some(v) = params.get("pinned").and_then(|v| v.as_bool()) {
            settings.pinned = v;
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
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "rootDir" parameter"#),
        )
        .await;
        return;
    }

    scanner::reset_cancel();
    deps.cache.add_scanned_dir(root_dir).await;

    let cfg = deps.cache.load_config().await;
    let excluded_dirs = cfg.excluded_dirs.clone();
    drop(cfg);

    let (progress_tx, mut progress_rx) = mpsc::channel(100);
    let git = deps.git.clone();
    let cache = deps.cache.clone();
    let root = root_dir.to_string();

    tokio::spawn(async move {
        scanner::scan_all(git, cache, root, excluded_dirs, progress_tx).await;
    });

    while let Some(p) = progress_rx.recv().await {
        let resp = WSResponse::progress(&req.id, serde_json::to_value(&p).unwrap());
        if tx
            .send(serde_json::to_string(&resp).unwrap())
            .await
            .is_err()
        {
            scanner::cancel_scan();
            return;
        }
    }
    send_response(tx, WSResponse::done(&req.id)).await;
}

async fn handle_scan_only(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let root_dir = params.get("rootDir").and_then(|v| v.as_str()).unwrap_or("");

    if root_dir.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "rootDir" parameter"#),
        )
        .await;
        return;
    }

    scanner::reset_cancel();
    deps.cache.add_scanned_dir(root_dir).await;

    let cfg = deps.cache.load_config().await;
    let excluded_dirs = cfg.excluded_dirs.clone();
    drop(cfg);

    let (progress_tx, mut progress_rx) = mpsc::channel(100);
    let git = deps.git.clone();
    let cache = deps.cache.clone();
    let root = root_dir.to_string();

    tokio::spawn(async move {
        scanner::scan_only(git, cache, root, excluded_dirs, progress_tx).await;
    });

    while let Some(p) = progress_rx.recv().await {
        let resp = WSResponse::progress(&req.id, serde_json::to_value(&p).unwrap());
        if tx
            .send(serde_json::to_string(&resp).unwrap())
            .await
            .is_err()
        {
            scanner::cancel_scan();
            return;
        }
    }
    send_response(tx, WSResponse::done(&req.id)).await;
}

async fn handle_commit_push(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");

    if repo.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" parameter"#),
        )
        .await;
        return;
    }

    if !cached_repo_exists(deps, repo).await {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the local workspace cache"),
        )
        .await;
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

    // Fetch only repositories from the local on-disk cache. Remote peer repositories
    // can be present in get_all_repos(), but their paths are not local to this server.
    let mut cached_repos = deps.cache.load().await;
    let local_repos: Vec<GitRepo> = cached_repos
        .iter()
        .filter(|r| {
            !(r.settings.as_ref().map_or(false, |s| s.hidden)
                || r.settings.as_ref().map_or(false, |s| s.skip_pull_check))
        })
        .cloned()
        .collect();

    let total = local_repos.len();
    if total == 0 {
        send_response(
            tx,
            WSResponse::progress(
                &req.id,
                json!(FetchProgress {
                    phase: "done".to_string(),
                    repo: None,
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
                repo: None,
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

    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
    let mut tasks = tokio::task::JoinSet::new();
    for repo in local_repos {
        let git = Arc::clone(&deps.git);
        let semaphore = Arc::clone(&semaphore);
        tasks.spawn(async move {
            let _permit = semaphore.acquire_owned().await.expect("semaphore is open");
            let _ = git
                .run_with_lock("fetch origin", &repo.path, Duration::from_secs(30))
                .await;

            let status = match git.get_status_with_lock(&repo.path).await {
                Ok(status) => status,
                Err(error) => return (repo, Some(error.to_string())),
            };
            let mut updated = repo_with_status(repo, status);
            let should_auto_pull = updated
                .settings
                .as_ref()
                .map_or(false, |settings| settings.auto_pull_if_clean)
                && updated.behind > 0
                && updated.ahead == 0
                && !updated.has_changes;

            if should_auto_pull
                && git
                    .run_with_lock("pull --ff-only", &updated.path, Duration::from_secs(30))
                    .await
                    .is_ok()
            {
                if let Ok(status) = git.get_status_with_lock(&updated.path).await {
                    updated = repo_with_status(updated, status);
                }
            }

            (updated, None)
        });
    }

    let mut completed = 0;
    let mut changed = false;
    let mut cancel_poll = tokio::time::interval(Duration::from_millis(50));
    while !tasks.is_empty() {
        tokio::select! {
            result = tasks.join_next() => {
                let Some(Ok((repo, error))) = result else { continue };
                completed += 1;
                if error.is_none() {
                    if let Some(cached) = cached_repos.iter_mut().find(|cached| cached.path == repo.path) {
                        *cached = repo.clone();
                        changed = true;
                    }
                }
                send_response(
                    tx,
                    WSResponse::progress(
                        &req.id,
                        json!(FetchProgress {
                            phase: "repo".to_string(),
                            repo: error.is_none().then_some(repo.clone()),
                            repo_path: Some(repo.path.clone()),
                            repo_name: Some(repo.name.clone()),
                            current: completed,
                            total,
                            ahead: error.is_none().then_some(repo.ahead),
                            behind: error.is_none().then_some(repo.behind),
                            branch: repo.branch.clone(),
                            error,
                        }),
                    ),
                )
                .await;
            }
            _ = cancel_poll.tick() => {
                if scanner::SCAN_CANCELED.load(std::sync::atomic::Ordering::SeqCst) {
                    tasks.abort_all();
                }
            }
        }
    }

    if changed {
        deps.cache.save(&cached_repos).await;
    }

    send_response(
        tx,
        WSResponse::progress(
            &req.id,
            json!(FetchProgress {
                phase: "done".to_string(),
                repo: None,
                repo_path: None,
                repo_name: None,
                current: completed,
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

fn repo_with_status(mut repo: GitRepo, status: GitStatusResult) -> GitRepo {
    repo.branch = Some(status.branch);
    repo.has_changes = status.has_changes;
    repo.staged = status.staged;
    repo.staged_files = status.staged_files;
    repo.unstaged = status.unstaged;
    repo.unstaged_files = status.unstaged_files;
    repo.untracked = status.untracked;
    repo.untracked_files = status.untracked_files;
    repo.ahead = status.ahead;
    repo.behind = status.behind;
    repo.remote = status.remote;
    repo.last_commit_time = Some(status.last_commit_time.map(|time| time * 1000).unwrap_or(0));
    repo.week_commits = status.week_commits;
    repo.last_scan_time = Some(now_millis());
    repo.error = None;
    repo
}

async fn handle_get_diff(req: &WSRequest, deps: &ServerDeps, tx: &mpsc::Sender<String>) {
    let params = &req.params;
    let repo = params.get("repo").and_then(|v| v.as_str()).unwrap_or("");
    let file = params.get("file").and_then(|v| v.as_str()).unwrap_or("");
    let status_type = params.get("status").and_then(|v| v.as_str()).unwrap_or("");
    let max_bytes = params
        .get("maxBytes")
        .and_then(|value| value.as_u64())
        .unwrap_or(256 * 1024)
        .clamp(1_024, 1024 * 1024) as usize;

    if repo.is_empty() || file.is_empty() {
        send_response(
            tx,
            WSResponse::error(&req.id, r#"Missing "repo" or "file" parameter"#),
        )
        .await;
        return;
    }

    let cached_repo = cached_repos(deps)
        .await
        .into_iter()
        .find(|cached| cached.path == repo);
    if cached_repo.is_none() {
        send_response(
            tx,
            WSResponse::error(&req.id, "Repository not found in the local workspace cache"),
        )
        .await;
        return;
    }
    let relative_file = match normalized_relative_path(file) {
        Some(path) => path,
        None => {
            send_response(
                tx,
                WSResponse::error(
                    &req.id,
                    "File must be a normalized relative path inside the repository",
                ),
            )
            .await;
            return;
        }
    };

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
            let repo_root = match tokio::fs::canonicalize(repo).await {
                Ok(path) => path,
                Err(error) => {
                    send_response(
                        tx,
                        WSResponse::error(
                            &req.id,
                            &format!("Cannot resolve repository path: {error}"),
                        ),
                    )
                    .await;
                    return;
                }
            };
            let path = repo_root.join(&relative_file);
            let resolved = match tokio::fs::canonicalize(&path).await {
                Ok(path) if path.starts_with(&repo_root) => path,
                Ok(_) => {
                    send_response(
                        tx,
                        WSResponse::error(&req.id, "File resolves outside the repository"),
                    )
                    .await;
                    return;
                }
                Err(error) => {
                    send_response(
                        tx,
                        WSResponse::error(
                            &req.id,
                            &format!("Cannot resolve untracked file: {error}"),
                        ),
                    )
                    .await;
                    return;
                }
            };
            match tokio::fs::read_to_string(&resolved).await {
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
            let total_bytes = diff.len();
            let truncated = total_bytes > max_bytes;
            let diff = truncate_utf8(diff, max_bytes);
            println!(
                "[diff] response repo={:?} file={:?} status={:?} bytes={}",
                repo,
                file,
                status_type,
                diff.len()
            );
            send_response(
                tx,
                WSResponse::result(
                    &req.id,
                    json!({
                        "file": file,
                        "diff": diff,
                        "truncated": truncated,
                        "returnedBytes": diff.len(),
                        "totalBytes": total_bytes,
                    }),
                ),
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

fn normalized_relative_path(path: &str) -> Option<PathBuf> {
    let path = Path::new(path);
    if path.as_os_str().is_empty() || path.is_absolute() {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => normalized.push(part),
            _ => return None,
        }
    }
    (!normalized.as_os_str().is_empty()).then_some(normalized)
}

fn truncate_utf8(mut value: String, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value;
    }
    let mut boundary = max_bytes;
    while !value.is_char_boundary(boundary) {
        boundary -= 1;
    }
    value.truncate(boundary);
    value
}

#[cfg(test)]
mod tests {
    use super::{normalized_relative_path, truncate_utf8};
    use std::path::PathBuf;

    #[test]
    fn accepts_only_normalized_relative_paths() {
        assert_eq!(
            normalized_relative_path("src/main.rs"),
            Some(PathBuf::from("src/main.rs"))
        );
        assert!(normalized_relative_path("").is_none());
        assert!(normalized_relative_path("/etc/passwd").is_none());
        assert!(normalized_relative_path("../secret").is_none());
        assert!(normalized_relative_path("src/../secret").is_none());
        assert!(normalized_relative_path("./src/main.rs").is_none());
    }

    #[test]
    fn truncates_at_a_utf8_boundary() {
        assert_eq!(truncate_utf8("abc".to_string(), 3), "abc");
        assert_eq!(truncate_utf8("aéz".to_string(), 2), "a");
        assert_eq!(truncate_utf8("aéz".to_string(), 3), "aé");
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

    Some(updated)
}
