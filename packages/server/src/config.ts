import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Context, Effect, Layer } from "effect"

export const DEFAULT_PORT = 3456

export interface ServerConfigShape {
  readonly port: number
  readonly host: string | undefined
  readonly rootDir: string | undefined
  readonly staticDir: string | undefined
  readonly devUrl: string | undefined
  readonly opencodeModel: string
  readonly machines: ReadonlyArray<{ readonly name: string; readonly url: string }>
  readonly cachePath: string
  readonly configDir: string
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()(
  "@git-glance/ServerConfig",
) {}

export const ServerConfigLive = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const port = Number.parseInt(process.env["PORT"] ?? String(DEFAULT_PORT), 10)
    const host = process.env["HOST"] || undefined
    const staticDir = process.env["STATIC_DIR"] || undefined
    const devUrl = process.env["DEV_URL"] || undefined
    const opencodeModel = process.env["OPENCODE_MODEL"] || "CrofAI/deepseek-v4-flash"
    const configDir = process.env["CONFIG_DIR"] || join(homedir(), ".git-glance")

    return {
      port,
      host,
      rootDir: undefined,
      staticDir,
      devUrl,
      opencodeModel,
      machines: [],
      cachePath: join(configDir, "repo-cache.json"),
      configDir,
    }
  }),
)

export const resolveStaticDir = Effect.sync(() => {
  const bundled = resolve(join(import.meta.dirname, "../public"))
  if (existsSync(join(bundled, "index.html"))) return bundled

  const monorepo = resolve(join(import.meta.dirname, "../../desktop/renderer-dist"))
  if (existsSync(join(monorepo, "index.html"))) return monorepo

  return undefined
})
