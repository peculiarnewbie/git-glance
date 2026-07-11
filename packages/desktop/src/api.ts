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

// Packaged Electrobun views have a custom origin, so use the local server
// directly. Browser and Vite development builds stay same-origin.
const BASE = location.protocol === "views:" ? "http://127.0.0.1:3451" : ""

export interface SessionResponse {
  user: { email: string }
}

export async function checkSession(): Promise<{ state: "authenticated"; email: string } | { state: "unauthenticated" } | { state: "local" }> {
  try {
    const res = await fetch(`${BASE}/api/session`)
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
  window.location.href = `${BASE}/api/auth/login`
}

export async function logout() {
  await fetch(`${BASE}/api/auth/logout`, { method: "POST" })
  window.location.href = "/"
}

type HttpMethod = "GET" | "POST" | "PATCH"

function queryString(params: Record<string, unknown> | undefined): string {
  if (!params) return ""
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) query.set(key, String(value))
  }
  const encoded = query.toString()
  return encoded ? `?${encoded}` : ""
}

async function request<T>(method: HttpMethod, path: string, params?: Record<string, any>): Promise<T> {
  const isRead = method === "GET"
  const response = await fetch(`${BASE}${path}${isRead ? queryString(params) : ""}`, {
    method,
    headers: isRead ? undefined : { "content-type": "application/json" },
    body: isRead ? undefined : JSON.stringify(params ?? {}),
  })
  const contentType = response.headers.get("content-type") || ""
  if (!contentType.includes("application/json")) {
    throw new Error("Git Glance server is outdated or unavailable. Rebuild and restart the local service.")
  }
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`)
  return body as T
}

async function send<T>(action: string, params: Record<string, any> = {}): Promise<T> {
  switch (action) {
    case "getRepos": return request<T>("GET", "/api/repos")
    case "getWorkspaceStatus": return request<T>("GET", "/api/workspace")
    case "getRepoStatus": return request<T>("GET", "/api/repos/status", params)
    case "searchRepos": return request<T>("GET", "/api/repos/search", params)
    case "getRecentActivity": return request<T>("GET", "/api/activity", params)
    case "getDiff": return request<T>("GET", "/api/diff", params)
    case "getConfig": return request<T>("GET", "/api/config")
    case "setConfig": return request<T>("PATCH", "/api/config", params)
    case "pull": return request<T>("POST", "/api/repos/pull", params)
    case "push": return request<T>("POST", "/api/repos/push", params)
    case "rescanRepo": return request<T>("POST", "/api/repos/rescan", params)
    case "checkPull": return request<T>("POST", "/api/repos/check-pull", params)
    case "updateRepoSettings": return request<T>("PATCH", "/api/repos/settings", params)
    case "cancel": case "cancelScan": case "cancelCommit": case "cancelFetch":
      return request<T>("POST", "/api/operations/cancel")
    default: throw new Error(`Unsupported HTTP action: ${action}`)
  }
}

type OperationEvent = { operationId: string; type: "progress" | "done" | "error"; data?: any; error?: string }
type OperationSubscriber = { onEvent: (data: any) => void; onError?: (error: Error) => void }
const operationSubscribers = new Map<string, OperationSubscriber>()
const pendingOperationEvents = new Map<string, OperationEvent[]>()
let eventSource: EventSource | null = null
let eventsReady: Promise<void> | null = null

function handleOperationEvent(event: OperationEvent) {
  const subscriber = operationSubscribers.get(event.operationId)
  if (!subscriber) {
    const queued = pendingOperationEvents.get(event.operationId) ?? []
    queued.push(event)
    pendingOperationEvents.set(event.operationId, queued)
    return
  }
  if (event.type === "error") subscriber.onError?.(new Error(event.error || "Operation failed"))
  else if (event.type === "progress" && event.data !== undefined) subscriber.onEvent(event.data)
  else if (event.type === "done") {
    if (event.data !== undefined) subscriber.onEvent(event.data)
    operationSubscribers.delete(event.operationId)
  }
}

function ensureEvents(): Promise<void> {
  if (eventsReady) return eventsReady
  if (typeof EventSource === "undefined") return Promise.reject(new Error("Server-sent events are not supported"))
  eventSource = new EventSource(`${BASE}/api/events`)
  eventsReady = new Promise((resolve) => {
    eventSource!.onopen = () => resolve()
  })
  for (const type of ["progress", "done", "error"] as const) {
    eventSource.addEventListener(type, (raw) => {
      try { handleOperationEvent(JSON.parse((raw as MessageEvent<string>).data)) }
      catch (error) { logError("[sse] parse error", { error: String(error) }) }
    })
  }
  eventSource.onerror = () => logWarn("[sse] connection interrupted; browser will retry")
  return eventsReady
}

function subscribeOperation(path: string, params: Record<string, any> | undefined, onEvent: (data: any) => void, onError?: (error: Error) => void): AbortController {
  const controller = new AbortController()
  ensureEvents()
    .then(() => request<{ operationId: string }>("POST", path, params))
    .then(({ operationId }) => {
      if (controller.signal.aborted) {
        void send("cancel").catch(error => logError("[sse] cancel failed", { error: String(error) }))
        return
      }
      const subscriber = { onEvent, onError }
      operationSubscribers.set(operationId, subscriber)
      const queued = pendingOperationEvents.get(operationId) ?? []
      pendingOperationEvents.delete(operationId)
      queued.forEach(handleOperationEvent)
      controller.signal.addEventListener("abort", () => {
        operationSubscribers.delete(operationId)
        void send("cancel").catch(error => logError("[sse] cancel failed", { error: String(error) }))
      }, { once: true })
    })
    .catch(error => onError?.(error instanceof Error ? error : new Error(String(error))))
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
  error: string | null
  settings: { skipUntracked: boolean; skipPullCheck: boolean; autoPullIfClean: boolean; hidden: boolean; pinned: boolean } | null
}

// Derive RepoInfo from the API response schema.
export type RepoName = RepoData['name'];
export type RepoPath = RepoData['path'];
export type RepoBranch = RepoData['branch'];
export type RepoRemote = RepoData['remote'];
export type RepoError = RepoData['error'];

// This is the source of truth - derived from API response schema.
export interface RepoInfo {
  path: RepoPath;
  name: RepoName;
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
}

export interface WorkspaceStatusResponse {
  generatedAt: number; repos: RepoData[]; totalRepos: number; dirtyRepos: number
  aheadRepos: number; behindRepos: number; erroredRepos: number; hiddenRepos: number
}

export interface RecentCommit {
  hash: string; timestamp: number; author: string; subject: string
}

export interface RecentActivityResponse {
  since: number; until: number
  activities: { repo: RepoData; commits: RecentCommit[]; error?: string }[]
}

export interface ServerConfigResponse {
  rootDir: string | null; opencodeModel: string; excludedDirs?: string[]
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

  getWorkspaceStatus: (): Promise<WorkspaceStatusResponse> => send<WorkspaceStatusResponse>("getWorkspaceStatus"),

  getRepoStatus: (repo: RepoPath, options?: { refresh?: boolean }): Promise<{ repo: RepoData; fresh: boolean }> =>
    send("getRepoStatus", { repo, ...options }),

  searchRepos: (options?: { query?: string; state?: "dirty" | "ahead" | "behind" | "error" | "clean"; includeHidden?: boolean; limit?: number }): Promise<{ repos: RepoData[] }> =>
    send("searchRepos", options),

  getRecentActivity: (options?: { since?: number; limitPerRepo?: number; includeHidden?: boolean }): Promise<RecentActivityResponse> =>
    send("getRecentActivity", options),

  getConfig: (): Promise<ServerConfigResponse> => send<ServerConfigResponse>("getConfig"),

  setConfig: (config: { rootDir?: string; opencodeModel?: string; excludedDirs?: string[] }): Promise<void> =>
    send("setConfig", config),

  pullRepo: (repo: RepoPath): Promise<{ ok: boolean; output?: string; error?: string }> =>
    send("pull", { repo }),

  pushRepo: (repo: RepoPath): Promise<{ ok: boolean; output?: string; error?: string }> =>
    send("push", { repo }),

  updateRepoSettings: (repo: RepoPath, settings: { skipUntracked?: boolean; skipPullCheck?: boolean; autoPullIfClean?: boolean; hidden?: boolean; pinned?: boolean }): Promise<void> =>
    send("updateRepoSettings", { repo, ...settings }),

  cancelScan: (): Promise<void> => send("cancelScan").then(() => {}),
  cancelCommit: (): Promise<void> => send("cancelCommit").then(() => {}),
  cancelFetch: (): Promise<void> => send("cancelFetch").then(() => {}),

  subscribeScan: (rootDir: RepoPath, onEvent: (ev: ProgressEvent) => void, onError?: (error: Error) => void): AbortController =>
    subscribeOperation("/api/operations/scan", { rootDir }, onEvent, onError),

  subscribeCommitPush: (repo: string, onEvent: (ev: CommitEvent) => void): AbortController =>
    subscribeOperation("/api/operations/commit", { repo }, onEvent),

  subscribeScanOnly: (rootDir: RepoPath, onEvent: (ev: ProgressEvent) => void, onError?: (error: Error) => void): AbortController =>
    subscribeOperation("/api/operations/scan-only", { rootDir }, onEvent, onError),

  rescanRepo: (repo: RepoPath): Promise<{ ok: boolean; repo?: RepoData; error?: string }> =>
    send("rescanRepo", { repo }),

  checkPull: (repo: RepoPath): Promise<{ ok: boolean; repo?: RepoData; error?: string }> =>
    send("checkPull", { repo }),

  getDiff: async (repo: string, file: string, status: "staged" | "unstaged" | "untracked", maxBytes?: number): Promise<{ file: string; diff: string; truncated: boolean; returnedBytes: number; totalBytes: number }> => {
    logInfo("[diff] request", { repo, file, status })
    try {
      const result = await send<{ file: string; diff: string; truncated: boolean; returnedBytes: number; totalBytes: number }>("getDiff", { repo, file, status, maxBytes })
      logInfo("[diff] response", { repo, requestedFile: file, responseFile: result.file, status, bytes: result.diff.length, preview: result.diff.slice(0, 200) })
      return result
    } catch (e) {
      logError("[diff] failed", { repo, file, status, error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  },

  subscribeFetch: (onEvent: (ev: FetchEvent) => void): AbortController =>
    subscribeOperation("/api/operations/fetch", undefined, onEvent),

  // Effect wrappers for backward compat with App.tsx
  pullRepoEffect: (repo: string) =>
    ({ _tag: "effect", name: "pull", repo } as any),

  pushRepoEffect: (repo: string) =>
    ({ _tag: "effect", name: "push", repo } as any),

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
    path: r.path, name: r.name, cached: false,
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
  path: string; name: string; cached: boolean
  status: GitStatus
  skipUntracked?: boolean; skipPullCheck?: boolean; autoPullIfClean?: boolean; hidden?: boolean; pinned?: boolean
}
