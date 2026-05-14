const BASE = ""

let ws: WebSocket | null = null
let pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
let subscriptions = new Map<string, Set<(data: any) => void>>()
let idCounter = 0

function connect(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws?.readyState === WebSocket.OPEN) return resolve()
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const host = location.host
    const url = `${protocol}//${host}/ws`
    ws = new WebSocket(url)
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error("WebSocket connection failed"))
    ws.onclose = () => {
      ws = null
      for (const [, p] of pending) p.reject(new Error("Connection closed"))
      pending.clear()
    }
    ws.onmessage = (msg) => {
      try {
        const { id, type, data, error } = JSON.parse(msg.data)
        if (type === "result") {
          const p = pending.get(id)
          if (p) { p.resolve(data); pending.delete(id) }
        } else if (type === "error") {
          const p = pending.get(id)
          if (p) { p.reject(new Error(error)); pending.delete(id) }
          const subs = subscriptions.get(id)
          if (subs) { for (const fn of subs) fn({ type: "error", error }); subscriptions.delete(id) }
        } else if (type === "progress") {
          subscriptions.get(id)?.forEach(fn => fn(data))
        } else if (type === "done") {
          subscriptions.get(id)?.forEach(fn => fn({ type: "done" }))
          subscriptions.delete(id)
        }
      } catch {}
    }
  })
}

async function send<T>(action: string, params?: Record<string, any>): Promise<T> {
  await connect()
  const id = String(++idCounter)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws!.send(JSON.stringify({ id, action, params }))
  })
}

function subscribe(action: string, params: Record<string, any> | undefined, onEvent: (data: any) => void): AbortController {
  const controller = new AbortController()
  connect().then(() => {
    if (controller.signal.aborted) return
    const id = String(++idCounter)
    const subs = new Set([onEvent])
    subscriptions.set(id, subs)
    ws!.send(JSON.stringify({ id, action, params }))
    controller.signal.addEventListener("abort", () => {
      subscriptions.delete(id)
      const cancelAction = "cancel" + action.charAt(0).toUpperCase() + action.slice(1)
      send(cancelAction).catch(() => {})
    })
  })
  return controller
}

// ─── Public API ──────────────────────────────────────────────────────

export interface RepoData {
  name: string; path: string; branch: string | null; hasChanges: boolean
  staged: number; unstaged: number; untracked: number
  ahead: number; behind: number; remote: string | null
  lastCommitTime: number | null; weekCommits: number; lastScanTime: number | null
  error: string | null; machine: string
  settings: { skipUntracked: boolean; skipPullCheck: boolean; hidden: boolean } | null
}

export interface ReposResponse {
  repos: RepoData[]; scannedAt: number; scannedDirs: string[]
  machines: { name: string; url: string; online: boolean; lastSeen: number | null }[]
}

export interface ServerConfigResponse {
  rootDir: string | null; opencodeModel: string
  machines: { name: string; url: string; online: boolean }[]
}

export interface ProgressEvent {
  phase: string; current: number; total: number
  repo?: RepoData; repoPath?: string; repoName?: string
}

export interface CommitEvent {
  phase: string; error?: string; subject?: string; body?: string; repoPath?: string
}

export interface FetchEvent {
  phase: string; repoPath?: string; repoName?: string
  current: number; total: number; ahead?: number; behind?: number
  branch?: string; error?: string
}

export const api = {
  getRepos: (): Promise<ReposResponse> => send<ReposResponse>("getRepos"),

  getConfig: (): Promise<ServerConfigResponse> => send<ServerConfigResponse>("getConfig"),

  setConfig: (config: { rootDir?: string; opencodeModel?: string; machines?: { name: string; url: string }[] }): Promise<void> =>
    send("setConfig", config),

  pullRepo: (repo: string, machine?: string): Promise<{ ok: boolean; output?: string; error?: string }> =>
    send("pull", { repo, machine }),

  pushRepo: (repo: string, machine?: string): Promise<{ ok: boolean; output?: string; error?: string }> =>
    send("push", { repo, machine }),

  updateRepoSettings: (repo: string, settings: { skipUntracked?: boolean; skipPullCheck?: boolean; hidden?: boolean }): Promise<void> =>
    send("updateRepoSettings", { repo, ...settings }),

  cancelScan: (): Promise<void> => send("cancelScan").then(() => {}),
  cancelCommit: (): Promise<void> => send("cancelCommit").then(() => {}),
  cancelFetch: (): Promise<void> => send("cancelFetch").then(() => {}),

  subscribeScan: (rootDir: string, onEvent: (ev: ProgressEvent) => void, onError?: () => void): AbortController =>
    subscribe("scan", { rootDir }, (data) => {
      if (data.type === "error") { onError?.(); return }
      if (data.type === "done") return
      onEvent(data)
    }),

  subscribeCommitPush: (repo: string, onEvent: (ev: CommitEvent) => void): AbortController =>
    subscribe("commitPush", { repo }, (data) => {
      if (data.type === "done") return
      onEvent(data)
    }),

  subscribeScanOnly: (rootDir: string, onEvent: (ev: ProgressEvent) => void, onError?: () => void): AbortController =>
    subscribe("scanOnly", { rootDir }, (data) => {
      if (data.type === "error") { onError?.(); return }
      if (data.type === "done") return
      onEvent(data)
    }),

  rescanRepo: (repo: string): Promise<{ ok: boolean; repo?: RepoData; error?: string }> =>
    send("rescanRepo", { repo }),

  checkPull: (repo: string): Promise<{ ok: boolean; repo?: RepoData; error?: string }> =>
    send("checkPull", { repo }),

  subscribeFetch: (onEvent: (ev: FetchEvent) => void): AbortController =>
    subscribe("fetchAll", undefined, (data) => {
      if (data.type === "done") return
      onEvent(data)
    }),

  // Effect wrappers for backward compat with App.tsx
  pullRepoEffect: (repo: string, machine?: string) =>
    ({ _tag: "effect", name: "pull", repo, machine } as any),

  pushRepoEffect: (repo: string, machine?: string) =>
    ({ _tag: "effect", name: "push", repo, machine } as any),

  rescanRepoEffect: (repo: string) =>
    ({ _tag: "effect", name: "rescanRepo", repo } as any),

  checkPullEffect: (repo: string) =>
    ({ _tag: "effect", name: "checkPull", repo } as any),
}

export function runUiEffect<A>(
  effect: any,
  handlers: {
    readonly onSuccess?: (value: A) => void | Promise<void>
    readonly onFailure?: (error: Error) => void
    readonly onFinally?: () => void
  },
): void {
  if (effect._tag !== "effect") return
  const { name, ...params } = effect
  send<A>(name, params)
    .then(async (result) => { await handlers.onSuccess?.(result) })
    .catch((e) => handlers.onFailure?.(e instanceof Error ? e : new Error(String(e))))
    .finally(() => handlers.onFinally?.())
}

export function repoDataToInfo(r: RepoData): RepoInfo {
  return {
    path: r.path, name: r.name, machine: r.machine, cached: false,
    skipUntracked: r.settings?.skipUntracked ?? false,
    skipPullCheck: r.settings?.skipPullCheck ?? false,
    hidden: r.settings?.hidden ?? false,
    status: {
      branch: r.branch || "", remote: r.remote || null,
      hasChanges: r.hasChanges, staged: r.staged, unstaged: r.unstaged,
      untracked: r.untracked, ahead: r.ahead, behind: r.behind,
      lastCommitTime: r.lastCommitTime, weekCommits: r.weekCommits,
      error: r.error || undefined,
    },
  }
}

interface GitStatus {
  branch: string; remote: string | null; hasChanges: boolean
  staged: number; unstaged: number; untracked: number
  ahead: number; behind: number; lastCommitTime: number | null
  weekCommits: number; error?: string
}

export interface RepoInfo {
  path: string; name: string; machine: string; cached: boolean
  status: GitStatus
  skipUntracked?: boolean; skipPullCheck?: boolean; hidden?: boolean
}
