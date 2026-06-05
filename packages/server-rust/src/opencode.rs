use std::process::Stdio;
use tokio::process::Command;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct CommitMessage {
    pub subject: String,
    pub body: String,
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() > max {
        format!("{}...", &s[..max])
    } else {
        s.to_string()
    }
}

fn build_prompt(branch: &str, staged_summary: &str, staged_patch: &str) -> String {
    let branch = if branch.is_empty() {
        "(detached)"
    } else {
        branch
    };
    format!(
        r#"You write concise git commit messages.
Return a JSON object with keys: subject, body.
Rules:
- subject must be imperative, <= 72 chars, and no trailing period
- body can be empty string or short bullet points
- capture the primary user-visible or developer-visible change

Branch: {}

Staged files:
{}

Staged patch:
{}"#,
        branch,
        truncate(staged_summary, 6000),
        truncate(staged_patch, 40000)
    )
}

pub async fn generate_commit_message(
    repo_path: &str,
    branch: &str,
    staged_summary: &str,
    staged_patch: &str,
    model: &str,
) -> Result<CommitMessage, String> {
    let prompt = build_prompt(branch, staged_summary, staged_patch);

    let args = vec![
        "run", "--format", "json", "-m", model, "--dir", repo_path,
    ];

    let mut child = Command::new("opencode")
        .args(&args)
        .current_dir(repo_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run opencode: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(prompt.as_bytes()).await;
        drop(stdin);
    }

    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("opencode wait failed: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "opencode failed: {}\nstderr: {}",
            output.status, stderr
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut raw_text = String::new();

    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(ev) = serde_json::from_str::<serde_json::Value>(line) {
            if ev.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = ev
                    .get("part")
                    .and_then(|p| p.get("text"))
                    .and_then(|t| t.as_str())
                {
                    raw_text.push_str(text);
                }
            }
        }
    }

    if raw_text.is_empty() {
        return Err("no text response from opencode".to_string());
    }

    let start = raw_text.find('{');
    let end = raw_text.rfind('}');

    match (start, end) {
        (Some(s), Some(e)) => {
            let json_str = &raw_text[s..=e];
            let msg: CommitMessage = serde_json::from_str(json_str)
                .map_err(|e| format!("could not parse JSON: {}", e))?;
            let subject = msg.subject.trim().to_string();
            let body = msg.body.trim().to_string();
            if subject.is_empty() {
                Err("no subject in commit message".to_string())
            } else {
                Ok(CommitMessage { subject, body })
            }
        }
        _ => Err("could not parse JSON from opencode response".to_string()),
    }
}
