import { existsSync, cpSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";

const root = join(import.meta.dir, "..");
const frontendDir = join(root, "..", "desktop", "renderer-dist");
const distDir = join(root, "dist");
const outputBinary = join(distDir, "server-bun");
const outputFrontend = join(distDir, "renderer-dist");

if (!existsSync(frontendDir)) {
  console.log("Building frontend...");
  execSync("pnpm --filter @git-glance/desktop build", { stdio: "inherit", cwd: root });
}

mkdirSync(distDir, { recursive: true });

execSync(
  `bun build main.ts --compile --minify --target=bun --outfile ${outputBinary}`,
  { stdio: "inherit", cwd: root },
);

// Remove old frontend copy, copy fresh
rmSync(outputFrontend, { recursive: true, force: true });
cpSync(frontendDir, outputFrontend, { recursive: true });

console.log(`Done. dist/ contents:`);
console.log(`  ${outputBinary}`);
console.log(`  ${outputFrontend}/`);
