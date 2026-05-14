import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import * as Effect from "effect/Effect"

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
        GLANCE_SECRET: process.env.GLANCE_SECRET ?? "",
        AUTH_ISSUER_URL: process.env.AUTH_ISSUER_URL ?? "",
        AUTH_CLIENT_ID: process.env.AUTH_CLIENT_ID ?? "",
        OWNER_EMAIL: process.env.OWNER_EMAIL ?? "",
        DEV_AUTH_EMAIL: process.env.DEV_AUTH_EMAIL ?? "",
      },
    })

    return { url: worker.url }
  }),
)
