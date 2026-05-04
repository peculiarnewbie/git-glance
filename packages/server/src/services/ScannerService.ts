import { Context, Effect, Stream, Queue } from "effect"
import { readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { GitRepo, ScanProgress } from "@git-glance/schema"
import type { GitServiceShape, GitStatusResult } from "./GitService.js"
import type { CacheServiceShape } from "./CacheService.js"

export interface ScannerServiceShape {
  readonly scan: (rootDir: string) => Stream.Stream<ScanProgress>
}

export const ScannerService = Context.Service<ScannerServiceShape>(
  "@git-glance/ScannerService",
)

// ─── Internal helpers ────────────────────────────────────────────────

function findGitRepos(rootDir: string): Array<string> {
  const repos: Array<string> = []
  function walk(dir: string) {
    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === ".git" && entry.isDirectory()) {
          repos.push(dir)
          return
        }
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          walk(join(dir, entry.name))
        }
      }
    } catch {
      // permission denied or other transient errors — skip
    }
  }
  walk(rootDir)
  return repos
}

function scanOneRepo(
  repoPath: string,
  git: GitServiceShape,
): Effect.Effect<GitRepo> {
  return Effect.gen(function* () {
    const status = yield* git.getStatus(repoPath)
    return new GitRepo({
      name: basename(repoPath),
      path: repoPath,
      branch: status.branch || null,
      hasChanges: status.hasChanges,
      staged: status.staged,
      unstaged: status.unstaged,
      untracked: status.untracked,
      ahead: status.ahead,
      behind: status.behind,
      lastCommitTime: status.lastCommitTime,
      weekCommits: status.weekCommits,
      lastScanTime: Date.now(),
      error: null,
    })
  }).pipe(
    Effect.catch((e) =>
      Effect.succeed(
        new GitRepo({
          name: basename(repoPath),
          path: repoPath,
          branch: null,
          hasChanges: false,
          staged: 0,
          unstaged: 0,
          untracked: 0,
          ahead: 0,
          behind: 0,
          lastCommitTime: null,
          weekCommits: 0,
          lastScanTime: Date.now(),
          error: String(e),
        }),
      ),
    ),
  )
}

// ─── Live implementation ─────────────────────────────────────────────

export const ScannerServiceLive = (
  git: GitServiceShape,
  cache: CacheServiceShape,
): ScannerServiceShape => ({
  scan: (rootDir) =>
    Stream.unwrap(
      Effect.gen(function* () {
        // 1. Discover repos
        const repoPaths = findGitRepos(rootDir)
        const total = repoPaths.length
        const concurrency = Math.min(6, total || 1)

        // 2. Create a queue for streaming events during scan
        const queue = yield* Queue.unbounded<ScanProgress>()

        // 3. Emit "discovering" event
        yield* Queue.offer(
          queue,
          new ScanProgress({
            phase: "discovering" as const,
            total,
            current: 0,
            repo: null,
          }),
        )

        // 4. Fork a fiber that scans and feeds the queue
        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const results: Array<GitRepo> = []

            yield* Effect.forEach(
              repoPaths,
              (repoPath, index) =>
                Effect.gen(function* () {
                  const repo = yield* scanOneRepo(repoPath, git)
                  results.push(repo)
                  yield* Queue.offer(
                    queue,
                    new ScanProgress({
                      phase: "scanning" as const,
                      total,
                      current: index + 1,
                      repo,
                    }),
                  )
                }),
              { concurrency, discard: true },
            )

            // 5. Persist cache
            yield* cache.save(results)

            // 6. Emit "done"
            yield* Queue.offer(
              queue,
              new ScanProgress({
                phase: "done" as const,
                total,
                current: total,
                repo: null,
              }),
            )

            // 7. Shut down queue → stream ends naturally
            yield* Queue.shutdown(queue)
          }),
        )

        // 8. Return the stream; scope manages fiber lifecycle
        return Stream.fromQueue(queue)
      }),
    ),
})
