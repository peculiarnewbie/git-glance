import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show, createMemo } from "solid-js"
import * as Schema from "effect/Schema"
import { GitRepo, ScanProgress } from "@git-glance/schema"

// ─── Config ──────────────────────────────────────────────────────────
const SERVER_HOST = process.env["GIT_GLANCE_HOST"] ?? "http://localhost:3456"

// ─── HTTP helpers ────────────────────────────────────────────────────

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

// ─── App ─────────────────────────────────────────────────────────────

function App() {
  const dims = useTerminalDimensions()
  const [repos, setRepos] = createSignal<Array<GitRepo>>([])
  const [selectedIdx, setSelectedIdx] = createSignal(0)
  const [scanning, setScanning] = createSignal(false)
  const [scanProgress, setScanProgress] = createSignal({ current: 0, total: 0 })
  const [error, setError] = createSignal<string | null>(null)
  const [statusMsg, setStatusMsg] = createSignal("Press [s] to start scan")

  let abortController: AbortController | null = null

  // ── Load cached repos on mount ──
  fetchRepos()
    .then((data) => {
      setRepos(data)
      setStatusMsg(`${data.length} repos · ${data.filter((r) => r.hasChanges).length} dirty`)
    })
    .catch((e) => {
      setError(`Server unreachable: ${(e as Error).message}`)
      setStatusMsg("Server unreachable — press [r] to retry")
    })

  // ── Keyboard ──
  useKeyboard((key) => {
    if (key.name === "q") process.exit(0)
    if (key.name === "r") {
      setError(null)
      setStatusMsg("Loading...")
      fetchRepos()
        .then((data) => {
          setRepos(data)
          setStatusMsg(`${data.length} repos · ${data.filter((r) => r.hasChanges).length} dirty`)
        })
        .catch((e) => setError(`Server unreachable: ${(e as Error).message}`))
    }
    if (key.name === "s" && !scanning()) startScan()
    if (key.name === "c" && scanning()) cancelScan()

    if (key.name === "up" || key.name === "k") {
      setSelectedIdx((i) => Math.max(0, i - 1))
    }
    if (key.name === "down" || key.name === "j") {
      setSelectedIdx((i) => Math.min(repos().length - 1, i + 1))
    }
  })

  // ── Scan ──
  async function startScan() {
    setScanning(true)
    setScanProgress({ current: 0, total: 0 })
    setError(null)
    abortController = new AbortController()

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
                setScanProgress({ current: 0, total: event.total })
                setStatusMsg(`Discovering repos... (${event.total} found)`)
              } else if (event.phase === "scanning" && event.repo) {
                setScanProgress({ current: event.current, total: event.total })
                setRepos((prev) => {
                  const idx = prev.findIndex((r) => r.path === event.repo!.path)
                  if (idx >= 0) {
                    const next = [...prev]
                    next[idx] = event.repo!
                    return next
                  }
                  return [...prev, event.repo!]
                })
              } else if (event.phase === "done") {
                setScanning(false)
                setScanProgress({ current: 0, total: 0 })
              }
            } catch {
              // skip malformed events
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError(`Scan error: ${(e as Error).message}`)
      }
    } finally {
      setScanning(false)
      abortController = null
    }
  }

  function cancelScan() {
    abortController?.abort()
    abortController = null
    setScanning(false)
  }

  const selectedRepo = createMemo(() => repos()[selectedIdx()])
  const listWidth = () => Math.floor(dims().width / 2) - 1

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        height: "100%",
      }}
    >
      {/* Header */}
      <box height={1}>
        <text bold bg="#0055AA">
          {scanning()
            ? ` Scanning ${scanProgress().current}/${scanProgress().total}`
            : " Git Glance"}
        </text>
      </box>

      {/* Main content area */}
      <box style={{ flexDirection: "row", height: dims().height - 3 }}>
        {/* Left: repo list */}
        <scrollbox
          title=" Repositories "
          style={{ width: listWidth() }}
        >
          <For each={repos()}>
            {(repo, i) => {
              const selected = i() === selectedIdx()
              return (
                <text
                  bg={selected ? "#00AAFF" : undefined}
                  height={1}
                >
                  <text fg={repo.error ? "#FF4444" : repo.hasChanges ? "#FFAA00" : "#44CC44"}>
                    {repo.error ? "!" : repo.hasChanges ? "~" : "·"}
                  </text>{" "}
                  {repo.name}{" "}
                  <text fg="#666666">
                    {repo.branch ? `(${repo.branch})` : ""} {timeAgo(repo.lastCommitTime)}
                  </text>
                </text>
              )
            }}
          </For>
          <Show when={repos().length === 0 && !error()}>
            <text fg="#666666"> No repos loaded. Press [s] to scan.</text>
          </Show>
          <Show when={error()}>
            <text fg="#FF4444"> {error()}</text>
          </Show>
        </scrollbox>

        {/* Right: detail pane */}
        <box
          title=" Details "
          style={{
            flexDirection: "column",
            padding: { left: 1 },
          }}
        >
          <Show when={selectedRepo()} fallback={<text fg="#666666"> No repo selected</text>}>
            {(repo) => {
              const r = repo()
              return (
                <>
                  <text bold>{r.name}</text>
                  <text fg="#888888"> {r.path}</text>
                  <text> </text>
                  <text>Branch: <text fg="#88CCFF">{r.branch ?? "N/A"}</text></text>
                  <text>
                    Status:{" "}
                    {r.error
                      ? <text fg="#FF4444">Error: {r.error}</text>
                      : r.hasChanges
                      ? <text fg="#FFAA00">Dirty</text>
                      : <text fg="#44CC44">Clean</text>}
                  </text>
                  <text> </text>
                  <text bold>Changes:</text>
                  <text>  Staged:    {r.staged}</text>
                  <text>  Unstaged:  {r.unstaged}</text>
                  <text>  Untracked: {r.untracked}</text>
                  <Show when={r.ahead > 0 || r.behind > 0}>
                    <text>
                      Remote: {r.ahead > 0 ? <text fg="#44CC44">+{r.ahead} </text> : ""}
                      {r.behind > 0 ? <text fg="#FFAA00">-{r.behind}</text> : ""}
                    </text>
                  </Show>
                  <text> </text>
                  <text fg="#888888">Last commit: {timeAgo(r.lastCommitTime)}</text>
                  <text fg="#888888">Weekly commits: {r.weekCommits}</text>
                </>
              )
            }}
          </Show>
        </box>
      </box>

      {/* Status bar */}
      <box height={1}>
        <text bg="#333333">
          {" "}
          {statusMsg()}{"  "}
          <text fg="#888888">
            [s]scan [r]refresh [j/k]nav [c]cancel [q]quit
          </text>
        </text>
      </box>
    </box>
  )
}

render(() => <App />)
