import { Context, Data, Effect } from "effect"
import { exec } from "node:child_process"

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly command: string
  readonly repoPath: string
  readonly cause: string
}> {}

export interface GitStatusResult {
  readonly branch: string
  readonly remote: string | null
  readonly hasChanges: boolean
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly ahead: number
  readonly behind: number
  readonly lastCommitTime: number | null
  readonly weekCommits: number
}

export interface GitServiceShape {
  readonly run: (
    args: string,
    repoPath: string,
    options?: { readonly timeout?: number },
  ) => Effect.Effect<string, GitCommandError>

  readonly getStatus: (
    repoPath: string,
  ) => Effect.Effect<GitStatusResult, GitCommandError>
}

export const GitService = Context.Service<GitServiceShape>(
  "@git-glance/GitService",
)

// ─── Helpers ─────────────────────────────────────────────────────────

function execGit(
  args: string,
  repoPath: string,
  options?: { readonly timeout?: number },
): Effect.Effect<string, GitCommandError> {
  return Effect.callback<string, GitCommandError>((resume) => {
    const timeout = options?.timeout ?? 10_000
    const child = exec(
      `git ${args}`,
      { cwd: repoPath, timeout, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resume(
            Effect.fail(
              new GitCommandError({
                command: `git ${args}`,
                repoPath,
                cause: err.message,
              }),
            ),
          )
        } else {
          resume(Effect.succeed(stdout.toString().trim()))
        }
      },
    )
    return Effect.sync(() => child.kill())
  }).pipe(Effect.retry({ times: 1, delay: 200 }))
}

function safeExec(
  args: string,
  repoPath: string,
  options?: { readonly timeout?: number },
): Effect.Effect<string | null> {
  return execGit(args, repoPath, options).pipe(
    Effect.catch(() => Effect.succeed(null)),
  )
}

// ─── Status ──────────────────────────────────────────────────────────

function getStatus(
  repoPath: string,
): Effect.Effect<GitStatusResult, GitCommandError> {
  return Effect.gen(function* () {
    const [rawStatus, branch, remoteOption] = yield* Effect.all([
      execGit("status --porcelain", repoPath, { timeout: 10_000 }),
      execGit("rev-parse --abbrev-ref HEAD", repoPath, { timeout: 5_000 }),
      safeExec(
        "rev-parse --abbrev-ref --symbolic-full-name @{upstream} 2>/dev/null",
        repoPath,
        { timeout: 5_000 },
      ),
    ])

    let ahead = 0
    let behind = 0
    if (remoteOption) {
      const revList = yield* safeExec(
        "rev-list --left-right --count HEAD...@{upstream}",
        repoPath,
        { timeout: 10_000 },
      )
      if (revList) {
        const parts = revList.split(/\s+/)
        ahead = Number.parseInt(parts[0] ?? "0") || 0
        behind = Number.parseInt(parts[1] ?? "0") || 0
      }
    }

    const lines = rawStatus ? rawStatus.split("\n") : []
    const staged = lines.filter((l: string) => l[0] !== " " && l[0] !== "?").length
    const unstaged = lines.filter((l: string) => l[1] !== " " && l[1] !== "?").length
    const untracked = lines.filter((l: string) => l.startsWith("??")).length
    const hasChanges = staged > 0 || unstaged > 0 || untracked > 0

    const lastCommitRaw = yield* safeExec("log -1 --format=%ct", repoPath, {
      timeout: 5_000,
    })
    const lastCommitTime = lastCommitRaw
      ? Number.parseInt(lastCommitRaw) * 1000
      : null

    let weekCommits = 0
    if (lastCommitTime && Date.now() - lastCommitTime < 7 * 24 * 60 * 60 * 1000) {
      const raw = yield* safeExec(
        `rev-list --count --since="1 week ago" HEAD`,
        repoPath,
        { timeout: 10_000 },
      )
      if (raw) weekCommits = Number.parseInt(raw) || 0
    }

    return {
      branch,
      remote: remoteOption,
      hasChanges,
      staged,
      unstaged,
      untracked,
      ahead,
      behind,
      lastCommitTime,
      weekCommits,
    } as GitStatusResult
  })
}

export const GitServiceLive: GitServiceShape = {
  run: execGit,
  getStatus,
}
