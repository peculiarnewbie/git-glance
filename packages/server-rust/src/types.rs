use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoSettings {
    #[serde(default)]
    pub skip_untracked: bool,
    #[serde(default)]
    pub skip_pull_check: bool,
    #[serde(default)]
    pub auto_pull_if_clean: bool,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepo {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default)]
    pub has_changes: bool,
    #[serde(default)]
    pub staged: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub staged_files: Vec<FileStatus>,
    #[serde(default)]
    pub unstaged: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unstaged_files: Vec<FileStatus>,
    #[serde(default)]
    pub untracked: i64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub untracked_files: Vec<FileStatus>,
    #[serde(default)]
    pub ahead: i64,
    #[serde(default)]
    pub behind: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_commit_time: Option<i64>,
    #[serde(default)]
    pub week_commits: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_scan_time: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<GitRepoSettings>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[allow(dead_code)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_dir: Option<String>,
    #[serde(default = "default_model")]
    pub opencode_model: String,
}

fn default_model() -> String {
    "deepseek/deepseek-v4-flash".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReposResponse {
    pub repos: Vec<GitRepo>,
    pub scanned_at: i64,
    pub scanned_dirs: Vec<String>,
}

/// A deterministic view of the cached workspace state.  This is intentionally
/// facts-only so API consumers can apply their own ranking or summarisation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStatusResponse {
    pub generated_at: i64,
    pub repos: Vec<GitRepo>,
    pub total_repos: usize,
    pub dirty_repos: usize,
    pub ahead_repos: usize,
    pub behind_repos: usize,
    pub errored_repos: usize,
    pub hidden_repos: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCommit {
    pub hash: String,
    pub timestamp: i64,
    pub author: String,
    pub subject: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoActivity {
    pub repo: GitRepo,
    pub commits: Vec<RecentCommit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentActivityResponse {
    pub since: i64,
    pub until: i64,
    pub activities: Vec<RepoActivity>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PullPushResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RescanResult {
    #[serde(default)]
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<GitRepo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub phase: String,
    #[serde(default)]
    pub total: usize,
    #[serde(default)]
    pub current: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<GitRepo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitProgress {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchProgress {
    pub phase: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<GitRepo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_name: Option<String>,
    #[serde(default)]
    pub current: usize,
    #[serde(default)]
    pub total: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistedConfig {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub root_dir: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub opencode_model: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub excluded_dirs: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct GitStatusResult {
    pub branch: String,
    pub remote: Option<String>,
    pub has_changes: bool,
    pub staged: i64,
    pub staged_files: Vec<FileStatus>,
    pub unstaged: i64,
    pub unstaged_files: Vec<FileStatus>,
    pub untracked: i64,
    pub untracked_files: Vec<FileStatus>,
    pub ahead: i64,
    pub behind: i64,
    pub last_commit_time: Option<i64>,
    pub week_commits: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WSRequest {
    pub id: String,
    pub action: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WSResponse {
    pub id: String,
    #[serde(rename = "type")]
    pub msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    #[serde(rename = "error")]
    pub error: String,
}

impl WSResponse {
    pub fn result(id: &str, data: serde_json::Value) -> Self {
        Self {
            id: id.to_string(),
            msg_type: "result".to_string(),
            data: Some(data),
            error: String::new(),
        }
    }

    pub fn error(id: &str, msg: &str) -> Self {
        Self {
            id: id.to_string(),
            msg_type: "error".to_string(),
            data: None,
            error: msg.to_string(),
        }
    }

    pub fn progress(id: &str, data: serde_json::Value) -> Self {
        Self {
            id: id.to_string(),
            msg_type: "progress".to_string(),
            data: Some(data),
            error: String::new(),
        }
    }

    pub fn done(id: &str) -> Self {
        Self {
            id: id.to_string(),
            msg_type: "done".to_string(),
            data: None,
            error: String::new(),
        }
    }
}
