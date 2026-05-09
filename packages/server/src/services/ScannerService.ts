import { Context, Effect, Stream, Queue } from "effect"
import { readdirSync } from "node:fs"
import { join, basename } from "node:path"
import { GitRepo, ScanProgress } from "@git-glance/schema"
import type { GitServiceShape, GitStatusResult } from "./GitService.js"
import type { CacheServiceShape } from "./CacheService.js"

export interface ScannerServiceShape {
  readonly scan: (rootDir: string, machine?: string) => Stream.Stream<ScanProgress>
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
  machine: string = "local",
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
      remote: status.remote ?? null,
      lastCommitTime: status.lastCommitTime,
      weekCommits: status.weekCommits,
      lastScanTime: Date.now(),
      error: null,
      machine,
      settings: null,
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
          remote: null,
          lastCommitTime: null,
          weekCommits: 0,
          lastScanTime: Date.now(),
          error: String(e),
          machine,
          settings: null,
        }),
      ),
    ),
  )
}

// ─── Live implementation ─────────────────────────────────────────────

let canceled = false

export function cancelScan() {
  canceled = true
}

export function resetCancel() {
  canceled = false
}

export const ScannerServiceLive = (
  git: GitServiceShape,
  cache: CacheServiceShape,
): ScannerServiceShape => ({
  scan: (rootDir, machine = "local") =>
    Stream.unwrap(
      Effect.gen(function* () {
        const repoPaths = findGitRepos(rootDir)
        const total = repoPaths.length

        const queue = yield* Queue.unbounded<ScanProgress>()

        yield* Queue.offer(
          queue,
          new ScanProgress({ phase: "discovering", total, current: 0, repo: null }),
        )

        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const results: Array<GitRepo> = []

            for (let i = 0; i < repoPaths.length; i++) {
              if (canceled) break
              const repoPath = repoPaths[i]!
              const repo = yield* scanOneRepo(repoPath, git, machine).pipe(
                Effect.timeout(Duration.seconds(30)),
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
                      remote: null,
                      lastCommitTime: null,
                      weekCommits: 0,
                      lastScanTime: Date.now(),
                      error: String(e),
                      machine,
                      settings: null,
                    }),
                  ),
                ),
              )
              results.push(repo)
              yield* Queue.offer(
                queue,
                new ScanProgress({ phase: "scanning", total, current: i + 1, repo }),
              )
            }

            yield* cache.save(results)

            yield* Queue.offer(
              queue,
              new ScanProgress({ phase: "done", total, current: results.length, repo: null }),
            )
          }).pipe(
            Effect.catch((e) =>
              Queue.offer(
                queue,
                new ScanProgress({ phase: "done", total, current: 0, repo: null }),
              )
            ),
            Effect.ensuring(Queue.shutdown(queue)),
          ),
        )

        return Stream.fromQueue(queue)
      }),
    ),
})

import { Duration } from "effect"
