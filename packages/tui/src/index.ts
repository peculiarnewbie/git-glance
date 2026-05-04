// @ts-nocheck — OpenTUI core types are loose; Bun handles TSX natively
import { createCliRenderer, Box, Text } from "@opentui/core"
import type { Box as BoxType, Text as TextType } from "@opentui/core"

// OpenTUI types are loose — cast to any for runtime properties
type FlexBox = BoxType & { flexDirection?: string; border?: boolean; title?: string; padding?: any; visible?: boolean }
type FlexText = TextType & { bold?: boolean; backgroundColor?: string; visible?: boolean; remove?: () => void }
import * as Schema from "effect/Schema"
import { GitRepo, ScanProgress } from "@git-glance/schema"

const SERVER_HOST = process.env["GIT_GLANCE_HOST"] ?? "http://localhost:3456"

async function fetchRepos(): Promise<Array<GitRepo>> {
  const res = await fetch(`${SERVER_HOST}/repos`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { repos: Array<unknown> }
  return Schema.decodeUnknownSync(Schema.Array(GitRepo))(data.repos) as Array<GitRepo>
}

function timeAgo(ts: number | null): string {
  if (!ts) return "never"
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

interface AppState {
  repos: Array<GitRepo>
  selectedIndex: number
  scanning: boolean
  current: number
  total: number
}

const state: AppState = {
  repos: [],
  selectedIndex: 0,
  scanning: false,
  current: 0,
  total: 0,
}

let abortController: AbortController | null = null

;(async () => {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  const root = renderer.root

  // ── Header ──
  const header = new Text({
    content: " Git Glance — connecting...",
    bold: true,
    backgroundColor: "#0055AA",
    color: "#FFFFFF",
    height: 1,
  })
  root.add(header)

  // ── Main area ──
  const mainArea = new Box({
    height: renderer.height - 3,
    flexDirection: "row",
  })
  root.add(mainArea)

  // ── Left: repo list (pre-allocated items) ──
  const listBox = new Box({
    width: Math.floor(renderer.width / 2) - 1,
    flexDirection: "column",
    border: true,
    title: " Repositories ",
  })
  mainArea.add(listBox)

  const MAX_LIST = 500
  const listItems: Text[] = []
  for (let i = 0; i < MAX_LIST; i++) {
    const item = new Text({ content: "", height: 1, visible: false })
    listBox.add(item)
    listItems.push(item)
  }

  // ── Right: detail pane via multiline Text ──
  const detailText = new Text({
    content: "",
    height: renderer.height - 5,
    width: Math.ceil(renderer.width / 2) - 1,
  })
  mainArea.add(detailText)

  // ── Status bar ──
  const statusText = new Text({
    content: " [s]scan [r]refresh [j/k]nav [c]cancel [q]quit",
    backgroundColor: "#333333",
    color: "#AAAAAA",
    height: 1,
  })
  root.add(statusText)

  // ── Update functions ──
  function updateAll() {
    // Repo list
    for (let i = 0; i < MAX_LIST; i++) {
      if (i < state.repos.length) {
        const repo = state.repos[i]!
        const selected = i === state.selectedIndex
        const prefix = repo.error ? "!" : repo.hasChanges ? "~" : "·"
        const color = repo.error ? "#FF4444" : repo.hasChanges ? "#FFAA00" : "#44CC44"
        listItems[i]!.content = ` ${prefix} ${repo.name}${repo.branch ? ` (${repo.branch})` : ""} ${timeAgo(repo.lastCommitTime)}`
        listItems[i]!.color = selected ? "#000000" : "#CCCCCC"
        listItems[i]!.backgroundColor = selected ? "#00AAFF" : undefined
        listItems[i]!.visible = true
      } else {
        listItems[i]!.visible = false
      }
    }

    // Detail pane
    const repo = state.repos[state.selectedIndex]
    if (repo) {
      const statusColor = repo.error ? "#FF4444" : repo.hasChanges ? "#FFAA00" : "#44CC44"
      const statusLabel = repo.error ? `Error: ${repo.error}` : repo.hasChanges ? "Dirty" : "Clean"
      const remoteStr = repo.ahead > 0 || repo.behind > 0
        ? `\n Remote: ${repo.ahead > 0 ? `+${repo.ahead} ` : ""}${repo.behind > 0 ? `-${repo.behind}` : ""}`
        : ""

      detailText.content =
        ` ${repo.name}\n` +
        ` ${repo.path}\n` +
        `\n` +
        ` Branch: ${repo.branch ?? "N/A"}\n` +
        ` Status: ${statusLabel}\n` +
        `\n` +
        ` Changes:\n` +
        `   Staged:    ${repo.staged}\n` +
        `   Unstaged:  ${repo.unstaged}\n` +
        `   Untracked: ${repo.untracked}` +
        remoteStr +
        `\n` +
        `\n` +
        ` Last commit: ${timeAgo(repo.lastCommitTime)}\n` +
        ` Weekly commits: ${repo.weekCommits}`
      detailText.color = "#CCCCCC"
    } else {
      detailText.content = " No repo selected"
      detailText.color = "#666666"
    }

    // Header
    if (state.scanning) {
      header.content = state.total > 0
        ? ` Scanning ${state.current}/${state.total} (${Math.round((state.current / state.total) * 100)}%)`
        : " Discovering repos..."
    } else {
      const dirty = state.repos.filter(r => r.hasChanges).length
      header.content = ` ${state.repos.length} repos · ${dirty} dirty · ${state.repos.length - dirty} clean`
    }
  }

  // ── Scan ──
  async function startScan() {
    if (state.scanning) return
    state.scanning = true
    state.current = 0
    state.total = 0
    abortController = new AbortController()
    updateAll()

    try {
      const url = `${SERVER_HOST}/scan?rootDir=${encodeURIComponent(process.cwd())}`
      const res = await fetch(url, { signal: abortController.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split("\n")
        buf = lines.pop() ?? ""

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6))
              const event = Schema.decodeUnknownSync(ScanProgress)(data)

              if (event.phase === "discovering") {
                state.current = 0
                state.total = event.total
              } else if (event.phase === "scanning" && event.repo) {
                state.current = event.current
                state.total = event.total
                const idx = state.repos.findIndex(r => r.path === event.repo!.path)
                if (idx >= 0) state.repos[idx] = event.repo!
                else state.repos.push(event.repo!)
                updateAll()
              } else if (event.phase === "done") {
                state.scanning = false
                updateAll()
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        statusText.content = ` Scan error: ${(e as Error).message}`
      }
    } finally {
      state.scanning = false
      abortController = null
      updateAll()
    }
  }

  function cancelScan() {
    abortController?.abort()
    abortController = null
    state.scanning = false
    updateAll()
  }

  // ── Key handler ──
  renderer.keyInput.on("keypress", (key: any) => {
    if (key.name === "q" || key.name === "escape") process.exit(0)

    if (key.name === "r") {
      fetchRepos()
        .then((data) => {
          state.repos = data
          state.selectedIndex = 0
          updateAll()
        })
        .catch((e) => { statusText.content = ` Server unreachable: ${(e as Error).message}` })
    }

    if (key.name === "s" && !state.scanning) startScan()
    if (key.name === "c" && state.scanning) cancelScan()

    if (key.name === "up" || key.name === "k") {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1)
      updateAll()
    }
    if (key.name === "down" || key.name === "j") {
      state.selectedIndex = Math.min(state.repos.length - 1, state.selectedIndex + 1)
      updateAll()
    }
  })

  // ── Load ──
  try {
    state.repos = await fetchRepos()
  } catch (e) {
    statusText.content = ` Server unreachable: ${(e as Error).message}`
  }
  updateAll()
})()
