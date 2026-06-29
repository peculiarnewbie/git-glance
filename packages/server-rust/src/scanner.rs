use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

#[cfg(target_os = "linux")]
extern "C" {
    fn malloc_trim(_pad: usize) -> i32;
}

pub fn release_memory() {
    #[cfg(target_os = "linux")]
    unsafe {
        malloc_trim(0);
    }
}

pub fn log_rss(label: &str) {
    if let Ok(data) = std::fs::read("/proc/self/status") {
        let s = String::from_utf8_lossy(&data);
        for line in s.lines() {
            if line.starts_with("VmRSS:") {
                eprintln!("[mem] {} {}", label, line.trim());
                break;
            }
        }
    }
}

use crate::cache::CacheService;
use crate::git::GitService;
use crate::types::{GitRepo, GitRepoSettings, ScanProgress};

pub static SCAN_CANCELED: AtomicBool = AtomicBool::new(false);

pub fn cancel_scan() {
    SCAN_CANCELED.store(true, Ordering::SeqCst);
}

pub fn reset_cancel() {
    SCAN_CANCELED.store(false, Ordering::SeqCst);
}

fn find_git_repos(root_dir: &str) -> Vec<String> {
    let mut repos = Vec::new();
    let root = Path::new(root_dir);
    if !root.exists() {
        return repos;
    }
    walk_dir(root, &mut repos);
    repos
}

fn walk_dir(dir: &Path, repos: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if !path.is_dir() {
            continue;
        }

        if name == ".git" {
            if let Some(parent) = path.parent() {
                repos.push(parent.to_string_lossy().to_string());
            }
            continue;
        }

        // Skip dotfiles (except .git which is handled above)
        if name.starts_with('.') {
            continue;
        }

        // Skip node_modules
        if name == "node_modules" {
            continue;
        }

        walk_dir(&path, repos);
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

async fn scan_one_repo(git: &GitService, repo_path: &str, machine: &str) -> GitRepo {
    let name = Path::new(repo_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    match git.get_status_with_lock(repo_path).await {
        Ok(status) => {
            let commit_time_ms = status.last_commit_time.map(|t| t * 1000).unwrap_or(0);
            GitRepo {
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
                machine: machine.to_string(),
                error: None,
                settings: None,
            }
        }
        Err(e) => GitRepo {
            name,
            path: repo_path.to_string(),
            branch: None,
            has_changes: false,
            staged: 0,
            staged_files: Vec::new(),
            unstaged: 0,
            unstaged_files: Vec::new(),
            untracked: 0,
            untracked_files: Vec::new(),
            ahead: 0,
            behind: 0,
            remote: None,
            last_commit_time: None,
            week_commits: 0,
            last_scan_time: None,
            machine: machine.to_string(),
            error: Some(e.to_string()),
            settings: None,
        },
    }
}

fn merge_settings(repo: &mut GitRepo, settings_map: &HashMap<String, GitRepoSettings>) {
    if let Some(s) = settings_map.get(&repo.path) {
        repo.settings = Some(s.clone());
    }
}

pub async fn scan_all(
    git: Arc<GitService>,
    cache: Arc<CacheService>,
    root_dir: String,
    machine: String,
    progress_tx: mpsc::Sender<ScanProgress>,
) {
    log_rss("scan_all start");
    release_memory();
    let repo_paths = find_git_repos(&root_dir);
    let total = repo_paths.len();

    let _ = progress_tx
        .send(ScanProgress {
            phase: "discovering".to_string(),
            total,
            current: 0,
            repo: None,
        })
        .await;

    // Build a lightweight path→settings map from cache
    // instead of cloning the full repo list into every concurrent task
    let existing = cache.load().await;
    let settings_map: Arc<HashMap<String, GitRepoSettings>> = Arc::new(
        existing
            .iter()
            .filter_map(|r| r.settings.as_ref().map(|s| (r.path.clone(), s.clone())))
            .collect(),
    );
    drop(existing);

    // Scan concurrently (8 at a time)
    let sem = Arc::new(tokio::sync::Semaphore::new(8));
    let mut handles = Vec::new();
    let mut results: Vec<Option<GitRepo>> = vec![None; total];
    let mut fetchable_indices = Vec::new();

    for (i, path) in repo_paths.iter().enumerate() {
        let git = git.clone();
        let path = path.clone();
        let machine = machine.clone();
        let sem = sem.clone();
        let settings_map = Arc::clone(&settings_map);

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            let mut repo = tokio::time::timeout(
                Duration::from_secs(30),
                scan_one_repo(&git, &path, &machine),
            )
            .await
            .unwrap_or_else(|_| GitRepo {
                name: Path::new(&path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: path.clone(),
                branch: None,
                has_changes: false,
                staged: 0,
                staged_files: Vec::new(),
                unstaged: 0,
                unstaged_files: Vec::new(),
                untracked: 0,
                untracked_files: Vec::new(),
                ahead: 0,
                behind: 0,
                remote: None,
                last_commit_time: None,
                week_commits: 0,
                last_scan_time: None,
                machine: machine.clone(),
                error: Some("scan timed out".to_string()),
                settings: None,
            });
            merge_settings(&mut repo, &settings_map);
            (i, repo)
        }));
    }

    for handle in handles {
        if let Ok((i, repo)) = handle.await {
            if !SCAN_CANCELED.load(Ordering::SeqCst) {
                let _ = progress_tx
                    .send(ScanProgress {
                        phase: "scanning".to_string(),
                        total,
                        current: i + 1,
                        repo: Some(repo.clone()),
                    })
                    .await;
            }
            if repo.settings.is_none()
                || (!repo.settings.as_ref().unwrap().skip_pull_check
                    && !repo.settings.as_ref().unwrap().hidden)
            {
                fetchable_indices.push(i);
            }
            results[i] = Some(repo);
        }
    }

    let scanned_results: Vec<GitRepo> = results.into_iter().flatten().collect();
    log_rss("scan_all after scan phase");

    if !SCAN_CANCELED.load(Ordering::SeqCst) {
        cache.save(&scanned_results).await;
    }

    // Fetch concurrently (4 at a time)
    let fetch_total = fetchable_indices.len();
    let fetch_sem = Arc::new(tokio::sync::Semaphore::new(4));
    let mut fetch_handles = Vec::new();
    let mut fetch_results: Vec<(usize, GitRepo)> = Vec::new();

    for &idx in fetchable_indices.iter() {
        let git = git.clone();
        let repo = scanned_results[idx].clone();
        let fetch_sem = fetch_sem.clone();
        let progress_tx = progress_tx.clone();

        fetch_handles.push(tokio::spawn(async move {
            let _permit = fetch_sem.acquire().await.unwrap();

            let _ = progress_tx
                .send(ScanProgress {
                    phase: "fetching".to_string(),
                    total: fetch_total,
                    current: 0,
                    repo: Some(repo.clone()),
                })
                .await;

            let _ = git
                .run_with_lock("fetch origin", &repo.path, Duration::from_secs(30))
                .await;

            let status = git.get_status_with_lock(&repo.path).await.ok();

            let updated = if let Some(status) = status {
                let commit_time_ms = status.last_commit_time.map(|t| t * 1000).unwrap_or(0);
                GitRepo {
                    name: repo.name.clone(),
                    path: repo.path.clone(),
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
                    machine: repo.machine,
                    error: None,
                    settings: repo.settings,
                }
            } else {
                repo
            };

            (idx, updated)
        }));
    }

    for handle in fetch_handles {
        if let Ok((idx, updated)) = handle.await {
            fetch_results.push((idx, updated));
        }
    }

    let mut final_results = scanned_results;
    for (idx, updated) in fetch_results {
        final_results[idx] = updated;
    }
    log_rss("scan_all after fetch phase");

    if !SCAN_CANCELED.load(Ordering::SeqCst) {
        cache.save(&final_results).await;
    }

    for (i, repo) in final_results.iter().enumerate() {
        let _ = progress_tx
            .send(ScanProgress {
                phase: "fetching".to_string(),
                total: final_results.len(),
                current: i + 1,
                repo: Some(repo.clone()),
            })
            .await;
    }

    git.cleanup_locks().await;
    release_memory();
    log_rss("scan_all end");

    let _ = progress_tx
        .send(ScanProgress {
            phase: "done".to_string(),
            total: final_results.len(),
            current: final_results.len(),
            repo: None,
        })
        .await;
}

pub async fn scan_only(
    git: Arc<GitService>,
    cache: Arc<CacheService>,
    root_dir: String,
    machine: String,
    progress_tx: mpsc::Sender<ScanProgress>,
) {
    log_rss("scan_only start");
    release_memory();
    let repo_paths = find_git_repos(&root_dir);
    let total = repo_paths.len();

    let _ = progress_tx
        .send(ScanProgress {
            phase: "discovering".to_string(),
            total,
            current: 0,
            repo: None,
        })
        .await;

    let existing = cache.load().await;
    let settings_map: Arc<HashMap<String, GitRepoSettings>> = Arc::new(
        existing
            .iter()
            .filter_map(|r| r.settings.as_ref().map(|s| (r.path.clone(), s.clone())))
            .collect(),
    );
    drop(existing);

    let sem = Arc::new(tokio::sync::Semaphore::new(8));
    let mut handles = Vec::new();
    let mut results: Vec<Option<GitRepo>> = vec![None; total];

    for (i, path) in repo_paths.iter().enumerate() {
        let git = git.clone();
        let path = path.clone();
        let machine = machine.clone();
        let sem = sem.clone();
        let settings_map = Arc::clone(&settings_map);

        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.unwrap();
            let mut repo = tokio::time::timeout(
                Duration::from_secs(30),
                scan_one_repo(&git, &path, &machine),
            )
            .await
            .unwrap_or_else(|_| GitRepo {
                name: Path::new(&path)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: path.clone(),
                branch: None,
                has_changes: false,
                staged: 0,
                staged_files: Vec::new(),
                unstaged: 0,
                unstaged_files: Vec::new(),
                untracked: 0,
                untracked_files: Vec::new(),
                ahead: 0,
                behind: 0,
                remote: None,
                last_commit_time: None,
                week_commits: 0,
                last_scan_time: None,
                machine: machine.clone(),
                error: Some("scan timed out".to_string()),
                settings: None,
            });
            merge_settings(&mut repo, &settings_map);
            (i, repo)
        }));
    }

    for handle in handles {
        if let Ok((i, repo)) = handle.await {
            if !SCAN_CANCELED.load(Ordering::SeqCst) {
                let _ = progress_tx
                    .send(ScanProgress {
                        phase: "scanning".to_string(),
                        total,
                        current: i + 1,
                        repo: Some(repo.clone()),
                    })
                    .await;
            }
            results[i] = Some(repo);
        }
    }

    let scanned_results: Vec<GitRepo> = results.into_iter().flatten().collect();
    log_rss("scan_only after scan phase");

    if !SCAN_CANCELED.load(Ordering::SeqCst) {
        cache.save(&scanned_results).await;
    }

    git.cleanup_locks().await;
    release_memory();
    log_rss("scan_only end");

    let _ = progress_tx
        .send(ScanProgress {
            phase: "done".to_string(),
            total: scanned_results.len(),
            current: scanned_results.len(),
            repo: None,
        })
        .await;
}
