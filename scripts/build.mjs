import { execSync } from "node:child_process"
import { platform } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { copyFileSync, mkdirSync } from "node:fs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const root = join(__dirname, "..")
const isWin = platform() === "win32"
const ext = isWin ? ".exe" : ""

console.log("Building frontend (vite)...")
execSync("pnpm --filter @git-glance/desktop build", { stdio: "inherit", cwd: root })

console.log("Building Rust server...")
mkdirSync(join(root, "dist"), { recursive: true })
execSync(
  "cargo build --release",
  { stdio: "inherit", cwd: join(root, "packages", "server-rust") },
)

const rustBin = join(root, "packages", "server-rust", "target", "release", `git-glance-serve${ext}`)
const destBin = join(root, "dist", `git-glance-serve${ext}`)
copyFileSync(rustBin, destBin)

console.log(`Done. Binary at dist/git-glance-serve${ext}`)
