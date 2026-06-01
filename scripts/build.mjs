import { execSync } from "node:child_process"
import { platform } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync } from "node:fs"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
const root = join(__dirname, "..")
const isWin = platform() === "win32"
const ext = isWin ? ".exe" : ""

console.log("Building frontend (vite)...")
execSync("pnpm --filter @git-glance/desktop build", { stdio: "inherit", cwd: root })

console.log("Building Go server...")
mkdirSync(join(root, "dist"), { recursive: true })
execSync(
  `go build -C packages/server-go -o ${join(root, "dist", `git-glance-serve${ext}`)} .`,
  { stdio: "inherit", cwd: root },
)

console.log(`Done. Binary at dist/git-glance-serve${ext}`)
