package main

import "encoding/json"

type GitRepoSettings struct {
	SkipUntracked bool `json:"skipUntracked"`
	SkipPullCheck bool `json:"skipPullCheck"`
	Hidden        bool `json:"hidden"`
}

type FileStatus struct {
	Path   string `json:"path"`
	Status string `json:"status"` // XY porcelain chars, e.g. "M ", "A ", " D", "??", "R ", etc.
}

type GitRepo struct {
	Name           string           `json:"name"`
	Path           string           `json:"path"`
	Branch         *string          `json:"branch"`
	HasChanges     bool             `json:"hasChanges"`
	Staged         int          `json:"staged"`
	StagedFiles    []FileStatus `json:"stagedFiles"`
	Unstaged       int          `json:"unstaged"`
	UnstagedFiles  []FileStatus `json:"unstagedFiles"`
	Untracked      int          `json:"untracked"`
	UntrackedFiles []FileStatus `json:"untrackedFiles"`
	Ahead          int              `json:"ahead"`
	Behind         int              `json:"behind"`
	Remote         *string          `json:"remote"`
	LastCommitTime *int64           `json:"lastCommitTime"`
	WeekCommits    int              `json:"weekCommits"`
	LastScanTime   *int64           `json:"lastScanTime"`
	Error          *string          `json:"error"`
	Machine        string           `json:"machine"`
	Settings       *GitRepoSettings `json:"settings"`
}

type MachineStatus struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	Online   bool   `json:"online"`
	LastSeen *int64 `json:"lastSeen"`
}

type ServerConfig struct {
	RootDir       *string               `json:"rootDir"`
	OpenCodeModel string                `json:"opencodeModel"`
	Machines      []ServerConfigMachine `json:"machines"`
}

type ServerConfigMachine struct {
	Name  string `json:"name"`
	URL   string `json:"url"`
	Token string `json:"token,omitempty"`
}

type ReposResponse struct {
	Repos       []GitRepo       `json:"repos"`
	ScannedAt   int64           `json:"scannedAt"`
	ScannedDirs []string        `json:"scannedDirs"`
	Machines    []MachineStatus `json:"machines"`
}

type PullPushResult struct {
	Ok     bool    `json:"ok"`
	Output *string `json:"output"`
	Error  *string `json:"error"`
}

type RescanResult struct {
	Ok    bool     `json:"ok"`
	Repo  *GitRepo `json:"repo"`
	Error *string  `json:"error"`
}

type ScanProgress struct {
	Phase   string   `json:"phase"`
	Total   int      `json:"total"`
	Current int      `json:"current"`
	Repo    *GitRepo `json:"repo"`
}

type CommitProgress struct {
	Phase    string  `json:"phase"`
	Error    *string `json:"error"`
	Subject  *string `json:"subject"`
	Body     *string `json:"body"`
	RepoPath *string `json:"repoPath"`
}

type FetchProgress struct {
	Phase    string  `json:"phase"`
	RepoPath *string `json:"repoPath"`
	RepoName *string `json:"repoName"`
	Current  int     `json:"current"`
	Total    int     `json:"total"`
	Ahead    *int    `json:"ahead"`
	Behind   *int    `json:"behind"`
	Branch   *string `json:"branch"`
	Error    *string `json:"error"`
}

type PersistedConfig struct {
	RootDir       string                `json:"rootDir,omitempty"`
	OpenCodeModel string                `json:"opencodeModel,omitempty"`
	Token         string                `json:"token,omitempty"`
	Machines      []ServerConfigMachine `json:"machines,omitempty"`
}

type GitStatusResult struct {
	Branch         string
	Remote         *string
	HasChanges     bool
	Staged         int
	StagedFiles    []FileStatus
	Unstaged       int
	UnstagedFiles  []FileStatus
	Untracked      int
	UntrackedFiles []FileStatus
	Ahead          int
	Behind         int
	LastCommitTime *int64
	WeekCommits    int
}

type MachineState struct {
	Name     string
	URL      string
	Token    string
	Online   bool
	LastSeen *int64
}

// WS protocol messages

type WSRequest struct {
	ID     string         `json:"id"`
	Action string         `json:"action"`
	Params map[string]any `json:"params,omitempty"`
}

type WSResponse struct {
	ID   string `json:"id"`
	Type string `json:"type"`
	Data any    `json:"data,omitempty"`
	Err  string `json:"error,omitempty"`
}

// ─── Inter-machine peer protocol ──────────────────────────────────────

type PeerEnvelope struct {
	Type    string          `json:"type"`    // "auth" | "req" | "res" | "push"
	ID      string          `json:"id,omitempty"`
	Token   string          `json:"token,omitempty"`
	Action  string          `json:"action,omitempty"`
	Event   string          `json:"event,omitempty"`
	OK      bool            `json:"ok,omitempty"`
	Error   string          `json:"error,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type PeerPullPushPayload struct {
	Path string `json:"path"`
}

func strPtr(s string) *string {
	return &s
}
