// @ts-nocheck — OpenTUI core types are loose; Bun handles TSX natively
import { createCliRenderer, BoxRenderable, TextRenderable } from "@opentui/core"
import * as Schema from "effect/Schema"
import { GitRepo, ScanProgress } from "@git-glance/schema"

const SERVER_HOST = process.env["GIT_GLANCE_HOST"] ?? "http://localhost:3456"

// ─── Network helpers — all async work runs BEFORE the renderer ─────

async function fetchRepos(): Promise<Array<GitRepo>> {
  const res = await fetch(`${SERVER_HOST}/repos`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as { repos: Array<unknown> }
  return Schema.decodeUnknownSync(Schema.Array(GitRepo))(data.repos) as Array<GitRepo>
}

async function runScan(rootDir: string): Promise<[Array<GitRepo>, string | null]> {
  const repos: Array<GitRepo> = []
  try {
    const url = `${SERVER_HOST}/scan?rootDir=${encodeURIComponent(rootDir)}`
    const res = await fetch(url)
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
            if (event.phase === "scanning" && event.repo) {
              const idx = repos.findIndex(r => r.path === event.repo!.path)
              if (idx >= 0) repos[idx] = event.repo!
              else repos.push(event.repo!)
            }
          } catch { /* skip */ }
        }
      }
    }
  } catch (e) {
    return [repos, `Scan error: ${(e as Error).message}`]
  }
  return [repos, null]
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

// ─── App state ─────────────────────────────────────────────────────
interface AppState {
  repos: Array<GitRepo>
  selectedIndex: number
  staleOnly: boolean
  busy: boolean
}

const state: AppState = {
  repos: [],
  selectedIndex: 0,
  staleOnly: false,
  busy: false,
}

// TUI component refs
let renderer: any = null
let header: any = null
let titleRow: any = null
let listTitle: any = null
let detailTitle: any = null
let detailText: any = null
let statusText: any = null
const listItems: any[] = []
const MAX_VISIBLE = 200
let listPane: any = null
let detailPane: any = null

// ─── Build UI ──────────────────────────────────────────────────────

async function buildUI() {
  renderer = await createCliRenderer({ exitOnCtrlC: false })
  const root = renderer.root

  // ── Header ──
  header = new TextRenderable(renderer, {
    content: "",
    bold: true,
    backgroundColor: "#0055AA",
    color: "#FFFFFF",
    height: 1,
  })
  root.add(header)

  // ── Column titles ──
  titleRow = new TextRenderable(renderer, {
    content: " Repositories                           | Details",
    height: 1,
    color: "#888888",
    backgroundColor: "#222222",
  })
  root.add(titleRow)

  // ── Main content row with list + detail side-by-side ──
  const mainRow = new BoxRenderable(renderer, {
    flexDirection: "row",
    height: renderer.height - 3,
    shouldFill: true,
  })
  root.add(mainRow)

  // ── Left: List pane ──
  listPane = new BoxRenderable(renderer, {
    width: "50%",
    flexDirection: "column",
  })
  mainRow.add(listPane)

  // ── Pre-allocate repo list items ──
  for (let i = 0; i < MAX_VISIBLE; i++) {
    const item = new TextRenderable(renderer, {
      content: "",
      height: 1,
      visible: false,
    })
    listPane.add(item)
    listItems.push(item)
  }

  // ── Right: Detail pane ──
  detailPane = new BoxRenderable(renderer, {
    width: "50%",
    flexDirection: "column",
  })
  mainRow.add(detailPane)

  // ── Detail text ──
  detailText = new TextRenderable(renderer, {
    content: " No repo selected",
    color: "#666666",
  })
  detailPane.add(detailText)

  // ── Status bar ──
  statusText = new TextRenderable(renderer, {
    content: " [s]scan [r]refresh [j/k]nav [t]stale [p]pull [u]push [q]quit",
    backgroundColor: "#333333",
    color: "#AAAAAA",
    height: 1,
  })
  root.add(statusText)
}

// ─── Update display ────────────────────────────────────────────────

function updateAll() {
  const { repos, selectedIndex, staleOnly } = state

  const visible = staleOnly ? repos.filter((r) => r.behind > 0) : repos

  // Repo list items
  for (let i = 0; i < MAX_VISIBLE; i++) {
    if (i < visible.length) {
      const repo = visible[i]
      const selected = i === selectedIndex
      const prefix = repo.error ? "!" : repo.hasChanges ? "~" : "·"
      const arrow = selected ? "▸" : " "
      const branchStr = repo.branch ? ` (${repo.branch})` : ""
      const timeStr = timeAgo(repo.lastCommitTime)
      const remoteStr =
        repo.ahead > 0 && repo.behind > 0 ? ` ⇡${repo.ahead} ⇣${repo.behind}`
        : repo.ahead > 0 ? ` ⇡${repo.ahead}`
        : repo.behind > 0 ? ` ⇣${repo.behind}`
        : ""
      const line = ` ${arrow} ${prefix} ${repo.name}${branchStr}${remoteStr} ${timeStr}`
      listItems[i].content = line
      listItems[i].color = selected ? "#FFFFFF" : "#CCCCCC"
      listItems[i].backgroundColor = selected ? "#0055AA" : undefined
      listItems[i].visible = true
    } else {
      listItems[i].content = ""
      listItems[i].visible = false
    }
  }

  // Detail pane
  const repo = visible[selectedIndex]
  if (repo) {
    const statusLabel = repo.error
      ? `Error: ${repo.error}`
      : repo.hasChanges
        ? "Dirty"
        : "Clean"
    const remoteStr =
      repo.ahead > 0 || repo.behind > 0
        ? `\n Remote: ${repo.ahead > 0 ? `⇡${repo.ahead} ahead ` : ""}${repo.behind > 0 ? `⇣${repo.behind} behind` : ""}`
        : ""
    const remoteBranchStr = repo.remote ? `\n Upstream: ${repo.remote}` : ""
    detailText.content =
      ` ${repo.name}\n` +
      ` ${repo.path}\n` +
      `\n` +
      ` Branch: ${repo.branch ?? "N/A"}` +
      remoteBranchStr +
      `\n` +
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
  const dirty = repos.filter((r) => r.hasChanges).length
  const stale = repos.filter((r) => r.behind > 0).length
  header.content = ` ${repos.length} repos · ${dirty} dirty · ${stale} stale · ${repos.length - dirty} clean`

  // Title row showing list vs detail
  const listTitleText = state.staleOnly ? ` Stale (${visible.length})` : ` Repositories (${visible.length})`
  titleRow.content = ` ${listTitleText.padEnd(40)}${repo ? repo.name : ""}`
}

// ─── Scan ──────────────────────────────────────────────────────────

async function startScan() {
  renderer.destroy()
  // Clear all state refs
  header = null
  titleRow = null
  detailText = null
  statusText = null
  listItems.length = 0

  try {
    const [scanned, err] = await runScan(process.cwd())
    state.repos = scanned
    state.selectedIndex = 0
  } catch (e) {
    // ignore
  }

  await buildUI()
  updateAll()
}

// ─── Pull / Push ──────────────────────────────────────────────────────────

async function pullRepo() {
  if (state.busy) return
  const visible = state.staleOnly ? state.repos.filter((r) => r.behind > 0) : state.repos
  const repo = visible[state.selectedIndex]
  if (!repo) return
  state.busy = true
  try {
    const res = await fetch(`${SERVER_HOST}/pull?repo=${encodeURIComponent(repo.path)}`, { method: "POST" })
    const data = (await res.json()) as { ok: boolean; error?: string }
    if (data.ok) {
      statusText.content = ` Pulled ${repo.name} successfully`
    } else {
      statusText.content = ` Pull failed: ${data.error ?? "unknown"}`
    }
    state.repos = await fetchRepos()
  } catch (e) {
    statusText.content = ` Pull error: ${(e as Error).message}`
  } finally {
    state.busy = false
    updateAll()
  }
}

async function pushRepo() {
  if (state.busy) return
  const visible = state.staleOnly ? state.repos.filter((r) => r.behind > 0) : state.repos
  const repo = visible[state.selectedIndex]
  if (!repo) return
  state.busy = true
  try {
    const res = await fetch(`${SERVER_HOST}/push?repo=${encodeURIComponent(repo.path)}`, { method: "POST" })
    const data = (await res.json()) as { ok: boolean; error?: string }
    if (data.ok) {
      statusText.content = ` Pushed ${repo.name} successfully`
    } else {
      statusText.content = ` Push failed: ${data.error ?? "unknown"}`
    }
    state.repos = await fetchRepos()
  } catch (e) {
    statusText.content = ` Push error: ${(e as Error).message}`
  } finally {
    state.busy = false
    updateAll()
  }
}

// ─── Main entry ────────────────────────────────────────────────────

async function main() {
  // Fetch initial data (before renderer blocks async)
  try {
    state.repos = await fetchRepos()
  } catch (e) {
    // will show error in UI
  }

  await buildUI()
  updateAll()

  // Keyboard handler (sync only!)
  renderer.keyInput.on("keypress", (key: any) => {
    if (key.name === "q" || key.name === "escape") process.exit(0)

    if (key.name === "r") {
      renderer.destroy()
      fetchRepos()
        .then((data) => {
          state.repos = data
          state.selectedIndex = 0
          return buildUI()
        })
        .then(() => updateAll())
        .catch(() => process.exit(1))
    }

    if (key.name === "s") {
      startScan()
    }

    if (key.name === "up" || key.name === "k") {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1)
      updateAll()
    }
    if (key.name === "down" || key.name === "j") {
      const visible = state.staleOnly ? state.repos.filter((r) => r.behind > 0) : state.repos
      state.selectedIndex = Math.min(visible.length - 1, state.selectedIndex + 1)
      updateAll()
    }
    if (key.name === "t") {
      state.staleOnly = !state.staleOnly
      state.selectedIndex = 0
      updateAll()
    }
    if (key.name === "p") pullRepo()
    if (key.name === "u") pushRepo()
  })
}

main()
