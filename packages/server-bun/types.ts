export interface GitRepoSettings {
  skipUntracked: boolean;
  skipPullCheck: boolean;
  hidden: boolean;
}

export interface FileStatus {
  path: string;
  status: string;
}

export interface GitRepo {
  name: string;
  path: string;
  branch: string | null;
  hasChanges: boolean;
  staged: number;
  stagedFiles: FileStatus[];
  unstaged: number;
  unstagedFiles: FileStatus[];
  untracked: number;
  untrackedFiles: FileStatus[];
  ahead: number;
  behind: number;
  remote: string | null;
  lastCommitTime: number | null;
  weekCommits: number;
  lastScanTime: number | null;
  error: string | null;
  machine: string;
  settings: GitRepoSettings | null;
}

export interface MachineStatus {
  name: string;
  url: string;
  online: boolean;
  lastSeen: number | null;
}

export interface ServerConfig {
  rootDir: string | null;
  opencodeModel: string;
  machines: ServerConfigMachine[];
}

export interface ServerConfigMachine {
  name: string;
  url: string;
  token?: string;
}

export interface ReposResponse {
  repos: GitRepo[];
  scannedAt: number;
  scannedDirs: string[];
  machines: MachineStatus[];
}

export interface PullPushResult {
  ok: boolean;
  output: string | null;
  error: string | null;
}

export interface RescanResult {
  ok: boolean;
  repo: GitRepo | null;
  error: string | null;
}

export interface ScanProgress {
  phase: string;
  total: number;
  current: number;
  repo: GitRepo | null;
}

export interface CommitProgress {
  phase: string;
  error: string | null;
  subject: string | null;
  body: string | null;
  repoPath: string | null;
}

export interface FetchProgress {
  phase: string;
  repoPath: string | null;
  repoName: string | null;
  current: number;
  total: number;
  ahead: number | null;
  behind: number | null;
  branch: string | null;
  error: string | null;
}

export interface PersistedConfig {
  rootDir?: string;
  opencodeModel?: string;
  token?: string;
  machines?: ServerConfigMachine[];
}

export interface GitStatusResult {
  branch: string;
  remote: string | null;
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
}

export interface MachineState {
  name: string;
  url: string;
  token: string;
  online: boolean;
  lastSeen: number | null;
}

export interface WSRequest {
  id: string;
  action: string;
  params?: Record<string, any>;
}

export interface WSResponse {
  id: string;
  type: string;
  data?: any;
  error?: string;
}

export interface PeerEnvelope {
  type: "auth" | "req" | "res" | "push";
  id?: string;
  token?: string;
  action?: string;
  event?: string;
  ok?: boolean;
  error?: string;
  payload?: any;
}

export interface PeerPullPushPayload {
  path: string;
}

export interface CommitMessage {
  subject: string;
  body: string;
}
