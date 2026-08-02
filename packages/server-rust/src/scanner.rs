use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

use ignore::WalkBuilder;

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

fn find_git_repos(root_dir: &str, excluded_dirs: &[String]) -> Vec<String> {
    let mut repos = Vec::new();
    let root = Path::new(root_dir);
    if !root.exists() {
        return repos;
    }
    let excludes: Vec<String> = excluded_dirs
        .iter()
        .filter_map(|s| {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            Some(normalize_path(Path::new(t)))
        })
        .collect();

    let filter_excludes = excludes.clone();
    let mut builder = WalkBuilder::new(root);
    builder
        // Match the scanner's existing treatment of dot-directories and symlinks.
        .hidden(true)
        .follow_links(true)
        // Use Git's ignore semantics without also introducing ripgrep-style `.ignore` files.
        .ignore(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(true)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            if SCAN_CANCELED.load(Ordering::SeqCst) {
                return false;
            }
            if entry.file_name().to_string_lossy() == "node_modules" {
                return false;
            }
            !filter_excludes
                .iter()
                .any(|excluded| is_under(entry.path(), excluded))
        });

    for entry in builder.build().filter_map(Result::ok) {
        if SCAN_CANCELED.load(Ordering::SeqCst) {
            break;
        }
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_dir())
        {
            continue;
        }

        let git_marker = entry.path().join(".git");
        // Worktrees and some submodules use a `.git` file instead of a directory.
        if git_marker.is_dir() || git_marker.is_file() {
            repos.push(entry.path().to_string_lossy().to_string());
        }
    }
    repos
}

async fn discover_git_repos(root_dir: String, excluded_dirs: Vec<String>) -> Vec<String> {
    tokio::task::spawn_blocking(move || find_git_repos(&root_dir, &excluded_dirs))
        .await
        .unwrap_or_default()
}

/// Normalize a path for comparison: strip the Windows verbatim (`\\?\`)
/// prefix, use `/` separators, drop trailing slashes. On Windows paths are
/// case-insensitive, so we lowercase there. This lets an exclude like
/// `C:\Projects\Archive` match a walked `c:\projects\archive` or
/// `\\?\C:\projects\archive`.
fn normalize_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let s = s.replace('\\', "/");
    let s = s.trim_end_matches('/');
    #[cfg(windows)]
    let s = s.to_lowercase();
    s.to_string()
}

/// True if `path` is `prefix` itself or a descendant of it, using the
/// normalized form so Windows casing / verbatim prefixes don't cause
/// false negatives. The trailing-slash check keeps it component-aware
/// (so `/a/proj` does not match `/a/projects`).
fn is_under(path: &Path, prefix_norm: &str) -> bool {
    let np = normalize_path(path);
    np == prefix_norm || np.starts_with(&format!("{}/", prefix_norm))
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

fn can_auto_pull(repo: &GitRepo) -> bool {
    repo.settings
        .as_ref()
        .map_or(false, |s| s.auto_pull_if_clean)
        && repo.behind > 0
        && repo.ahead == 0
        && !repo.has_changes
        && repo.staged == 0
        && repo.unstaged == 0
        && repo.untracked == 0
}

pub async fn scan_all(
    git: Arc<GitService>,
    cache: Arc<CacheService>,
    root_dir: String,
    excluded_dirs: Vec<String>,
    machine: String,
    progress_tx: mpsc::Sender<ScanProgress>,
) {
    log_rss("scan_all start");
    release_memory();
    let _ = progress_tx
        .send(ScanProgress {
            phase: "discovering".to_string(),
            total: 0,
            current: 0,
            repo: None,
        })
        .await;

    let repo_paths = discover_git_repos(root_dir, excluded_dirs).await;
    let total = repo_paths.len();

    if SCAN_CANCELED.load(Ordering::SeqCst) {
        git.cleanup_locks().await;
        release_memory();
        let _ = progress_tx
            .send(ScanProgress {
                phase: "done".to_string(),
                total: 0,
                current: 0,
                repo: None,
            })
            .await;
        return;
    }

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
    let mut tasks = tokio::task::JoinSet::new();
    let mut results: Vec<Option<GitRepo>> = vec![None; total];
    let mut fetchable_indices = Vec::new();

    for (i, path) in repo_paths.iter().enumerate() {
        let git = git.clone();
        let path = path.clone();
        let machine = machine.clone();
        let sem = sem.clone();
        let settings_map = Arc::clone(&settings_map);

        tasks.spawn(async move {
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
        });
    }

    let mut completed = 0;
    let mut cancel_poll = tokio::time::interval(Duration::from_millis(50));
    while !tasks.is_empty() {
        tokio::select! {
            result = tasks.join_next() => {
                if let Some(Ok((i, repo))) = result {
                    completed += 1;
                    if !SCAN_CANCELED.load(Ordering::SeqCst) {
                        let _ = progress_tx
                            .send(ScanProgress {
                                phase: "scanning".to_string(),
                                total,
                                current: completed,
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
            _ = cancel_poll.tick() => {
                if SCAN_CANCELED.load(Ordering::SeqCst) {
                    tasks.abort_all();
                }
            }
        }
    }

    if SCAN_CANCELED.load(Ordering::SeqCst) {
        git.cleanup_locks().await;
        release_memory();
        let _ = progress_tx
            .send(ScanProgress {
                phase: "done".to_string(),
                total: 0,
                current: 0,
                repo: None,
            })
            .await;
        return;
    }

    let scanned_results: Vec<GitRepo> = results.into_iter().flatten().collect();
    log_rss("scan_all after scan phase");

    if !SCAN_CANCELED.load(Ordering::SeqCst) {
        cache.save(&scanned_results).await;
    }

    if SCAN_CANCELED.load(Ordering::SeqCst) {
        git.cleanup_locks().await;
        release_memory();
        let _ = progress_tx
            .send(ScanProgress {
                phase: "done".to_string(),
                total: 0,
                current: 0,
                repo: None,
            })
            .await;
        return;
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

            let mut updated = if let Some(status) = status {
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

            if can_auto_pull(&updated)
                && git
                    .run_with_lock("pull --ff-only", &updated.path, Duration::from_secs(30))
                    .await
                    .is_ok()
            {
                if let Ok(status) = git.get_status_with_lock(&updated.path).await {
                    let commit_time_ms = status.last_commit_time.map(|t| t * 1000).unwrap_or(0);
                    updated = GitRepo {
                        name: updated.name,
                        path: updated.path,
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
                        machine: updated.machine,
                        error: None,
                        settings: updated.settings,
                    };
                }
            }

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
    excluded_dirs: Vec<String>,
    machine: String,
    progress_tx: mpsc::Sender<ScanProgress>,
) {
    log_rss("scan_only start");
    release_memory();
    let _ = progress_tx
        .send(ScanProgress {
            phase: "discovering".to_string(),
            total: 0,
            current: 0,
            repo: None,
        })
        .await;

    let repo_paths = discover_git_repos(root_dir, excluded_dirs).await;
    let total = repo_paths.len();

    if SCAN_CANCELED.load(Ordering::SeqCst) {
        git.cleanup_locks().await;
        release_memory();
        let _ = progress_tx
            .send(ScanProgress {
                phase: "done".to_string(),
                total: 0,
                current: 0,
                repo: None,
            })
            .await;
        return;
    }

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
    let mut tasks = tokio::task::JoinSet::new();
    let mut results: Vec<Option<GitRepo>> = vec![None; total];

    for (i, path) in repo_paths.iter().enumerate() {
        let git = git.clone();
        let path = path.clone();
        let machine = machine.clone();
        let sem = sem.clone();
        let settings_map = Arc::clone(&settings_map);

        tasks.spawn(async move {
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
        });
    }

    let mut completed = 0;
    let mut cancel_poll = tokio::time::interval(Duration::from_millis(50));
    while !tasks.is_empty() {
        tokio::select! {
            result = tasks.join_next() => {
                if let Some(Ok((i, repo))) = result {
                    completed += 1;
                    if !SCAN_CANCELED.load(Ordering::SeqCst) {
                        let _ = progress_tx
                            .send(ScanProgress {
                                phase: "scanning".to_string(),
                                total,
                                current: completed,
                                repo: Some(repo.clone()),
                            })
                            .await;
                    }
                    results[i] = Some(repo);
                }
            }
            _ = cancel_poll.tick() => {
                if SCAN_CANCELED.load(Ordering::SeqCst) {
                    tasks.abort_all();
                }
            }
        }
    }

    if SCAN_CANCELED.load(Ordering::SeqCst) {
        git.cleanup_locks().await;
        release_memory();
        let _ = progress_tx
            .send(ScanProgress {
                phase: "done".to_string(),
                total: 0,
                current: 0,
                repo: None,
            })
            .await;
        return;
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

#[cfg(test)]
mod tests {
    use super::{find_git_repos, normalize_path, reset_cancel};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            let unique = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "git-glance-scanner-{}-{unique}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn create_repo(path: &Path) {
        fs::create_dir_all(path.join(".git")).unwrap();
    }

    #[test]
    fn skips_gitignored_nested_repositories() {
        reset_cancel();
        let root = TestDir::new();
        let parent = root.path().join("parent");
        create_repo(&parent);
        fs::write(parent.join(".gitignore"), "ignored/\n").unwrap();
        create_repo(&parent.join("ignored/nested"));
        create_repo(&parent.join("visible/nested"));

        let found: Vec<String> = find_git_repos(&root.path().to_string_lossy(), &[])
            .iter()
            .map(|path| normalize_path(Path::new(path)))
            .collect();

        assert!(found.contains(&normalize_path(&parent)));
        assert!(found.contains(&normalize_path(&parent.join("visible/nested"))));
        assert!(!found.contains(&normalize_path(&parent.join("ignored/nested"))));
    }

    #[test]
    fn recognizes_git_files_and_explicit_exclusions() {
        reset_cancel();
        let root = TestDir::new();
        let worktree = root.path().join("worktree");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            "gitdir: ../main/.git/worktrees/test\n",
        )
        .unwrap();
        let excluded = root.path().join("excluded");
        create_repo(&excluded);

        let found: Vec<String> = find_git_repos(
            &root.path().to_string_lossy(),
            &[excluded.to_string_lossy().to_string()],
        )
        .iter()
        .map(|path| normalize_path(Path::new(path)))
        .collect();

        assert!(found.contains(&normalize_path(&worktree)));
        assert!(!found.contains(&normalize_path(&excluded)));
    }
}
