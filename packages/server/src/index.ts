import { Layer } from "effect"
import { BunHttpServer, BunRuntime } from "@effect/platform-bun"
import { HttpRouter } from "effect/unstable/http"
import { makeServerLayer } from "./routes.js"
import { ServerConfigLive } from "./config.js"

const Port = Number.parseInt(process.env["PORT"] ?? "3456", 10)

const ServerLayer = BunHttpServer.layer({ port: Port, idleTimeout: 120 })

const program = makeServerLayer.pipe(
  HttpRouter.serve,
  Layer.provide(ServerConfigLive),
  Layer.provide(ServerLayer),
)

BunRuntime.runMain(Layer.launch(program))
