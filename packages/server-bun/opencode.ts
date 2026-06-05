import type { CommitMessage } from "./types";

function truncate(s: string, max: number): string {
  if (s.length > max) return s.slice(0, max) + "\n... [truncated]";
  return s;
}

function buildPrompt(
  branch: string,
  stagedSummary: string,
  stagedPatch: string,
): string {
  if (!branch) branch = "(detached)";
  return `You write concise git commit messages.
Return a JSON object with keys: subject, body.
Rules:
- subject must be imperative, <= 72 chars, and no trailing period
- body can be empty string or short bullet points
- capture the primary user-visible or developer-visible change

Branch: ${branch}

Staged files:
${truncate(stagedSummary, 6000)}

Staged patch:
${truncate(stagedPatch, 40000)}`;
}

export async function generateCommitMessage(
  repoPath: string,
  branch: string,
  stagedSummary: string,
  stagedPatch: string,
  model: string,
): Promise<CommitMessage> {
  const prompt = buildPrompt(branch, stagedSummary, stagedPatch);
  const args = ["run", "--format", "json", "-m", model, "--dir", repoPath];

  const proc = Bun.spawn(["opencode", ...args], {
    cwd: repoPath,
    stdin: new Response(prompt),
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderrStr = stderr.trim();
    if (stderrStr) {
      throw new Error(`opencode failed (exit ${exitCode})\nstderr: ${stderrStr}`);
    }
    throw new Error(`opencode failed (exit ${exitCode})`);
  }

  let rawText = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev.type === "text" && ev.part?.text) {
        rawText += ev.part.text;
      }
    } catch {
      continue;
    }
  }

  if (!rawText) {
    throw new Error("no text response from opencode");
  }

  const start = rawText.indexOf("{");
  const end = rawText.lastIndexOf("}");
  if (start < 0 || end < 0) {
    throw new Error("could not parse JSON from opencode response");
  }

  const msg: CommitMessage = JSON.parse(rawText.slice(start, end + 1));
  msg.subject = msg.subject?.trim() ?? "";
  msg.body = msg.body?.trim() ?? "";

  if (!msg.subject) {
    throw new Error("no subject in commit message");
  }

  return msg;
}
