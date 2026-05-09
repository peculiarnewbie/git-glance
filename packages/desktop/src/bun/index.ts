import { BrowserWindow, BrowserView, ApplicationMenu } from "electrobun/bun"
import { Utils, Events } from "electrobun/bun"
import type { RPCSchema } from "electrobun/bun"
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
  const candidates = [
    join(import.meta.dir, "../git-glance-serve"),
    join(process.env.HOME!, ".git-glance", "git-glance-serve"),
    "git-glance-serve",
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
  const server = Bun.spawn([serverBinary], {
    env: { ...process.env, PORT: String(PORT) },
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
