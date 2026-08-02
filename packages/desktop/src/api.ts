import { Effect } from "effect"

function logInfo(msg: string, extra?: Record<string, unknown>) {
  Effect.runFork(extra ? Effect.annotateLogs(Effect.logInfo(msg), extra) : Effect.logInfo(msg))
}
function logWarn(msg: string, extra?: Record<string, unknown>) {
  Effect.runFork(extra ? Effect.annotateLogs(Effect.logWarning(msg), extra) : Effect.logWarning(msg))
}
function logError(msg: string, extra?: Record<string, unknown>) {
  Effect.runFork(extra ? Effect.annotateLogs(Effect.logError(msg), extra) : Effect.logError(msg))
}

export type AuthState = "loading" | "authenticated" | "unauthenticated"

export interface SessionResponse {
  user: { email: string }
}

export async function checkSession(): Promise<{ state: "authenticated"; email: string } | { state: "unauthenticated" } | { state: "local" }> {
  try {
    const res = await fetch("/api/session")
    if (res.ok) {
      const data: SessionResponse = await res.json()
      return { state: "authenticated", email: data.user.email }
    }
    return { state: "unauthenticated" }
  } catch {
    return { state: "local" }
  }
}

export function login() {
  window.location.href = "/api/auth/login"
}

export async function logout() {
  await fetch("/api/auth/logout", { method: "POST" })
  window.location.href = "/"
}

const BASE = ""

let ws: WebSocket | null = null
let pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void }>()
let subscriptions = new Map<string, Set<(data: any) => void>>()
let machineHandlers = new Set<(machines: { name: string; online: boolean; lastSeen: number | null }[]) => void>()
let reposUpdateHandlers = new Set<(repos: any[], agentId: string) => void>()
let idCounter = 0

let connectPromise: Promise<void> | null = null

function connect(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN) return Promise.resolve()
  if (connectPromise) return connectPromise
  connectPromise = new Promise((resolve, reject) => {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:"
    const host = location.host
    const url = `${protocol}//${host}/ws`
    logInfo("[ws] connecting", { url })
    ws = new WebSocket(url)
    ws.onopen = () => {
      logInfo("[ws] connected")
      connectPromise = null
      resolve()
    }
    ws.onerror = (ev) => {
      logError("[ws] connection error")
      connectPromise = null
      reject(new Error("WebSocket connection failed"))
    }
    ws.onclose = (ev) => {
      logWarn("[ws] closed", { code: ev.code, reason: ev.reason })
      connectPromise = null
      ws = null
      for (const [, p] of pending) p.reject(new Error("Connection closed"))
      pending.clear()
      for (const [, subs] of subscriptions) {
        for (const fn of subs) fn({ type: "error", error: "Connection closed" })
      }
      subscriptions.clear()
    }
    ws.onmessage = (msg) => {
      try {
        const msgData = JSON.parse(msg.data)
        const { id, type, data, error } = msgData
        const recvExtra: Record<string, unknown> = { id, type }
        if (error !== undefined) recvExtra.error = error
        if (data !== undefined && type !== "result") {
          const { phase, current, total } = data
          if (phase !== undefined) recvExtra.phase = phase
          if (current !== undefined) recvExtra.current = current
          if (total !== undefined) recvExtra.total = total
        }
        if (import.meta.env.DEV) logInfo("[ws] recv", recvExtra)
        if (type === "result") {
          const p = pending.get(id)
          if (p) { p.resolve(data); pending.delete(id) }
        } else if (type === "error") {
          logError("[ws] recv error", { id, error, data })
          const p = pending.get(id)
          if (p) { p.reject(new Error(error)); pending.delete(id) }
          const subs = subscriptions.get(id)
          if (subs) { for (const fn of subs) fn({ type: "error", error }); subscriptions.delete(id) }
        } else if (type === "progress") {
          subscriptions.get(id)?.forEach(fn => fn(data))
        } else if (type === "done") {
          subscriptions.get(id)?.forEach(fn => fn({ type: "done" }))
          subscriptions.delete(id)
        } else if (type === "ack") {
          subscriptions.get(id)?.forEach(fn => fn({ type: "ack", agentId: msgData.agentId, action: msgData.action }))
        } else if (type === "machines") {
          machineHandlers.forEach(fn => fn(data?.machines ?? data))
        } else if (type === "repos_update") {
          reposUpdateHandlers.forEach(fn => fn(data?.repos ?? msgData.repos ?? data, data?.agentId ?? msgData.agentId))
        }
      } catch (e) { logError("[ws] parse error", { error: String(e) }) }
    }
  })
  return connectPromise
}

async function send<T>(action: string, params?: Record<string, any>): Promise<T> {
  await connect()
  const id = String(++idCounter)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws!.send(JSON.stringify({ id, action, params }))
  })
}

function subscribe(
  action: string,
  params: Record<string, any> | undefined,
  onEvent: (data: any) => void,
  cancelAction = "cancel",
): AbortController {
  const controller = new AbortController()
  connect().then(() => {
    if (controller.signal.aborted) return
    const id = String(++idCounter)
    const subs = new Set([onEvent])
    subscriptions.set(id, subs)
    ws!.send(JSON.stringify({ id, action, params }))
    controller.signal.addEventListener("abort", () => {
      subscriptions.delete(id)
      send(cancelAction, { targetRequestId: id }).catch((e) => logError("[ws] cancel failed", { action, cancelAction, targetRequestId: id, error: String(e) }))
    })
  })
  return controller
}

// ─── Public API ──────────────────────────────────────────────────────

export interface FileStatus {
  path: string;
  status: string; // XY porcelain chars: "M ", "A ", " D", "??", "R ", "D ", etc.
}

export interface RepoData {
  name: string; path: string; branch: string | null; hasChanges: boolean
  staged: number; stagedFiles: FileStatus[]; unstaged: number; unstagedFiles: FileStatus[]
  untracked: number; untrackedFiles: FileStatus[]
  ahead: number; behind: number; remote: string | null
  lastCommitTime: number | null; weekCommits: number; lastScanTime: number | null
  error: string | null; machine: string
  settings: { skipUntracked: boolean; skipPullCheck: boolean; autoPullIfClean: boolean; hidden: boolean; pinned: boolean } | null
}

// Derive RepoInfo from the schema of truth (WebSocket response)
export type RepoName = RepoData['name'];
export type RepoPath = RepoData['path'];
export type RepoBranch = RepoData['branch'];
export type RepoRemote = RepoData['remote'];
export type RepoError = RepoData['error'];

// This is the source of truth - derived from WebSocket response schema
export interface RepoInfo {
  path: RepoPath;
  name: RepoName;
  machine: RepoName;
  cached: boolean;
  status: {
    branch: RepoBranch;
    remote: RepoRemote;
    hasChanges: boolean;
    staged: number;
    stagedFiles: FileStatus[];
    unstaged: number;
    unstagedFiles: FileStatus[];
    untracked: number;
    untrackedFiles: FileStatus[];
    ahead: number;
    behind: number;
    lastCommitTime: number | null;
    weekCommits: number;
    error?: RepoError;
  };
  skipUntracked?: boolean;
  skipPullCheck?: boolean;
  autoPullIfClean?: boolean;
  hidden?: boolean;
  pinned?: boolean;
}

export interface ReposResponse {
  repos: RepoData[]; scannedAt: number; scannedDirs: string[]
  machines: { name: string; url: string; online: boolean; lastSeen: number | null }[]
}

export interface ServerConfigResponse {
  rootDir: string | null; opencodeModel: string; token?: string
  excludedDirs?: string[]
  machines: { name: string; url: string; token?: string; online: boolean }[]
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
  branch?: string; error?: string; repo?: RepoData
}

export const api = {
  getRepos: (): Promise<ReposResponse> => send<ReposResponse>("getRepos"),

  getConfig: (): Promise<ServerConfigResponse> => send<ServerConfigResponse>("getConfig"),

  setConfig: (config: { rootDir?: string; opencodeModel?: string; excludedDirs?: string[]; machines?: { name: string; url: string; token?: string }[] }): Promise<void> =>
    send("setConfig", config),

  pullRepo: (repo: RepoPath, machine?: string): Promise<{ ok: boolean; output?: string; error?: string }> =>
    send("pull", { repo, machine }),

  pushRepo: (repo: RepoPath, machine?: string): Promise<{ ok: boolean; output?: string; error?: string }> =>
    send("push", { repo, machine }),

  updateRepoSettings: (repo: RepoPath, settings: { skipUntracked?: boolean; skipPullCheck?: boolean; autoPullIfClean?: boolean; hidden?: boolean; pinned?: boolean }): Promise<void> =>
    send("updateRepoSettings", { repo, ...settings }),

  cancelScan: (): Promise<void> => send("cancelScan").then(() => {}),
  cancelCommit: (): Promise<void> => send("cancelCommit").then(() => {}),
  cancelFetch: (): Promise<void> => send("cancelFetch").then(() => {}),

  subscribeScan: (rootDir: RepoPath, onEvent: (ev: ProgressEvent) => void, onError?: (error: Error) => void): AbortController =>
    subscribe("scan", { rootDir }, (data) => {
      if (data.type === "error") { onError?.(new Error(data.error)); return }
      if (data.type === "ack") return
      if (data.type === "done") return
      onEvent(data)
    }, "cancelScan"),

  subscribeCommitPush: (repo: string, onEvent: (ev: CommitEvent) => void): AbortController =>
    subscribe("commitPush", { repo }, (data) => {
      if (data.type === "ack") return
      if (data.type === "done") return
      onEvent(data)
    }, "cancelCommit"),

  subscribeScanOnly: (rootDir: RepoPath, onEvent: (ev: ProgressEvent) => void, onError?: (error: Error) => void): AbortController =>
    subscribe("scanOnly", { rootDir }, (data) => {
      if (data.type === "error") { onError?.(new Error(data.error)); return }
      if (data.type === "ack") return
      if (data.type === "done") return
      onEvent(data)
    }, "cancelScan"),

  rescanRepo: (repo: RepoPath): Promise<{ ok: boolean; repo?: RepoData; error?: string }> =>
    send("rescanRepo", { repo }),

  checkPull: (repo: RepoPath): Promise<{ ok: boolean; repo?: RepoData; error?: string }> =>
    send("checkPull", { repo }),

  getDiff: async (repo: string, file: string, status: "staged" | "unstaged" | "untracked"): Promise<{ file: string; diff: string }> => {
    logInfo("[diff] request", { repo, file, status })
    try {
      const result = await send<{ file: string; diff: string }>("getDiff", { repo, file, status })
      logInfo("[diff] response", { repo, requestedFile: file, responseFile: result.file, status, bytes: result.diff.length, preview: result.diff.slice(0, 200) })
      return result
    } catch (e) {
      logError("[diff] failed", { repo, file, status, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  subscribeFetch: (onEvent: (ev: FetchEvent) => void): AbortController =>
    subscribe("fetchAll", undefined, (data) => {
      if (data.type === "ack") return
      if (data.type === "done") return
      onEvent(data)
    }, "cancelFetch"),

  onMachineStatus: (fn: (machines: { name: string; online: boolean; lastSeen: number | null }[]) => void) => {
    machineHandlers.add(fn)
    return () => machineHandlers.delete(fn)
  },

  onReposUpdate: (fn: (repos: any[], agentId: string) => void) => {
    reposUpdateHandlers.add(fn)
    return () => reposUpdateHandlers.delete(fn)
  },

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
    autoPullIfClean: r.settings?.autoPullIfClean ?? false,
    hidden: r.settings?.hidden ?? false,
    pinned: r.settings?.pinned ?? false,
    status: {
      branch: r.branch || "", remote: r.remote || null,
      hasChanges: r.hasChanges, staged: r.staged, stagedFiles: r.stagedFiles || [],
      unstaged: r.unstaged, unstagedFiles: r.unstagedFiles || [],
      untracked: r.untracked, untrackedFiles: r.untrackedFiles || [],
      ahead: r.ahead, behind: r.behind,
      lastCommitTime: r.lastCommitTime, weekCommits: r.weekCommits,
      error: r.error || undefined,
    },
  }
}

interface GitStatus {
  branch: string; remote: string | null; hasChanges: boolean
  staged: number; stagedFiles: FileStatus[]
  unstaged: number; unstagedFiles: FileStatus[]
  untracked: number; untrackedFiles: FileStatus[]
  ahead: number; behind: number; lastCommitTime: number | null
  weekCommits: number; error?: string
}

export interface RepoInfo {
  path: string; name: string; machine: string; cached: boolean
  status: GitStatus
  skipUntracked?: boolean; skipPullCheck?: boolean; autoPullIfClean?: boolean; hidden?: boolean; pinned?: boolean
}
