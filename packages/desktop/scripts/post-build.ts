import { join } from "node:path"
import { cpSync, existsSync } from "node:fs"

const buildDir = process.env.ELECTROBUN_BUILD_DIR
if (!buildDir) {
  console.error("ELECTROBUN_BUILD_DIR not set")
  process.exit(1)
}

const serverBinary = join(__dirname, "../../../dist/git-glance-serve")
const target = join(buildDir, "git-glance-serve")

if (!existsSync(serverBinary)) {
  console.error("Server binary not found at", serverBinary)
  console.error("Run 'bun run build:serve' first")
  process.exit(1)
}

cpSync(serverBinary, target)
console.log(`Copied server binary → ${target}`)
