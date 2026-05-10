import Electrobun from "electrobun/bun"
import type { DesktopRPC } from "../shared/types"

const { BrowserWindow, BrowserView, ApplicationMenu, Utils } = Electrobun

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

new BrowserWindow({
  title: "Git Glance (dev)",
  url: "http://localhost:8912",
  rpc,
  frame: { width: 1100, height: 780 },
})

Electrobun.events.on("before-quit", () => {
  process.exit(0)
})
