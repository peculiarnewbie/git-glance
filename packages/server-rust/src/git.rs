use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::types::{FileStatus, GitStatusResult};

#[derive(Debug)]
pub struct GitCommandError {
    pub command: String,
    pub repo_path: String,
    pub cause: String,
}

impl std::fmt::Display for GitCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "git {} in {}: {}",
            self.command, self.repo_path, self.cause
        )
    }
}

impl std::error::Error for GitCommandError {}

pub struct GitService {
    locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
}

impl GitService {
    pub fn new() -> Self {
        Self {
            locks: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn get_lock(&self, repo_path: &str) -> Arc<Mutex<()>> {
        let mut locks = self.locks.lock().await;
        let lock = locks
            .entry(repo_path.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone();
        if locks.len() > 5000 {
            locks.retain(|_, v| Arc::strong_count(v) > 1);
        }
        lock
    }

    pub async fn cleanup_locks(&self) {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, v| Arc::strong_count(v) > 1);
    }

    pub async fn exec_git(
        &self,
        args: &str,
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        let timeout = if timeout.is_zero() {
            Duration::from_secs(10)
        } else {
            timeout
        };

        let parts: Vec<&str> = args.split_whitespace().collect();
        let output = tokio::time::timeout(
            timeout,
            Command::new("git")
                .args(&parts)
                .current_dir(repo_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output(),
        )
        .await
        .map_err(|_| GitCommandError {
            command: format!("git {}", args),
            repo_path: repo_path.to_string(),
            cause: "command timed out".to_string(),
        })?
        .map_err(|e| GitCommandError {
            command: format!("git {}", args),
            repo_path: repo_path.to_string(),
            cause: e.to_string(),
        })?;

        let mut combined = String::new();
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        combined.push_str(&String::from_utf8_lossy(&output.stderr));

        if !output.status.success() {
            return Err(GitCommandError {
                command: format!("git {}", args),
                repo_path: repo_path.to_string(),
                cause: combined.trim().to_string(),
            });
        }

        Ok(combined.trim().to_string())
    }

    pub async fn exec_git_raw(
        &self,
        args: &str,
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        let timeout = if timeout.is_zero() {
            Duration::from_secs(10)
        } else {
            timeout
        };

        let parts: Vec<&str> = args.split_whitespace().collect();
        let output = tokio::time::timeout(
            timeout,
            Command::new("git")
                .args(&parts)
                .current_dir(repo_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output(),
        )
        .await
        .map_err(|_| GitCommandError {
            command: format!("git {}", args),
            repo_path: repo_path.to_string(),
            cause: "command timed out".to_string(),
        })?
        .map_err(|e| GitCommandError {
            command: format!("git {}", args),
            repo_path: repo_path.to_string(),
            cause: e.to_string(),
        })?;

        let mut combined = String::new();
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        combined.push_str(&String::from_utf8_lossy(&output.stderr));

        if !output.status.success() {
            return Err(GitCommandError {
                command: format!("git {}", args),
                repo_path: repo_path.to_string(),
                cause: combined.trim().to_string(),
            });
        }

        Ok(combined.trim_end_matches(['\r', '\n']).to_string())
    }

    pub async fn safe_exec(
        &self,
        args: &str,
        repo_path: &str,
        timeout: Duration,
    ) -> Option<String> {
        self.exec_git(args, repo_path, timeout).await.ok()
    }

    pub async fn run(
        &self,
        args: &str,
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        self.exec_git(args, repo_path, timeout).await
    }

    pub async fn run_with_lock(
        &self,
        args: &str,
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        let lock = self.get_lock(repo_path).await;
        let _guard = lock.lock().await;
        self.exec_git(args, repo_path, timeout).await
    }

    pub async fn run_args_with_lock(
        &self,
        args: &[&str],
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        let lock = self.get_lock(repo_path).await;
        let _guard = lock.lock().await;

        let timeout = if timeout.is_zero() {
            Duration::from_secs(10)
        } else {
            timeout
        };

        let output = tokio::time::timeout(
            timeout,
            Command::new("git")
                .args(args)
                .current_dir(repo_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .output(),
        )
        .await
        .map_err(|_| GitCommandError {
            command: format!("git {}", args.join(" ")),
            repo_path: repo_path.to_string(),
            cause: "command timed out".to_string(),
        })?
        .map_err(|e| GitCommandError {
            command: format!("git {}", args.join(" ")),
            repo_path: repo_path.to_string(),
            cause: e.to_string(),
        })?;

        let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(GitCommandError {
                command: format!("git {}", args.join(" ")),
                repo_path: repo_path.to_string(),
                cause: if stderr.is_empty() { trimmed } else { stderr },
            });
        }

        Ok(trimmed)
    }

    pub async fn run_with_stdin_and_lock(
        &self,
        args: &[&str],
        stdin_data: &str,
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        let lock = self.get_lock(repo_path).await;
        let _guard = lock.lock().await;

        let timeout = if timeout.is_zero() {
            Duration::from_secs(10)
        } else {
            timeout
        };

        use std::process::Stdio;

        let mut child = Command::new("git")
            .args(args)
            .current_dir(repo_path)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| GitCommandError {
                command: format!("git {}", args.join(" ")),
                repo_path: repo_path.to_string(),
                cause: e.to_string(),
            })?;

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(stdin_data.as_bytes()).await;
            drop(stdin);
        }

        let result = tokio::time::timeout(timeout, child.wait_with_output()).await;

        match result {
            Ok(Ok(output)) => {
                let trimmed = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !output.status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                    return Err(GitCommandError {
                        command: format!("git {}", args.join(" ")),
                        repo_path: repo_path.to_string(),
                        cause: if stderr.is_empty() { trimmed } else { stderr },
                    });
                }
                Ok(trimmed)
            }
            Ok(Err(e)) => Err(GitCommandError {
                command: format!("git {}", args.join(" ")),
                repo_path: repo_path.to_string(),
                cause: e.to_string(),
            }),
            Err(_) => Err(GitCommandError {
                command: format!("git {}", args.join(" ")),
                repo_path: repo_path.to_string(),
                cause: "command timed out".to_string(),
            }),
        }
    }

    pub async fn get_status(&self, repo_path: &str) -> Result<GitStatusResult, GitCommandError> {
        let raw_status = self
            .exec_git_raw(
                "status --porcelain --untracked-files=all",
                repo_path,
                Duration::from_secs(10),
            )
            .await?;
        let branch = self
            .exec_git(
                "rev-parse --abbrev-ref HEAD",
                repo_path,
                Duration::from_secs(5),
            )
            .await?;
        let remote_option = self
            .safe_exec(
                "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
                repo_path,
                Duration::from_secs(5),
            )
            .await;

        let mut ahead = 0i64;
        let mut behind = 0i64;
        if remote_option.is_some() {
            if let Some(rev_list) = self
                .safe_exec(
                    "rev-list --left-right --count HEAD...@{upstream}",
                    repo_path,
                    Duration::from_secs(10),
                )
                .await
            {
                let parts: Vec<&str> = rev_list.split_whitespace().collect();
                if parts.len() >= 2 {
                    ahead = parts[0].parse().unwrap_or(0);
                    behind = parts[1].parse().unwrap_or(0);
                }
            }
        }

        let mut staged = 0i64;
        let mut unstaged = 0i64;
        let mut untracked = 0i64;
        let mut staged_files = Vec::new();
        let mut unstaged_files = Vec::new();
        let mut untracked_files = Vec::new();

        for line in raw_status.lines() {
            if line.is_empty() {
                continue;
            }
            let file_path = parse_porcelain_path(line);
            if line.starts_with("??") {
                untracked += 1;
                if !file_path.is_empty() {
                    untracked_files.push(FileStatus {
                        path: file_path,
                        status: "??".to_string(),
                    });
                }
            } else {
                let bytes = line.as_bytes();
                if !bytes.is_empty() && bytes[0] != b' ' {
                    staged += 1;
                    if !file_path.is_empty() {
                        staged_files.push(FileStatus {
                            path: file_path.clone(),
                            status: format!("{} ", bytes[0] as char),
                        });
                    }
                }
                if bytes.len() > 1 && bytes[1] != b' ' {
                    unstaged += 1;
                    if !file_path.is_empty() {
                        unstaged_files.push(FileStatus {
                            path: file_path,
                            status: format!(" {}", bytes[1] as char),
                        });
                    }
                }
            }
        }

        let has_changes = staged > 0 || unstaged > 0 || untracked > 0;

        let last_commit_time = self
            .safe_exec("log -1 --format=%ct", repo_path, Duration::from_secs(5))
            .await
            .and_then(|s| s.parse::<i64>().ok());

        let mut week_commits = 0i64;
        if let Some(lct) = last_commit_time {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            if now - lct < 7 * 24 * 3600 {
                if let Some(raw) = self
                    .safe_exec(
                        r#"rev-list --count --since="1 week ago" HEAD"#,
                        repo_path,
                        Duration::from_secs(10),
                    )
                    .await
                {
                    week_commits = raw.parse().unwrap_or(0);
                }
            }
        }

        Ok(GitStatusResult {
            branch,
            remote: remote_option,
            has_changes,
            staged,
            staged_files,
            unstaged,
            unstaged_files,
            untracked,
            untracked_files,
            ahead,
            behind,
            last_commit_time,
            week_commits,
        })
    }

    pub async fn get_status_with_lock(
        &self,
        repo_path: &str,
    ) -> Result<GitStatusResult, GitCommandError> {
        let lock = self.get_lock(repo_path).await;
        let _guard = lock.lock().await;
        self.get_status(repo_path).await
    }
}

fn parse_porcelain_path(line: &str) -> String {
    let bytes = line.as_bytes();
    if bytes.len() <= 2 {
        return String::new();
    }
    let start = if bytes.len() > 2 && bytes[2] == b' ' {
        3
    } else {
        2
    };
    let path = line[start..].trim();
    if let Some(idx) = path.rfind(" -> ") {
        path[idx + 4..].to_string()
    } else {
        path.to_string()
    }
}
