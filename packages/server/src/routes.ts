import { basename, join } from "node:path"
import { homedir } from "node:os"
import { readFileSync } from "node:fs"
import { Effect, Layer, Queue, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import {
  GitRepo,
  ScanProgress,
  CommitProgress,
  FetchProgress,
  PullPushResult,
} from "@git-glance/schema"
import { ScannerService, ScannerServiceLive, cancelScan as cancelScannerScan, resetCancel } from "./services/ScannerService.js"
import { GitService, GitServiceLive } from "./services/GitService.js"
import { CacheService, CacheServiceLive } from "./services/CacheService.js"
import { RemoteMachineService, RemoteMachineServiceLive } from "./services/RemoteMachineService.js"
import { OpenCodeService, OpenCodeServiceLive } from "./services/OpenCodeService.js"
import { ServerConfigLive } from "./config.js"
import { staticAndDevRouteLayer } from "./http.js"

// ─── Service instances ─────────────────────────────────────────────

const defaultCachePath = join(homedir(), ".git-glance", "repo-cache.json")
const defaultConfigPath = join(homedir(), ".git-glance", "config.json")

const cacheService = CacheServiceLive({
  cachePath: defaultCachePath,
  configPath: defaultConfigPath,
})
const gitService = GitServiceLive
const openCodeService = OpenCodeServiceLive

// Remote machine service ties into cache for storing/loading remote repos
let remoteService: ReturnType<typeof RemoteMachineServiceLive> | null = null
const initRemoteService = () => {
  if (!remoteService) {
    remoteService = RemoteMachineServiceLive(
      (machine, repos) => cacheService.setRemoteRepos(machine, repos),
      () => Effect.void,
    )
  }
  return remoteService
}

// Cancellation flags (in-memory)
let cancelScan = false
let cancelCommit = false
let cancelFetch = false

// Load config synchronously on module load
try {
  const configPath = join(homedir(), ".git-glance", "config.json")
  const cfg = JSON.parse(readFileSync(configPath, "utf-8"))
  if (cfg.rootDir) Effect.runSync(cacheService.addScannedDir(cfg.rootDir))
  if (cfg.machines?.length > 0) initRemoteService()
} catch {} // no config yet, that's fine

// ─── API route layer ───────────────────────────────────────────────

const apiRoutes = HttpRouter.use(
  (router: HttpRouter.HttpRouter) =>
    Effect.gen(function* () {
      // ── GET /health ──────────────────────────────────────────────
      yield* router.add("GET", "/health", HttpServerResponse.json({ status: "ok" }))

      // ── GET /repos ───────────────────────────────────────────────
      yield* router.add(
        "GET",
        "/repos",
        Effect.gen(function* () {
          const allRepos = yield* cacheService.getAllRepos()
          const remoteSvc = initRemoteService()
          const [machines, scannedDirs] = yield* Effect.all([
            remoteSvc.getStatuses(),
            cacheService.getScannedDirs(),
          ])
          return yield* HttpServerResponse.json({
            repos: allRepos,
            scannedAt: Date.now(),
            scannedDirs: [...scannedDirs],
            machines: [...machines],
          })
        }),
      )

      // ── GET /scan?rootDir=X (SSE) ────────────────────────────────
      yield* router.add(
        "GET",
        "/scan",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const rootDir = url.searchParams.get("rootDir")
            if (!rootDir) {
              return HttpServerResponse.text('Missing "rootDir" query parameter', { status: 400 })
            }
            cancelScan = false
            resetCancel()
            yield* cacheService.addScannedDir(rootDir)

            const scanner = ScannerServiceLive(gitService, cacheService)
            const stream = scanner.scan(rootDir, "local").pipe(
              Stream.map(formatSSE),
              Stream.map((s) => new TextEncoder().encode(s)),
              Stream.catchCause(() => Stream.empty),
            )

            return HttpServerResponse.stream(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            })
          }),
      )

      // ── POST /pull?repo=X ────────────────────────────────────────
      yield* router.add(
        "POST",
        "/pull",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const repo = url.searchParams.get("repo")
            const machine = url.searchParams.get("machine") ?? "local"
            if (!repo) {
              return yield* HttpServerResponse.json({ ok: false, error: 'Missing "repo" parameter' }, { status: 400 })
            }

            if (machine !== "local") {
              const remoteSvc = initRemoteService()
              const result = yield* remoteSvc.proxyRequest(machine, "POST", `/pull?repo=${encodeURIComponent(repo)}`)
              return yield* HttpServerResponse.json(result)
            }

            const run = gitService.run("pull", repo, { timeout: 30_000 }).pipe(
              Effect.map((output) => ({ ok: true as const, output })),
              Effect.catch((e) =>
                Effect.succeed({ ok: false as const, error: String((e as { cause?: string }).cause ?? e) }),
              ),
            )
            const result = yield* run

            if (result.ok) {
              yield* updateRepoInCache(repo)
            }

            return yield* HttpServerResponse.json(result, result.ok ? {} : { status: 500 })
          }),
      )

      // ── POST /push?repo=X ────────────────────────────────────────
      yield* router.add(
        "POST",
        "/push",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const repo = url.searchParams.get("repo")
            const machine = url.searchParams.get("machine") ?? "local"
            if (!repo) {
              return yield* HttpServerResponse.json({ ok: false, error: 'Missing "repo" parameter' }, { status: 400 })
            }

            if (machine !== "local") {
              const remoteSvc = initRemoteService()
              const result = yield* remoteSvc.proxyRequest(machine, "POST", `/push?repo=${encodeURIComponent(repo)}`)
              return yield* HttpServerResponse.json(result)
            }

            const run = gitService.run("push", repo, { timeout: 30_000 }).pipe(
              Effect.map((output) => ({ ok: true as const, output })),
              Effect.catch((e) =>
                Effect.succeed({ ok: false as const, error: String((e as { cause?: string }).cause ?? e) }),
              ),
            )
            const result = yield* run

            if (result.ok) {
              yield* updateRepoInCache(repo)
            }

            return yield* HttpServerResponse.json(result, result.ok ? {} : { status: 500 })
          }),
      )

      // ── GET /config ──────────────────────────────────────────────
      yield* router.add(
        "GET",
        "/config",
        Effect.gen(function* () {
          const config = yield* cacheService.loadConfig()
          const remoteSvc = initRemoteService()
          const machines = yield* remoteSvc.getStatuses()
          return yield* HttpServerResponse.json({
            rootDir: config.rootDir ?? null,
            opencodeModel: config.opencodeModel ?? "CrofAI/deepseek-v4-flash",
            machines: (config.machines ?? []).map((m) => ({
              name: m.name,
              url: m.url,
              online: machines.find((s) => s.name === m.name)?.online ?? false,
            })),
          })
        }),
      )

      // ── PUT /config ──────────────────────────────────────────────
      yield* router.add(
        "PUT",
        "/config",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const body: { rootDir?: string; opencodeModel?: string; machines?: Array<{ name: string; url: string }> } =
              yield* req.json as Effect.Effect<Record<string, unknown>>
            const existing = yield* cacheService.loadConfig()
            const updated = {
              ...existing,
              ...(body.rootDir !== undefined ? { rootDir: body.rootDir } : {}),
              ...(body.opencodeModel !== undefined ? { opencodeModel: body.opencodeModel } : {}),
              ...(body.machines !== undefined ? { machines: body.machines } : {}),
            }
            yield* cacheService.saveConfig(updated)
            if (updated.machines) {
              const remoteSvc = initRemoteService()
              yield* remoteSvc.updateConfig(updated)
            }
            return yield* HttpServerResponse.json({ ok: true })
          }),
      )

      // ── POST /commit-push?repo=X (SSE) ───────────────────────────
      yield* router.add(
        "POST",
        "/commit-push",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const repo = url.searchParams.get("repo")
            if (!repo) {
              return HttpServerResponse.text('Missing "repo" parameter', { status: 400 })
            }

            cancelCommit = false
            const stream = commitPushStream(repo)
            return HttpServerResponse.stream(stream, {
              headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              },
            })
          }),
      )

      // ── POST /cancel-commit ──────────────────────────────────────
      yield* router.add(
        "POST",
        "/cancel-commit",
        Effect.gen(function* () {
          cancelCommit = true
          return HttpServerResponse.text("ok")
        }),
      )

      // ── POST /cancel-scan ────────────────────────────────────────
      yield* router.add(
        "POST",
        "/cancel-scan",
        Effect.gen(function* () {
          cancelScan = true
          cancelScannerScan()
          return HttpServerResponse.text("ok")
        }),
      )

      // ── GET /fetch (SSE) ─────────────────────────────────────────
      yield* router.add(
        "GET",
        "/fetch",
        Effect.gen(function* () {
          cancelFetch = false
          const stream = backgroundFetchStream()
          return HttpServerResponse.stream(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          })
        }),
      )

      // ── POST /cancel-fetch ────────────────────────────────────────
      yield* router.add(
        "POST",
        "/cancel-fetch",
        Effect.gen(function* () {
          cancelFetch = true
          return HttpServerResponse.text("ok")
        }),
      )

      // ── POST /settings?repo=X ────────────────────────────────────
      yield* router.add(
        "POST",
        "/settings",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const repo = url.searchParams.get("repo")
            if (!repo) {
              return yield* HttpServerResponse.json({ ok: false, error: 'Missing "repo" parameter' }, { status: 400 })
            }

            const body: { skipUntracked?: boolean; skipPullCheck?: boolean; hidden?: boolean } =
              yield* req.json as Effect.Effect<Record<string, unknown>>

            const repos = yield* cacheService.load()
            const updated = repos.map((r) => {
              if (r.path !== repo) return r
              const current = r.settings ?? { skipUntracked: false, skipPullCheck: false, hidden: false }
              return new GitRepo({
                ...r,
                settings: {
                  skipUntracked: body.skipUntracked ?? current.skipUntracked,
                  skipPullCheck: body.skipPullCheck ?? current.skipPullCheck,
                  hidden: body.hidden ?? current.hidden,
                },
              })
            })
            yield* cacheService.save(updated)
            return yield* HttpServerResponse.json({ ok: true })
          }),
      )
    }).pipe(
      Effect.provideService(GitService, gitService),
      Effect.provideService(CacheService, cacheService),
      Effect.provideService(OpenCodeService, openCodeService),
    ),
)

// ─── Static file serving layer ──────────────────────────────────────

export const makeServerLayer = Layer.mergeAll(
  apiRoutes,
  staticAndDevRouteLayer,
)

// ─── Helper functions ────────────────────────────────────────────────

function formatSSE(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

function updateRepoInCache(repo: string) {
  return Effect.gen(function* () {
    const status = yield* gitService.getStatus(repo).pipe(Effect.catch(() => Effect.succeed(null)))
    if (!status) return
    const repos = [...(yield* cacheService.load())]
    const idx = repos.findIndex((r) => r.path === repo)
    const updated = new GitRepo({
      name: basename(repo),
      path: repo,
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
      machine: "local",
      settings: null,
    })
    if (idx >= 0) {
      repos.splice(idx, 1, updated)
    }
    yield* cacheService.save(repos)
  })
}

function commitPushStream(repo: string): Stream.Stream<Uint8Array> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* effectQueueUnbounded<CommitProgress>()

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const send = (phase: string, data: Record<string, unknown> = {}) =>
            Queue.offer(queue, new CommitProgress({ phase: phase as CommitProgress["phase"], error: null, subject: null, body: null, repoPath: repo, ...data }))

          try {
            yield* send("staging")
            yield* gitService.run("add .", repo, { timeout: 15_000 })
            if (cancelCommit) return

            const branch = yield* gitService.run("rev-parse --abbrev-ref HEAD", repo, { timeout: 5_000 })

            const [stagedSummary, stagedPatch] = yield* Effect.all([
              gitService.run("diff --cached --stat", repo, { timeout: 10_000 }),
              gitService.run("diff --cached", repo, { timeout: 10_000 }),
            ])

            if (!stagedPatch) {
              yield* send("error", { error: "No changes to commit" })
              return
            }

            if (cancelCommit) return

            const config = yield* cacheService.loadConfig()
            const model = config.opencodeModel ?? "CrofAI/deepseek-v4-flash"

            yield* send("generating")
            const commitMsg = yield* openCodeService.generateCommitMessage({
              repoPath: repo,
              branch,
              stagedSummary,
              stagedPatch,
              model,
            })

            if (cancelCommit) return

            yield* send("committing")
            const fullMessage = commitMsg.body
              ? `${commitMsg.subject}\n\n${commitMsg.body}`
              : commitMsg.subject
            yield* gitService.run(`commit -m "${fullMessage.replace(/"/g, '\\"')}"`, repo, { timeout: 15_000 })

            if (cancelCommit) return

            yield* send("pushing")
            yield* gitService.run("push", repo, { timeout: 60_000 })

            yield* updateRepoInCache(repo)
            yield* send("done", { subject: commitMsg.subject, body: commitMsg.body })
          } catch (err) {
            yield* send("error", { error: String(err) })
          } finally {
            yield* Queue.shutdown(queue)
          }
        }),
      )

      return Stream.fromQueue(queue).pipe(
        Stream.map((e) => new TextEncoder().encode(formatSSE(e))),
        Stream.catch(() => Stream.empty),
      )
    }),
  )
}

function backgroundFetchStream(): Stream.Stream<Uint8Array> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* effectQueueUnbounded<FetchProgress>()

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const allRepos = yield* cacheService.getAllRepos()
          const localRepos = allRepos.filter((r) => !r.settings?.hidden && !r.settings?.skipPullCheck)
          const total = localRepos.length
          let completed = 0

          yield* Queue.offer(
            queue,
            new FetchProgress({ phase: "fetching", repoPath: null, repoName: null, current: 0, total, ahead: null, behind: null, branch: null, error: null }),
          )

          for (const repo of localRepos) {
            if (cancelFetch) break

            yield* Queue.offer(
              queue,
              new FetchProgress({ phase: "repo", repoPath: repo.path, repoName: repo.name, current: completed, total, ahead: null, behind: null, branch: null, error: null }),
            )

            try {
              yield* gitService.run("fetch origin", repo.path, { timeout: 30_000 })
              if (cancelFetch) break

              const status = yield* gitService.getStatus(repo.path).pipe(
                Effect.catch(() => Effect.succeed(null)),
              )

              if (status) {
                yield* updateRepoInCache(repo.path)
                yield* Queue.offer(
                  queue,
                  new FetchProgress({ phase: "repo", repoPath: repo.path, repoName: repo.name, current: completed + 1, total, ahead: status.ahead, behind: status.behind, branch: status.branch, error: null }),
                )
              }
            } catch {
              yield* Queue.offer(
                queue,
                new FetchProgress({ phase: "repo", repoPath: repo.path, repoName: repo.name, current: completed + 1, total, ahead: null, behind: null, branch: null, error: "Fetch failed" }),
              )
            }

            completed++
          }

          yield* Queue.offer(
            queue,
            new FetchProgress({ phase: "done", repoPath: null, repoName: null, current: completed, total, ahead: null, behind: null, branch: null, error: null }),
          )
        }).pipe(Effect.ensuring(Queue.shutdown(queue))),
      )

      return Stream.fromQueue(queue).pipe(
        Stream.map((e) => new TextEncoder().encode(formatSSE(e))),
        Stream.catch(() => Stream.empty),
      )
    }),
  )
}

function effectQueueUnbounded<T>() {
  return Queue.unbounded<T>()
}

// Re-export AppLayer for backward compatibility
export const AppLayer = apiRoutes