package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type WSClient struct {
	conn  *websocket.Conn
	mu    sync.Mutex
	ctx   context.Context
	cancel context.CancelFunc
}

func NewWSClient(conn *websocket.Conn) *WSClient {
	ctx, cancel := context.WithCancel(context.Background())
	return &WSClient{
		conn:   conn,
		ctx:    ctx,
		cancel: cancel,
	}
}

func (c *WSClient) Send(msg WSResponse) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return c.conn.Write(c.ctx, websocket.MessageText, data)
}

func (c *WSClient) SendResult(id string, data any) error {
	return c.Send(WSResponse{ID: id, Type: "result", Data: data})
}

func (c *WSClient) SendError(id string, errMsg string) error {
	return c.Send(WSResponse{ID: id, Type: "error", Err: errMsg})
}

func (c *WSClient) SendProgress(id string, data any) error {
	return c.Send(WSResponse{ID: id, Type: "progress", Data: data})
}

func (c *WSClient) SendDone(id string) error {
	return c.Send(WSResponse{ID: id, Type: "done"})
}

type ServerDeps struct {
	Git       *GitService
	Cache     *CacheService
	Remote    *RemoteMachineService
	LocalName string
}

var intPtr = func(i int) *int { return &i }

func handleWS(w http.ResponseWriter, r *http.Request, deps *ServerDeps) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("WS upgrade error: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	client := NewWSClient(conn)

	log.Printf("WS client connected")

	for {
		_, msg, err := conn.Read(client.ctx)
		if err != nil {
			break
		}

		var req WSRequest
		if err := json.Unmarshal(msg, &req); err != nil {
			continue
		}

		go handleAction(client, req, deps)
	}
}

func handleAction(client *WSClient, req WSRequest, deps *ServerDeps) {
	switch req.Action {
	case "getRepos":
		handleGetRepos(client, req, deps)
	case "getConfig":
		handleGetConfig(client, req, deps)
	case "setConfig":
		handleSetConfig(client, req, deps)
	case "pull":
		handlePull(client, req, deps)
	case "push":
		handlePush(client, req, deps)
	case "rescanRepo":
		handleRescanRepo(client, req, deps)
	case "checkPull":
		handleCheckPull(client, req, deps)
	case "updateRepoSettings":
		handleUpdateRepoSettings(client, req, deps)
	case "cancelScan":
		CancelScan()
		client.SendResult(req.ID, map[string]bool{"ok": true})
	case "cancelCommit":
		client.SendResult(req.ID, map[string]bool{"ok": true})
	case "cancelFetch":
		client.SendResult(req.ID, map[string]bool{"ok": true})
	case "scan":
		handleScan(client, req, deps)
	case "scanOnly":
		handleScanOnly(client, req, deps)
	case "commitPush":
		handleCommitPush(client, req, deps)
	case "fetchAll":
		handleFetchAll(client, req, deps)
	default:
		client.SendError(req.ID, fmt.Sprintf("unknown action: %s", req.Action))
	}
}

// --- Action handlers ---

func handleGetRepos(client *WSClient, req WSRequest, deps *ServerDeps) {
	allRepos, err := deps.Cache.GetAllRepos()
	if err != nil {
		client.SendError(req.ID, err.Error())
		return
	}
	// Migrate old cached repos labelled "local" to the configured local machine name
	for i := range allRepos {
		if allRepos[i].Machine == "local" || allRepos[i].Machine == "" {
			allRepos[i].Machine = deps.LocalName
		}
	}
	statuses := deps.Remote.GetStatuses()
	scannedDirs := deps.Cache.GetScannedDirs()

	now := time.Now().UnixMilli()
	localMachine := MachineStatus{
		Name:     deps.LocalName,
		URL:      "",
		Online:   true,
		LastSeen: &now,
	}
	machines := append([]MachineStatus{localMachine}, statuses...)

	client.SendResult(req.ID, ReposResponse{
		Repos:       allRepos,
		ScannedAt:   time.Now().UnixMilli(),
		ScannedDirs: scannedDirs,
		Machines:    machines,
	})
}

func handleGetConfig(client *WSClient, req WSRequest, deps *ServerDeps) {
	cfg, err := deps.Cache.LoadConfig()
	if err != nil {
		client.SendError(req.ID, err.Error())
		return
	}
	statuses := deps.Remote.GetStatuses()

	var rootDir *string
	if cfg.RootDir != "" {
		rootDir = &cfg.RootDir
	}
	model := cfg.OpenCodeModel
	if model == "" {
		model = "CrofAI/deepseek-v4-flash"
	}

	now := time.Now().UnixMilli()
	machinesWithOnline := []MachineStatus{
		{Name: deps.LocalName, URL: "", Online: true, LastSeen: &now},
	}

	for _, m := range cfg.Machines {
		online := false
		for _, s := range statuses {
			if s.Name == m.Name {
				online = s.Online
				break
			}
		}
		if m.Name != deps.LocalName {
			machinesWithOnline = append(machinesWithOnline, MachineStatus{
				Name:   m.Name,
				URL:    m.URL,
				Online: online,
			})
		}
	}

	client.SendResult(req.ID, map[string]any{
		"rootDir":       rootDir,
		"opencodeModel": model,
		"machines":      machinesWithOnline,
	})
}

func handleSetConfig(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params

	existing, _ := deps.Cache.LoadConfig()

	if v, ok := params["rootDir"]; ok {
		if s, ok := v.(string); ok {
			existing.RootDir = s
			deps.Cache.AddScannedDir(s)
		}
	}
	if v, ok := params["opencodeModel"]; ok {
		if s, ok := v.(string); ok {
			existing.OpenCodeModel = s
		}
	}
	if v, ok := params["machines"]; ok {
		if machines, ok := v.([]any); ok {
			cfgMachines := make([]ServerConfigMachine, 0, len(machines))
			for _, m := range machines {
				if mm, ok := m.(map[string]any); ok {
					name, _ := mm["name"].(string)
					url, _ := mm["url"].(string)
					if name != "" && url != "" {
						cfgMachines = append(cfgMachines, ServerConfigMachine{Name: name, URL: url})
					}
				}
			}
			existing.Machines = cfgMachines
			deps.Remote.UpdateConfig(existing)
		}
	}

	if err := deps.Cache.SaveConfig(existing); err != nil {
		client.SendError(req.ID, err.Error())
		return
	}

	client.SendResult(req.ID, map[string]bool{"ok": true})
}

func handlePull(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	repo, _ := params["repo"].(string)
	machine, _ := params["machine"].(string)
	if repo == "" {
		client.SendError(req.ID, `Missing "repo" parameter`)
		return
	}
	if machine == "" || machine == deps.LocalName {
		machine = deps.LocalName
	}

	if machine != deps.LocalName {
		result, err := deps.Remote.ProxyRequest(client.ctx, machine, "POST", "/pull?repo="+repo, "")
		if err != nil {
			client.SendError(req.ID, err.Error())
		} else {
			client.SendResult(req.ID, result)
		}
		return
	}

	output, err := deps.Git.RunWithLock(client.ctx, "pull", repo, 30*time.Second)
	if err != nil {
		client.SendResult(req.ID, PullPushResult{Ok: false, Error: strPtr(err.Error())})
		return
	}

	updateRepoInCache(client.ctx, deps, repo)
	client.SendResult(req.ID, PullPushResult{Ok: true, Output: &output})
}

func handlePush(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	repo, _ := params["repo"].(string)
	machine, _ := params["machine"].(string)
	if repo == "" {
		client.SendError(req.ID, `Missing "repo" parameter`)
		return
	}
	if machine == "" || machine == deps.LocalName {
		machine = deps.LocalName
	}

	if machine != deps.LocalName {
		result, err := deps.Remote.ProxyRequest(client.ctx, machine, "POST", "/push?repo="+repo, "")
		if err != nil {
			client.SendError(req.ID, err.Error())
		} else {
			client.SendResult(req.ID, result)
		}
		return
	}

	output, err := deps.Git.RunWithLock(client.ctx, "push", repo, 60*time.Second)
	if err != nil {
		client.SendResult(req.ID, PullPushResult{Ok: false, Error: strPtr(err.Error())})
		return
	}

	updateRepoInCache(client.ctx, deps, repo)
	client.SendResult(req.ID, PullPushResult{Ok: true, Output: &output})
}

func handleRescanRepo(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	repo, _ := params["repo"].(string)
	if repo == "" {
		client.SendError(req.ID, `Missing "repo" parameter`)
		return
	}

	status, err := deps.Git.GetStatusWithLock(client.ctx, repo)
	if err != nil {
		client.SendResult(req.ID, RescanResult{Ok: false, Error: strPtr("Failed to get status")})
		return
	}

	updated := makeRepoFromStatus(repo, status, deps.LocalName)
	updateRepoInCache(client.ctx, deps, repo)
	client.SendResult(req.ID, RescanResult{Ok: true, Repo: &updated})
}

func handleCheckPull(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	repo, _ := params["repo"].(string)
	if repo == "" {
		client.SendError(req.ID, `Missing "repo" parameter`)
		return
	}

	deps.Git.RunWithLock(client.ctx, "fetch origin", repo, 30*time.Second)

	status, err := deps.Git.GetStatusWithLock(client.ctx, repo)
	if err != nil {
		client.SendResult(req.ID, RescanResult{Ok: false, Error: strPtr("Failed to get status after fetch")})
		return
	}

	updated := makeRepoFromStatus(repo, status, deps.LocalName)
	updateRepoInCache(client.ctx, deps, repo)
	client.SendResult(req.ID, RescanResult{Ok: true, Repo: &updated})
}

func handleUpdateRepoSettings(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	repo, _ := params["repo"].(string)
	if repo == "" {
		client.SendError(req.ID, `Missing "repo" parameter`)
		return
	}

	repos, err := deps.Cache.Load()
	if err != nil {
		errors, _ := deps.Cache.Load()
		repos = errors
	}

	updated := make([]GitRepo, len(repos))
	for i, r := range repos {
		if r.Path != repo {
			updated[i] = r
			continue
		}
		settings := r.Settings
		if settings == nil {
			settings = &GitRepoSettings{}
		}
		if v, ok := params["skipUntracked"]; ok {
			settings.SkipUntracked, _ = v.(bool)
		}
		if v, ok := params["skipPullCheck"]; ok {
			settings.SkipPullCheck, _ = v.(bool)
		}
		if v, ok := params["hidden"]; ok {
			settings.Hidden, _ = v.(bool)
		}
		r.Settings = settings
		updated[i] = r
	}

	deps.Cache.Save(updated)
	client.SendResult(req.ID, map[string]bool{"ok": true})
}

func handleScan(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	rootDir, _ := params["rootDir"].(string)
	if rootDir == "" {
		client.SendError(req.ID, `Missing "rootDir" parameter`)
		return
	}

	ResetCancel()
	deps.Cache.AddScannedDir(rootDir)

	progressCh := make(chan ScanProgress, 100)
	go scanAll(client.ctx, deps.Git, deps.Cache, rootDir, deps.LocalName, progressCh)

	for p := range progressCh {
		if err := client.SendProgress(req.ID, p); err != nil {
			CancelScan()
			return
		}
	}
	client.SendDone(req.ID)
}

func handleScanOnly(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	rootDir, _ := params["rootDir"].(string)
	if rootDir == "" {
		client.SendError(req.ID, `Missing "rootDir" parameter`)
		return
	}

	ResetCancel()
	deps.Cache.AddScannedDir(rootDir)

	progressCh := make(chan ScanProgress, 100)
	go scanOnly(client.ctx, deps.Git, deps.Cache, rootDir, deps.LocalName, progressCh)

	for p := range progressCh {
		if err := client.SendProgress(req.ID, p); err != nil {
			CancelScan()
			return
		}
	}
	client.SendDone(req.ID)
}

func handleCommitPush(client *WSClient, req WSRequest, deps *ServerDeps) {
	params := req.Params
	repo, _ := params["repo"].(string)
	if repo == "" {
		client.SendError(req.ID, `Missing "repo" parameter`)
		return
	}

	send := func(phase string, data map[string]any) {
		cp := CommitProgress{
			Phase:    phase,
			RepoPath: &repo,
		}
		if data != nil {
			if e, ok := data["error"]; ok {
				if s, ok := e.(string); ok {
					cp.Error = &s
				}
			}
			if s, ok := data["subject"]; ok {
				if ss, ok := s.(string); ok {
					cp.Subject = &ss
				}
			}
			if b, ok := data["body"]; ok {
				if bb, ok := b.(string); ok {
					cp.Body = &bb
				}
			}
		}
		client.SendProgress(req.ID, cp)
	}

	sendProgress := func(phase string) {
		send(phase, nil)
	}

	sendProgress("staging")
	_, err := deps.Git.RunWithLock(client.ctx, "add .", repo, 15*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		client.SendDone(req.ID)
		return
	}

	branch, err := deps.Git.RunWithLock(client.ctx, "rev-parse --abbrev-ref HEAD", repo, 5*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		client.SendDone(req.ID)
		return
	}

	stagedSummary, _ := deps.Git.Run(client.ctx, "diff --cached --stat", repo, 10*time.Second)
	stagedPatch, _ := deps.Git.Run(client.ctx, "diff --cached", repo, 10*time.Second)

	if stagedPatch == "" {
		send("error", map[string]any{"error": "No changes to commit"})
		client.SendDone(req.ID)
		return
	}

	sendProgress("generating")
	cfg, _ := deps.Cache.LoadConfig()
	model := cfg.OpenCodeModel
	if model == "" {
		model = "CrofAI/deepseek-v4-flash"
	}

	commitMsg, err := generateCommitMessage(client.ctx, repo, branch, stagedSummary, stagedPatch, model)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		client.SendDone(req.ID)
		return
	}

	sendProgress("committing")
	fullMessage := commitMsg.Subject
	if commitMsg.Body != "" {
		fullMessage = commitMsg.Subject + "\n\n" + commitMsg.Body
	}
	_, err = deps.Git.RunWithLock(client.ctx, fmt.Sprintf(`commit -m "%s"`, escapeCommitMsg(fullMessage)), repo, 15*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		client.SendDone(req.ID)
		return
	}

	sendProgress("pushing")
	_, err = deps.Git.RunWithLock(client.ctx, "push", repo, 60*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		client.SendDone(req.ID)
		return
	}

	updateRepoInCache(client.ctx, deps, repo)
	send("done", map[string]any{"subject": commitMsg.Subject, "body": commitMsg.Body})
	client.SendDone(req.ID)
}

func handleFetchAll(client *WSClient, req WSRequest, deps *ServerDeps) {
	ResetCancel()

	sendProgress := func(phase string, current, total int, repoPath, repoName *string, ahead, behind *int, branch *string, errStr *string) {
		fp := FetchProgress{
			Phase:    phase,
			Current:  current,
			Total:    total,
			RepoPath: repoPath,
			RepoName: repoName,
			Ahead:    ahead,
			Behind:   behind,
			Branch:   branch,
			Error:    errStr,
		}
		client.SendProgress(req.ID, fp)
	}

	allRepos, err := deps.Cache.GetAllRepos()
	if err != nil {
		client.SendError(req.ID, err.Error())
		return
	}

	var localRepos []GitRepo
	for _, r := range allRepos {
		skip := (r.Settings != nil && r.Settings.Hidden) || (r.Settings != nil && r.Settings.SkipPullCheck)
		if !skip {
			localRepos = append(localRepos, r)
		}
	}

	total := len(localRepos)
	if total == 0 {
		sendProgress("done", 0, 0, nil, nil, nil, nil, nil, nil)
		client.SendDone(req.ID)
		return
	}

	sendProgress("fetching", 0, total, nil, nil, nil, nil, nil, nil)

	for i, repo := range localRepos {
		if scanCanceled {
			break
		}

		name := repo.Name
		sendProgress("repo", i, total, &repo.Path, &name, nil, nil, nil, nil)

		deps.Git.RunWithLock(client.ctx, "fetch origin", repo.Path, 30*time.Second)
		status, _ := deps.Git.GetStatusWithLock(client.ctx, repo.Path)

		var a, b *int
		if status != nil {
			a = &status.Ahead
			b = &status.Behind
			updateRepoInCache(client.ctx, deps, repo.Path)
		}
		sendProgress("repo", i+1, total, &repo.Path, &name, a, b, repo.Branch, nil)
	}

	sendProgress("done", total, total, nil, nil, nil, nil, nil, nil)
	client.SendDone(req.ID)
}

// --- Helpers ---

func makeRepoFromStatus(repoPath string, status *GitStatusResult, localName string) GitRepo {
	name := filepath.Base(repoPath)
	now := time.Now().UnixMilli()
	commitTimeMs := int64(0)
	if status.LastCommitTime != nil {
		commitTimeMs = *status.LastCommitTime * 1000
	}
	return GitRepo{
		Name:           name,
		Path:           repoPath,
		Branch:         &status.Branch,
		HasChanges:     status.HasChanges,
		Staged:         status.Staged,
		Unstaged:       status.Unstaged,
		Untracked:      status.Untracked,
		Ahead:          status.Ahead,
		Behind:         status.Behind,
		Remote:         status.Remote,
		LastCommitTime: &commitTimeMs,
		WeekCommits:    status.WeekCommits,
		LastScanTime:   &now,
		Machine:        localName,
	}
}

func updateRepoInCache(ctx context.Context, deps *ServerDeps, repoPath string) {
	status, err := deps.Git.GetStatus(ctx, repoPath)
	if err != nil {
		return
	}
	repos, err := deps.Cache.Load()
	if err != nil {
		return
	}

	name := filepath.Base(repoPath)
	now := time.Now().UnixMilli()
	commitTimeMs := int64(0)
	if status.LastCommitTime != nil {
		commitTimeMs = *status.LastCommitTime * 1000
	}
	updated := GitRepo{
		Name:           name,
		Path:           repoPath,
		Branch:         &status.Branch,
		HasChanges:     status.HasChanges,
		Staged:         status.Staged,
		Unstaged:       status.Unstaged,
		Untracked:      status.Untracked,
		Ahead:          status.Ahead,
		Behind:         status.Behind,
		Remote:         status.Remote,
		LastCommitTime: &commitTimeMs,
		WeekCommits:    status.WeekCommits,
		LastScanTime:   &now,
		Machine:        deps.LocalName,
	}

	found := false
	for i, r := range repos {
		if r.Path == repoPath {
			updated.Settings = r.Settings
			repos[i] = updated
			found = true
			break
		}
	}
	if !found {
		repos = append(repos, updated)
	}

	deps.Cache.Save(repos)
}

func escapeCommitMsg(msg string) string {
	escaped := ""
	for _, c := range msg {
		switch c {
		case '"':
			escaped += "\\\""
		case '\\':
			escaped += "\\\\"
		case '\n':
			escaped += "\\n"
		default:
			escaped += string(c)
		}
	}
	return escaped
}
