export interface RepoData {
  name: string; path: string; branch: string | null; hasChanges: boolean
  staged: number; unstaged: number; untracked: number
  ahead: number; behind: number; remote: string | null
  lastCommitTime: number | null; weekCommits: number; lastScanTime: number | null
  error: string | null; machine: string
  settings: { skipUntracked: boolean; skipPullCheck: boolean; hidden: boolean } | null
}

export interface AgentConfig {
  rootDir: string | null; opencodeModel: string
}

export interface AgentState {
  agentId: string; online: boolean; lastSeen: number | null
  repos: RepoData[]; config: AgentConfig
}

export interface MachineInfo {
  name: string; online: boolean; lastSeen: number | null
}
