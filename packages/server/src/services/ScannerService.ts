import { Context, Effect, Stream, Queue, Duration } from "effect"
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

const scanConcurrency = 8
const fetchConcurrency = 4

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

/**
 * Merge settings from an existing cached repo entry into a newly scanned one.
 * If no cached entry exists, settings remain null.
 */
function mergeSettings(
  repo: GitRepo,
  existingRepos: ReadonlyArray<GitRepo>,
): GitRepo {
  const existing = existingRepos.find((r) => r.path === repo.path)
  if (existing?.settings) {
    return new GitRepo({ ...repo, settings: existing.settings })
  }
  return repo
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

// ─── Fetch a single repo and return updated status ───────────────────

function fetchAndUpdateStatus(
  repo: GitRepo,
  git: GitServiceShape,
): Effect.Effect<GitRepo> {
  return Effect.gen(function* () {
    console.log("[scan-fetch] fetching", repo.path)
    yield* git.run("fetch origin", repo.path, { timeout: 30_000 }).pipe(
      Effect.catch((e) => {
        console.warn("[scan-fetch] fetch failed for", repo.path, String(e))
        return Effect.succeed("")
      }),
    )
    console.log("[scan-fetch] fetch done for", repo.path)

    const newStatus = yield* git.getStatus(repo.path).pipe(
      Effect.catch(() => Effect.succeed(null as GitStatusResult | null)),
    )

    if (newStatus) {
      console.log("[scan-fetch] status for", repo.path, `ahead=${newStatus.ahead} behind=${newStatus.behind}`)
      return new GitRepo({
        name: repo.name,
        path: repo.path,
        branch: newStatus.branch || repo.branch,
        hasChanges: newStatus.hasChanges,
        staged: newStatus.staged,
        unstaged: newStatus.unstaged,
        untracked: newStatus.untracked,
        ahead: newStatus.ahead,
        behind: newStatus.behind,
        remote: newStatus.remote ?? repo.remote,
        lastCommitTime: newStatus.lastCommitTime ?? repo.lastCommitTime,
        weekCommits: newStatus.weekCommits,
        lastScanTime: Date.now(),
        error: null,
        machine: repo.machine,
        settings: repo.settings,
      })
    }

    return repo
  }).pipe(
    Effect.catch((e) => {
      console.warn("[scan-fetch] unexpected error for", repo.path, String(e))
      return Effect.succeed(repo)
    }),
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

        // Load existing cache once so we can preserve settings
        const existingRepos = yield* cache.load().pipe(
          Effect.catch(() => Effect.succeed([] as Array<GitRepo>)),
        )

        const queue = yield* Queue.unbounded<ScanProgress>()

        yield* Queue.offer(
          queue,
          new ScanProgress({ phase: "discovering", total, current: 0, repo: null }),
        )

        yield* Effect.forkScoped(
          Effect.gen(function* () {
            const results = new Array<GitRepo>(repoPaths.length)
            let scanCompleted = 0

            // ── Phase 1: scan ──────────────────────────────────────
            yield* Effect.forEach(
              repoPaths.map((repoPath, index) => ({ repoPath, index })),
              ({ repoPath, index }) =>
                Effect.gen(function* () {
                  if (canceled) return

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

                  if (canceled) return

                  // Preserve settings from existing cache
                  const withSettings = mergeSettings(repo, existingRepos)
                  results[index] = withSettings
                  scanCompleted++
                  yield* Queue.offer(
                    queue,
                    new ScanProgress({ phase: "scanning", total, current: scanCompleted, repo: withSettings }),
                  )
                }),
              { concurrency: scanConcurrency, discard: true },
            )

            const scannedResults = results.filter((repo): repo is GitRepo => repo !== undefined)

            // ── Phase 2: fetch (only for repos that want it) ───────
            const fetchable = scannedResults.flatMap((repo, index) =>
              !repo.settings?.hidden && !repo.settings?.skipPullCheck ? [{ repo, index }] : [],
            )
            const fetchTotal = fetchable.length
            let fetchCompleted = 0

            yield* Effect.forEach(
              fetchable,
              ({ repo, index }) =>
                Effect.gen(function* () {
                  if (canceled) return

                  // Emit progress before fetching this repo
                  yield* Queue.offer(
                    queue,
                    new ScanProgress({
                      phase: "fetching",
                      total: fetchTotal,
                      current: fetchCompleted,
                      repo,
                    }),
                  )

                  // Run fetch + re-get status
                  const updated = yield* fetchAndUpdateStatus(repo, git)

                  if (canceled) return

                  scannedResults[index] = updated
                  fetchCompleted++

                  // Emit progress after fetch (with updated status)
                  yield* Queue.offer(
                    queue,
                    new ScanProgress({
                      phase: "fetching",
                      total: fetchTotal,
                      current: fetchCompleted,
                      repo: updated,
                    }),
                  )
                }),
              { concurrency: fetchConcurrency, discard: true },
            )

            yield* cache.save(scannedResults)

            yield* Queue.offer(
              queue,
              new ScanProgress({ phase: "done", total: scannedResults.length, current: scannedResults.length, repo: null }),
            )
          }).pipe(
            Effect.catch((e) =>
              Queue.offer(
                queue,
                new ScanProgress({ phase: "done", total, current: 0, repo: null }),
              ),
            ),
            Effect.ensuring(Queue.shutdown(queue)),
          ),
        )

        return Stream.fromQueue(queue)
      }),
    ),
})
