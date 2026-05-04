import { Effect, Layer, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ScanProgress } from "@git-glance/schema"
import { ScannerService, ScannerServiceLive } from "./services/ScannerService.js"
import { GitService, GitServiceLive } from "./services/GitService.js"
import { CacheService, CacheServiceLive } from "./services/CacheService.js"

// ─── Shared service instances ────────────────────────────────────────
// These are provided directly to the router effect so the Layer has no
// remaining context requirements.

const defaultCachePath = join(homedir(), ".git-glance", "repo-cache.json")
import { homedir } from "node:os"
import { join } from "node:path"

const cacheService = CacheServiceLive({ cachePath: join(homedir(), ".git-glance", "repo-cache.json") })

const gitService = GitServiceLive
const scannerService = ScannerServiceLive(gitService, cacheService)

/**
 * Build the application layer using HttpRouter.use.
 * Services are provided directly so the layer has no requirements.
 */
export const AppLayer = HttpRouter.use(
  (router: HttpRouter.HttpRouter) =>
    Effect.gen(function* () {
      // ── GET /health — health check ────────────────────────────────
      yield* router.add("GET", "/health", HttpServerResponse.json({ status: "ok" }))

      // ── GET /repos — return cached repos ──────────────────────────
      yield* router.add(
        "GET",
        "/repos",
        Effect.gen(function* () {
          const repos = yield* cacheService.load()
          return yield* HttpServerResponse.json({
            repos,
            scannedAt: Date.now(),
          })
        }),
      )

      // ── POST /pull?repo=<path> — git pull ─────────────────────────
      yield* router.add(
        "POST",
        "/pull",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const repo = url.searchParams.get("repo")
            if (!repo) {
              return yield* HttpServerResponse.json(
                { ok: false, error: 'Missing "repo" parameter' },
                { status: 400 },
              )
            }

            const run = gitService.run("pull", repo, { timeout: 30_000 }).pipe(
              Effect.map((output) => ({ ok: true as const, output })),
              Effect.catch((e) =>
                Effect.succeed({ ok: false as const, error: String((e as { cause?: string }).cause ?? e) }),
              ),
            )
            const result = yield* run
            return yield* HttpServerResponse.json(result, result.ok ? {} : { status: 500 })
          }),
      )

      // ── POST /push?repo=<path> — git push ─────────────────────────
      yield* router.add(
        "POST",
        "/push",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const repo = url.searchParams.get("repo")
            if (!repo) {
              return yield* HttpServerResponse.json(
                { ok: false, error: 'Missing "repo" parameter' },
                { status: 400 },
              )
            }

            const run = gitService.run("push", repo, { timeout: 30_000 }).pipe(
              Effect.map((output) => ({ ok: true as const, output })),
              Effect.catch((e) =>
                Effect.succeed({ ok: false as const, error: String((e as { cause?: string }).cause ?? e) }),
              ),
            )
            const result = yield* run
            return yield* HttpServerResponse.json(result, result.ok ? {} : { status: 500 })
          }),
      )
      yield* router.add(
        "GET",
        "/scan",
        (req: HttpServerRequest.HttpServerRequest) =>
          Effect.gen(function* () {
            const url = new URL(req.url, "http://localhost")
            const rootDir = url.searchParams.get("rootDir")
            if (!rootDir) {
              return HttpServerResponse.text(
                'Missing "rootDir" query parameter',
                { status: 400 },
              )
            }

            const stream = scannerService.scan(rootDir)

            return HttpServerResponse.stream(
              stream.pipe(
                Stream.map(formatSSE),
                Stream.map((s) => new TextEncoder().encode(s)),
              ),
              {
                headers: {
                  "Content-Type": "text/event-stream" as const,
                  "Cache-Control": "no-cache" as const,
                  Connection: "keep-alive" as const,
                },
              },
            )
          }),
      )
    }).pipe(
      // Provide services to the router effect directly
      Effect.provideService(GitService, gitService),
      Effect.provideService(CacheService, cacheService),
      Effect.provideService(ScannerService, scannerService),
    ),
)

// ─── Helpers ─────────────────────────────────────────────────────────

function formatSSE(event: ScanProgress): string {
  return `data: ${JSON.stringify(event)}\n\n`
}
