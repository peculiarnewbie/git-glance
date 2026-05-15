import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"
import { readFileSync } from "fs"
import { resolve, dirname } from "path"
import { fileURLToPath } from "url"

const __dirname = dirname(fileURLToPath(import.meta.url))

function loadDotenv(path: string) {
  try {
    const text = readFileSync(path, "utf-8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const idx = trimmed.indexOf("=")
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      if (!process.env[key]) process.env[key] = val
    }
  } catch { /* .env not found */ }
}

loadDotenv(resolve(__dirname, ".env"))

export default Alchemy.Stack(
  "GitGlance",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage

    const glanceDO = Cloudflare.DurableObjectNamespace("GIT_GLANCE_DO", {
      className: "GitGlanceDO",
    })

    const worker = yield* Cloudflare.Worker("GitGlanceWorker", {
      name: `git-glance-${stage}`,
      main: "src/index.ts",
      assets: "dist",
      compatibility: { date: "2025-04-01" },
      domain: "git-glance.peculiarnewbie.com",
      bindings: {
        GIT_GLANCE_DO: glanceDO,
      },
      env: {
        APP_PUBLIC_URL: process.env.APP_PUBLIC_URL ?? "https://git-glance.peculiarnewbie.com",
        AUTH_ISSUER_URL: process.env.AUTH_ISSUER_URL ?? "",
        AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID ?? "",
        OWNER_EMAIL: process.env.OWNER_EMAIL ?? "",
        DEV_AUTH_EMAIL: process.env.DEV_AUTH_EMAIL ?? "",
      },
    })

    return { url: worker.url }
  }),
)
