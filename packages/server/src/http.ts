import { existsSync, readFileSync } from "node:fs"
import { extname, normalize, resolve } from "node:path"
import { Effect, Option } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ServerConfig, resolveStaticDir } from "./config.js"

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])

function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname.trim().toLowerCase())
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
  }
  return map[ext] ?? "application/octet-stream"
}

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const url = HttpServerRequest.toURL(request)
    if (Option.isNone(url)) return HttpServerResponse.text("Bad Request", { status: 400 })

    const config = yield* ServerConfig

    if (config.devUrl && isLoopback(url.value.hostname)) {
      const redirect = new URL(config.devUrl)
      redirect.pathname = url.value.pathname
      redirect.search = url.value.search
      return HttpServerResponse.redirect(redirect.toString(), { status: 302 })
    }

    const staticDir = config.staticDir ?? (yield* resolveStaticDir)
    if (!staticDir) {
      return HttpServerResponse.text("Not Found", { status: 404 })
    }

    const staticRoot = resolve(staticDir)
    let reqPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname
    const relativePath = normalize(reqPath.replace(/^[/\\]+/, "")).replace(/^\.\.\/?/, "")
    const filePath = resolve(staticRoot, relativePath || "index.html")

    if (!filePath.startsWith(staticRoot)) {
      return HttpServerResponse.text("Forbidden", { status: 403 })
    }

    try {
      const candidate = extname(filePath) ? filePath : resolve(filePath, "index.html")

      if (!existsSync(candidate)) {
        const indexData = readFileSync(resolve(staticRoot, "index.html"))
        return HttpServerResponse.uint8Array(indexData, {
          status: 200,
          contentType: "text/html; charset=utf-8",
        })
      }

      const data = readFileSync(candidate)
      return HttpServerResponse.uint8Array(data, {
        status: 200,
        contentType: extToMime(extname(candidate)),
      })
    } catch {
      return HttpServerResponse.text("Not Found", { status: 404 })
    }
  }),
)
