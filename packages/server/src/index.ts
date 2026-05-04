import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { createServer } from "node:http"
import { AppLayer } from "./routes.js"

// ─── HTTP server setup ───────────────────────────────────────────────

const Port = Number.parseInt(process.env["PORT"] ?? "3456", 10)

const ServerLayer = NodeHttpServer.layer(createServer, { port: Port })

// ─── Serve ───────────────────────────────────────────────────────────

const program = AppLayer.pipe(
  HttpRouter.serve,
  Layer.provide(ServerLayer),
)

// ─── Run ─────────────────────────────────────────────────────────────

NodeRuntime.runMain(Layer.launch(program))
