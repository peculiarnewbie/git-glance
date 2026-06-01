import { join } from "node:path"
import { cpSync, existsSync } from "node:fs"
import { platform } from "node:os"

const buildDir = process.env.ELECTROBUN_BUILD_DIR
if (!buildDir) {
  console.error("ELECTROBUN_BUILD_DIR not set")
  process.exit(1)
}

const isWin = platform() === "win32"
const ext = isWin ? ".exe" : ""
const binaryName = `git-glance-serve${ext}`

const serverBinary = join(__dirname, "../../../dist", binaryName)
const target = join(buildDir, binaryName)

if (!existsSync(serverBinary)) {
  console.error("Server binary not found at", serverBinary)
  console.error("Run 'pnpm build' first")
  process.exit(1)
}

cpSync(serverBinary, target)
console.log(`Copied server binary → ${target}`)
