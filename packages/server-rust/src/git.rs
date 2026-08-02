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
                .kill_on_drop(true)
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

    async fn exec_git_args_raw(
        &self,
        args: &[&str],
        repo_path: &str,
        timeout: Duration,
    ) -> Result<String, GitCommandError> {
        let timeout = if timeout.is_zero() {
            Duration::from_secs(10)
        } else {
            timeout
        };
        let command = args.join(" ");
        let output = tokio::time::timeout(
            timeout,
            Command::new("git")
                .args(args)
                .current_dir(repo_path)
                .env("GIT_TERMINAL_PROMPT", "0")
                .kill_on_drop(true)
                .output(),
        )
        .await
        .map_err(|_| GitCommandError {
            command: format!("git {command}"),
            repo_path: repo_path.to_string(),
            cause: "command timed out".to_string(),
        })?
        .map_err(|e| GitCommandError {
            command: format!("git {command}"),
            repo_path: repo_path.to_string(),
            cause: e.to_string(),
        })?;

        let mut combined = String::new();
        combined.push_str(&String::from_utf8_lossy(&output.stdout));
        combined.push_str(&String::from_utf8_lossy(&output.stderr));
        if !output.status.success() {
            return Err(GitCommandError {
                command: format!("git {command}"),
                repo_path: repo_path.to_string(),
                cause: combined.trim().to_string(),
            });
        }

        Ok(combined.trim_end_matches(['\r', '\n']).to_string())
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
                .kill_on_drop(true)
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
            .kill_on_drop(true)
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
        // These read-only commands are independent, so run them together. Porcelain v2
        // includes branch, upstream, ahead/behind, and file state in one stable format.
        let status = self.exec_git_args_raw(
            &[
                "status",
                "--porcelain=v2",
                "--branch",
                "--untracked-files=all",
            ],
            repo_path,
            Duration::from_secs(10),
        );
        let last_commit = self.exec_git_args_raw(
            &["log", "-1", "--format=%ct"],
            repo_path,
            Duration::from_secs(5),
        );
        let (raw_status, last_commit_time) = tokio::join!(status, last_commit);
        let parsed = parse_porcelain_v2(&raw_status?);
        let last_commit_time = last_commit_time
            .ok()
            .and_then(|value| value.parse::<i64>().ok());

        let mut week_commits = 0i64;
        if let Some(lct) = last_commit_time {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs() as i64;
            if now - lct < 7 * 24 * 3600 {
                if let Some(raw) = self
                    .exec_git_args_raw(
                        &["rev-list", "--count", "--since=1 week ago", "HEAD"],
                        repo_path,
                        Duration::from_secs(10),
                    )
                    .await
                    .ok()
                {
                    week_commits = raw.parse().unwrap_or(0);
                }
            }
        }

        Ok(GitStatusResult {
            branch: parsed.branch,
            remote: parsed.remote,
            has_changes: parsed.staged > 0 || parsed.unstaged > 0 || parsed.untracked > 0,
            staged: parsed.staged,
            staged_files: parsed.staged_files,
            unstaged: parsed.unstaged,
            unstaged_files: parsed.unstaged_files,
            untracked: parsed.untracked,
            untracked_files: parsed.untracked_files,
            ahead: parsed.ahead,
            behind: parsed.behind,
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

#[derive(Default)]
struct ParsedPorcelainStatus {
    branch: String,
    remote: Option<String>,
    ahead: i64,
    behind: i64,
    staged: i64,
    staged_files: Vec<FileStatus>,
    unstaged: i64,
    unstaged_files: Vec<FileStatus>,
    untracked: i64,
    untracked_files: Vec<FileStatus>,
}

fn parse_porcelain_v2(raw: &str) -> ParsedPorcelainStatus {
    let mut result = ParsedPorcelainStatus::default();

    for line in raw.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            result.branch = if head == "(detached)" { "HEAD" } else { head }.to_string();
        } else if let Some(upstream) = line.strip_prefix("# branch.upstream ") {
            result.remote = Some(upstream.to_string());
        } else if let Some(counts) = line.strip_prefix("# branch.ab ") {
            for count in counts.split_whitespace() {
                if let Some(ahead) = count.strip_prefix('+') {
                    result.ahead = ahead.parse().unwrap_or(0);
                } else if let Some(behind) = count.strip_prefix('-') {
                    result.behind = behind.parse().unwrap_or(0);
                }
            }
        } else if let Some(path) = line.strip_prefix("? ") {
            result.untracked += 1;
            result.untracked_files.push(FileStatus {
                path: path.to_string(),
                status: "??".to_string(),
            });
        } else if matches!(line.as_bytes().first(), Some(b'1' | b'2' | b'u')) {
            let (xy, path) = match line.as_bytes()[0] {
                b'1' => record_fields(line, 9),
                b'2' => record_fields(line, 10),
                b'u' => record_fields(line, 11),
                _ => None,
            }
            .unwrap_or(("..", ""));
            let path = path.split('\t').next().unwrap_or(path).to_string();
            let bytes = xy.as_bytes();
            if bytes.first().is_some_and(|status| *status != b'.') {
                result.staged += 1;
                result.staged_files.push(FileStatus {
                    path: path.clone(),
                    status: format!("{} ", bytes[0] as char),
                });
            }
            if bytes.get(1).is_some_and(|status| *status != b'.') {
                result.unstaged += 1;
                result.unstaged_files.push(FileStatus {
                    path,
                    status: format!(" {}", bytes[1] as char),
                });
            }
        }
    }

    result
}

fn record_fields(line: &str, field_count: usize) -> Option<(&str, &str)> {
    let fields: Vec<&str> = line.splitn(field_count, ' ').collect();
    Some((*fields.get(1)?, *fields.get(field_count - 1)?))
}

#[cfg(test)]
mod tests {
    use super::parse_porcelain_v2;

    #[test]
    fn parses_branch_counts_and_file_states() {
        let parsed = parse_porcelain_v2(
            "# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n1 M. N... 100644 100644 100644 abc def staged.txt\n1 .M N... 100644 100644 100644 abc def folder/changed file.txt\n? new file.txt",
        );

        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.remote.as_deref(), Some("origin/main"));
        assert_eq!((parsed.ahead, parsed.behind), (2, 3));
        assert_eq!(parsed.staged, 1);
        assert_eq!(parsed.staged_files[0].path, "staged.txt");
        assert_eq!(parsed.unstaged, 1);
        assert_eq!(parsed.unstaged_files[0].path, "folder/changed file.txt");
        assert_eq!(parsed.untracked, 1);
        assert_eq!(parsed.untracked_files[0].path, "new file.txt");
    }

    #[test]
    fn parses_rename_target_and_detached_head() {
        let parsed = parse_porcelain_v2(
            "# branch.head (detached)\n2 R. N... 100644 100644 100644 abc def R100 new name.txt\told name.txt",
        );

        assert_eq!(parsed.branch, "HEAD");
        assert_eq!(parsed.staged_files[0].path, "new name.txt");
    }
}
