import { spawn } from "node:child_process"
import { platform } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const root = join(__dirname, "..")
const isWin = platform() === "win32"
const ext = isWin ? ".exe" : ""

const serverBin = join(root, "dist", `git-glance-serve${ext}`)
const staticDir = join(root, "packages", "desktop", "renderer-dist")

if (!existsSync(serverBin)) {
  console.error(`Server binary not found at ${serverBin}`)
  console.error("Run 'pnpm build' first")
  process.exit(1)
}

if (!existsSync(join(staticDir, "index.html"))) {
  console.error(`Static files not found at ${staticDir}`)
  console.error("Run 'pnpm build' first")
  process.exit(1)
}

const proc = spawn(serverBin, ["--static", staticDir, "--port", "3456"], {
  stdio: "inherit",
  env: { ...process.env },
})

proc.on("exit", (code) => process.exit(code ?? 0))
process.on("SIGINT", () => proc.kill("SIGINT"))
process.on("SIGTERM", () => proc.kill("SIGTERM"))
