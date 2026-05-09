# Electrobun Migration Plan

## Why Electrobun over Electron

| Aspect | Electron | Electrobun |
|--------|----------|------------|
| Bundle size | 150MB+ | ~14MB (ZSTD self-extracting) |
| Startup time | 2-5s | <50ms |
| Idle RAM | 100-200MB | 15-30MB |
| Renderer | Bundled Chromium (200MB C++) | System WebView (WebKit/WebView2) |
| Runtime | Node.js | **Bun** (same as our server) |
| IPC | `contextBridge` / `preload.cjs` | Built-in typed RPC (`electrobun/bun` ↔ `electrobun/view`) |
| Updates | `electron-updater` (100MB patches) | BSDIFF patches (~14KB) |
| Dev workflow | `electron-forge` + `vite` | `electrobun dev --watch` |

The project already runs on Bun everywhere. Electrobun keeps the entire stack Bun — no more Node.js dependency just for the GUI.

---

## Architecture

```
User launches Git Glance
         │
         ▼
  Electrobun app bundle (~14MB + server binary)
         │
         ▼
  Bun main process (packages/desktop/src/bun/index.ts)
         │
         ├── 1. Find server binary (bundled inside app)
         ├── 2. Bun.spawn(["git-glance-serve", "--port", "3456"])
         ├── 3. Wait for HTTP health check
         ├── 4. Create BrowserWindow → views://mainview/index.html
         │      (Solid.js app, loaded in system WebView)
         ├── 5. RPC bridge: selectDirectory, etc.
         │
         └── On before-quit → kill server, cleanup
```

No background service. No tray. No polling. Server lives only as long as the window is open.

---

## Migration: What Changes

### New files

| File | Purpose |
|------|---------|
| `packages/desktop/electrobun.config.ts` | Electrobun build config |
| `packages/desktop/src/bun/index.ts` | Main process (replaces Electron `main.js`) |
| `packages/desktop/src/shared/types.ts` | Typed RPC schema |
| `packages/desktop/scripts/post-build.ts` | Copies server binary into bundle |
| `packages/desktop/assets/` | App icons (`.png`, `.ico`) |

### Modified files

| File | Change |
|------|--------|
| `packages/app/ → packages/desktop/` | Rename directory |
| `packages/desktop/package.json` | Replace `electron`/`electron-builder` deps with `electrobun` |
| `packages/desktop/src/api.ts` or renderer files | Replace `window.electronAPI.*` with `electroview.rpc.*` |
| Root `package.json` | Add build scripts |
| `packages/server/src/config.ts` | Add `STATIC_DIR` env var for compiled binary |

### Files to remove

| File | Why |
|------|-----|
| `packages/app/main.js` | Replaced by `src/bun/index.ts` |
| `packages/app/preload.cjs` | No longer needed (RPC replaces contextBridge) |
| `packages/app/vite.config.ts` | Replaced by electrobun's built-in bundler |
| `packages/app/forge.config.ts` | No Electron Forge needed |
| `packages/app/electron-builder.config.ts` | No electron-builder needed |

---

## Key Code

### 1. Electrobun Config

```typescript
// packages/desktop/electrobun.config.ts
import type { ElectrobunConfig } from "electrobun"

export default {
  app: {
    name: "Git Glance",
    identifier: "com.gitglance.app",
    version: "0.1.0",
  },
  runtime: {
    exitOnLastWindowClosed: true,
  },
  build: {
    bun: {
      entrypoint: "src/bun/index.ts",
    },
    views: {
      mainview: {
        entrypoint: "src/renderer/index.tsx",
        external: ["solid-js"], // SolidJS is bundled by Vite, not Bun
      },
    },
    copy: {
      "src/renderer/index.html": "views/mainview/index.html",
      "src/renderer/assets/**/*": "views/mainview/assets/",
    },
    linux: {
      bundleCEF: true, // WebKitGTK limitations on some distros
    },
  },
  scripts: {
    postBuild: "./scripts/post-build.ts",
  },
  release: {
    baseUrl: "https://releases.gitglance.dev/",
  },
} satisfies ElectrobunConfig
```

### 2. Main Process (Bun)

```typescript
// packages/desktop/src/bun/index.ts
import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun"
import { Utils, Events } from "electrobun/bun"
import { join } from "node:path"
import { existsSync } from "node:fs"

const PORT = 3456

ApplicationMenu.setApplicationMenu([
  { submenu: [{ label: "Quit", role: "quit" }] },
  {
    label: "Edit",
    submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
    ],
  },
])

type DesktopRPC = {
  bun: RPCSchema<{
    requests: {
      selectDirectory: { params: {}; response: string | null }
    }
    messages: {}
  }>
  webview: RPCSchema<{
    requests: {}
    messages: {}
  }>
}

const rpc = BrowserView.defineRPC<DesktopRPC>({
  handlers: {
    requests: {
      selectDirectory: async () => {
        const result = await Utils.openFileDialog({
          canChooseDirectory: true,
          canChooseFiles: false,
          allowsMultipleSelection: false,
        })
        return result[0] ?? null
      },
    },
  },
})

function findServerBinary(): string {
  // Bundled alongside the app via postBuild hook
  const candidates = [
    join(import.meta.dir, "../git-glance-serve"),
    join(process.env.HOME!, ".git-glance", "git-glance-serve"),
    "git-glance-serve", // PATH fallback
  ]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  throw new Error("git-glance-serve binary not found")
}

async function waitForHealth(url: string, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {}
    await Bun.sleep(200)
  }
  throw new Error("Server did not start in time")
}

async function main() {
  const serverBinary = findServerBinary()
  const server = Bun.spawn([serverBinary, "--port", String(PORT)], {
    stdout: "inherit",
    stderr: "inherit",
  })

  await waitForHealth(`http://localhost:${PORT}/health`)

  const win = new BrowserWindow({
    title: "Git Glance",
    url: "views://mainview/index.html",
    rpc,
    frame: { width: 1100, height: 780 },
  })

  Events.on("before-quit", () => {
    server.kill(9)
  })
}

main()
```

### 3. RPC in the Renderer

```typescript
// In the Solid.js app — replaces window.electronAPI access
import { Electroview } from "electrobun/view"
import type { DesktopRPC } from "../shared/types"

const electroview = new Electroview<DesktopRPC>({})

// Usage:
const dir = await electroview.rpc.request.selectDirectory()
```

### 4. PostBuild Hook

```typescript
// packages/desktop/scripts/post-build.ts
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
```

---

## Build Pipeline

```bash
# 1. Install deps
pnpm install

# 2. Compile server binary (standalone, no node_modules)
bun build --compile \
  ./packages/server/src/index.ts \
  --outfile=dist/git-glance-serve

# 3. Compile TUI binary (optional)
bun build --compile \
  ./packages/tui/src/index.ts \
  --outfile=dist/git-glance-tui

# 4. Build desktop app
cd packages/desktop
electrobun build --env=stable
# Output: packages/desktop/artifacts/stable-linux-x64-GitGlanceSetup.tar.gz
#          (~14MB self-extracting bundle)

# Cross-platform: run step 4 on CI for each OS
```

### Root package.json scripts

```json
{
  "scripts": {
    "build:serve": "bun build --compile ./packages/server/src/index.ts --outfile=dist/git-glance-serve",
    "build:tui": "bun build --compile ./packages/tui/src/index.ts --outfile=dist/git-glance-tui",
    "build:desktop": "cd packages/desktop && electrobun build --env=stable",
    "dist": "pnpm build:serve && pnpm build:desktop"
  }
}
```

---

## Cross-Platform Notes

### Linux
- **Desktop**: Works out of box with system WebKitGTK. For reliability on varied distros, set `bundleCEF: true` (adds ~100MB on Linux only — the Electron alternative would add 200MB).
- **TUI**: Works natively via `@opentui/solid` — no changes needed.
- **Server**: Compiled binary works on any Linux x64/arm64.

### Windows
- **Desktop**: Uses system WebView2 (included in Windows 11, available as redistributable for Win 10).
- **TUI**: Works via `@opentui/solid` with Win32 console.
- **Server**: Compiled binary for Windows via `--target=bun-windows-x64-modern`.
- **Console**: Set `ELECTROBUN_CONSOLE=1` to see debug output in production builds.

### Build Matrix
| Platform | Arch | Desktop target | Need CEF? |
|----------|------|---------------|-----------|
| Linux | x64, arm64 | `linux-x64`, `linux-arm64` | Recommended |
| Windows | x64 | `win-x64` | No (WebView2) |

---

## Deployment

### Install
- Download self-extracting bundle (~14MB) from the releases host
- Double-click to install
- First launch auto-extracts (1-2s delay)
- Subsequent launches are instant (<50ms)

### Updates
- `Updater.checkForUpdate()` → fetches `update.json` from releases host
- If available: downloads ~14KB BSDIFF patch, applies it, relaunches
- Falls back to full download if patch chain is missing

### Install locations
```
Linux:  ~/.local/share/git-glance/     ← user data (config, cache)
        /opt/GitGlance/                ← app bundle

Windows:  %APPDATA%/git-glance/        ← user data
          %PROGRAMFILES%/GitGlance/    ← app bundle
```

---

## Migration Steps (Ordered)

- [ ] 1. Rename `packages/app/` → `packages/desktop/`
- [ ] 2. Create `packages/desktop/electrobun.config.ts`
- [ ] 3. Create `packages/desktop/src/bun/index.ts` (main process)
- [ ] 4. Create `packages/desktop/src/shared/types.ts` (RPC schema)
- [ ] 5. Create `packages/desktop/scripts/post-build.ts`
- [ ] 6. Add app icons to `packages/desktop/assets/`
- [ ] 7. Update renderer code: replace `window.electronAPI.*` with `electroview.rpc.*`
- [ ] 8. Update `packages/desktop/package.json` (replace Electron deps)
- [ ] 9. Add `STATIC_DIR` env var to `packages/server/src/config.ts`
- [ ] 10. Add build scripts to root `package.json`
- [ ] 11. Remove old files: `main.js`, `preload.cjs`, `vite.config.ts`, forge configs
- [ ] 12. Remove `packages/app/` from pnpm workspace if it conflicts
- [ ] 13. Update `pnpm-workspace.yaml` if needed
- [ ] 14. Test `pnpm build:serve` → verify server binary works standalone
- [ ] 15. Test `electrobun build --env=dev` → verify desktop app launches
- [ ] 16. Test `electrobun build --env=stable` → verify artifacts are generated
