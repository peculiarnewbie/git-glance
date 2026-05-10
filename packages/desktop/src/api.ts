const BASE = ""

export interface RepoData {
  name: string
  path: string
  branch: string | null
  hasChanges: boolean
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
  remote: string | null
  lastCommitTime: number | null
  weekCommits: number
  lastScanTime: number | null
  error: string | null
  machine: string
  settings: { skipUntracked: boolean; skipPullCheck: boolean; hidden: boolean } | null
}

export interface ReposResponse {
  repos: RepoData[]
  scannedAt: number
  scannedDirs: string[]
  machines: { name: string; url: string; online: boolean; lastSeen: number | null }[]
}

export interface ServerConfigResponse {
  rootDir: string | null
  opencodeModel: string
  machines: { name: string; url: string; online: boolean }[]
}

export interface ProgressEvent {
  phase: string
  current: number
  total: number
  repo?: RepoData
  repoPath?: string
  repoName?: string
}

export interface CommitEvent {
  phase: string
  error?: string
  subject?: string
  body?: string
  repoPath?: string
}

export interface FetchEvent {
  phase: string
  repoPath?: string
  repoName?: string
  current: number
  total: number
  ahead?: number
  behind?: number
  branch?: string
  error?: string
}

export const api = {
  getRepos: async (): Promise<ReposResponse> => {
    const res = await fetch(`${BASE}/repos`)
    return res.json()
  },

  getConfig: async (): Promise<ServerConfigResponse> => {
    const res = await fetch(`${BASE}/config`)
    return res.json()
  },

  setConfig: async (config: { rootDir?: string; opencodeModel?: string; machines?: { name: string; url: string }[] }): Promise<void> => {
    await fetch(`${BASE}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    })
  },

  pullRepo: async (repo: string, machine?: string): Promise<{ ok: boolean; output?: string; error?: string }> => {
    const params = new URLSearchParams({ repo })
    if (machine) params.set("machine", machine)
    const res = await fetch(`${BASE}/pull?${params}`, { method: "POST" })
    return res.json()
  },

  pushRepo: async (repo: string, machine?: string): Promise<{ ok: boolean; output?: string; error?: string }> => {
    const params = new URLSearchParams({ repo })
    if (machine) params.set("machine", machine)
    const res = await fetch(`${BASE}/push?${params}`, { method: "POST" })
    return res.json()
  },

  updateRepoSettings: async (repo: string, settings: { skipUntracked?: boolean; skipPullCheck?: boolean; hidden?: boolean }): Promise<void> => {
    await fetch(`${BASE}/settings?repo=${encodeURIComponent(repo)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    })
  },

  cancelScan: async (): Promise<void> => {
    await fetch(`${BASE}/cancel-scan`, { method: "POST" })
  },

  cancelCommit: async (): Promise<void> => {
    await fetch(`${BASE}/cancel-commit`, { method: "POST" })
  },

  cancelFetch: async (): Promise<void> => {
    await fetch(`${BASE}/cancel-fetch`, { method: "POST" })
  },

  subscribeScan: (rootDir: string, onEvent: (ev: ProgressEvent) => void, onError?: () => void): AbortController => {
    const controller = new AbortController()
    const source = new EventSource(`${BASE}/scan?rootDir=${encodeURIComponent(rootDir)}`)
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data))
      } catch {}
    }
    source.onerror = () => {
      controller.abort()
      onError?.()
    }
    controller.signal.addEventListener("abort", () => source.close())
    return controller
  },

  subscribeCommitPush: (repo: string, onEvent: (ev: CommitEvent) => void): AbortController => {
    const controller = new AbortController()
    const source = new EventSource(`${BASE}/commit-push?repo=${encodeURIComponent(repo)}`)
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data))
      } catch {}
    }
    source.onerror = () => controller.abort()
    controller.signal.addEventListener("abort", () => source.close())
    return controller
  },

  subscribeFetch: (onEvent: (ev: FetchEvent) => void): AbortController => {
    const controller = new AbortController()
    const source = new EventSource(`${BASE}/fetch`)
    source.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data))
      } catch {}
    }
    source.onerror = () => controller.abort()
    controller.signal.addEventListener("abort", () => source.close())
    return controller
  },
}

export function repoDataToInfo(r: RepoData): RepoInfo {
  return {
    path: r.path,
    name: r.name,
    machine: r.machine,
    cached: false,
    skipUntracked: r.settings?.skipUntracked ?? false,
    skipPullCheck: r.settings?.skipPullCheck ?? false,
    hidden: r.settings?.hidden ?? false,
    status: {
      branch: r.branch || "",
      remote: r.remote || null,
      hasChanges: r.hasChanges,
      staged: r.staged,
      unstaged: r.unstaged,
      untracked: r.untracked,
      ahead: r.ahead,
      behind: r.behind,
      lastCommitTime: r.lastCommitTime,
      weekCommits: r.weekCommits,
      error: r.error || undefined,
    },
  }
}

interface GitStatus {
  branch: string
  remote: string | null
  hasChanges: boolean
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
  lastCommitTime: number | null
  weekCommits: number
  error?: string
}

export interface RepoInfo {
  path: string
  name: string
  machine: string
  cached: boolean
  status: GitStatus
  skipUntracked?: boolean
  skipPullCheck?: boolean
  hidden?: boolean
}
