package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"time"
)

type Executor struct {
	git   *GitService
	cache *CacheService
	ws    *WSClient
	cfg   AgentConfig
}

func NewExecutor(git *GitService, cache *CacheService, ws *WSClient, cfg AgentConfig) *Executor {
	return &Executor{git: git, cache: cache, ws: ws, cfg: cfg}
}

func (e *Executor) Run() {
	for {
		msg, err := e.ws.ReadMessage()
		if err != nil {
			log.Printf("Read error: %v", err)
			return
		}

		var req struct {
			Type   string         `json:"type"`
			ID     string         `json:"id"`
			Action string         `json:"action"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(msg, &req); err != nil {
			continue
		}

		if req.Type != "execute" || req.Action == "" {
			continue
		}

		go e.handle(req.ID, req.Action, req.Params)
	}
}

func (e *Executor) handle(id, action string, params map[string]any) {
	switch action {
	case "scan", "scanOnly":
		e.handleScan(id, action, params)
	case "fetchAll":
		e.handleFetchAll(id)
	case "commitPush":
		e.handleCommitPush(id, params)
	case "pull":
		e.handlePull(id, params)
	case "push":
		e.handlePush(id, params)
	case "rescanRepo":
		e.handleRescanRepo(id, params)
	case "checkPull":
		e.handleCheckPull(id, params)
	case "updateRepoSettings":
		e.handleUpdateRepoSettings(id, params)
	case "setConfig":
		e.handleSetConfig(id, params)
	case "cancelScan":
		CancelScan()
		e.ws.SendResult(id, map[string]bool{"ok": true})
	case "cancelCommit":
		e.ws.SendResult(id, map[string]bool{"ok": true})
	case "cancelFetch":
		e.ws.SendResult(id, map[string]bool{"ok": true})
	default:
		e.ws.SendError(id, fmt.Sprintf("unknown action: %s", action))
	}
}

func (e *Executor) handleScan(id, action string, params map[string]any) {
	rootDir, _ := params["rootDir"].(string)
	if rootDir == "" {
		e.ws.SendError(id, `Missing "rootDir" parameter`)
		return
	}

	ResetCancel()
	e.cache.AddScannedDir(rootDir)

	progressCh := make(chan ScanProgress, 100)
	ctx := context.Background()

	if action == "scan" {
		go scanAll(ctx, e.git, e.cache, rootDir, "local", progressCh)
	} else {
		go scanOnly(ctx, e.git, e.cache, rootDir, "local", progressCh)
	}

	for p := range progressCh {
		if err := e.ws.SendProgress(id, p); err != nil {
			CancelScan()
			return
		}
	}

	e.ws.SendReposUpdate(getLocalRepos(e.cache))
	e.ws.SendDone(id)
}

func (e *Executor) handleFetchAll(id string) {
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
		e.ws.SendProgress(id, fp)
	}

	allRepos, err := e.cache.Load()
	if err != nil {
		e.ws.SendError(id, err.Error())
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
		e.ws.SendDone(id)
		return
	}

	sendProgress("fetching", 0, total, nil, nil, nil, nil, nil, nil)

	ctx := context.Background()
	for i, repo := range localRepos {
		if scanCanceled {
			break
		}

		name := repo.Name
		sendProgress("repo", i, total, &repo.Path, &name, nil, nil, nil, nil)

		e.git.RunWithLock(ctx, "fetch origin", repo.Path, 30*time.Second)
		status, _ := e.git.GetStatusWithLock(ctx, repo.Path)

		var a, b *int
		if status != nil {
			a = &status.Ahead
			b = &status.Behind
			updateRepoInCache(e.git, e.cache, repo.Path)
		}
		sendProgress("repo", i+1, total, &repo.Path, &name, a, b, repo.Branch, nil)
	}

	sendProgress("done", total, total, nil, nil, nil, nil, nil, nil)
	e.ws.SendReposUpdate(getLocalRepos(e.cache))
	e.ws.SendDone(id)
}

func (e *Executor) handleCommitPush(id string, params map[string]any) {
	repo, _ := params["repo"].(string)
	if repo == "" {
		e.ws.SendError(id, `Missing "repo" parameter`)
		return
	}

	ctx := context.Background()

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
		e.ws.SendProgress(id, cp)
	}

	sendProgress := func(phase string) {
		send(phase, nil)
	}

	sendProgress("staging")
	_, err := e.git.RunWithLock(ctx, "add .", repo, 15*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		e.ws.SendDone(id)
		return
	}

	branch, err := e.git.RunWithLock(ctx, "rev-parse --abbrev-ref HEAD", repo, 5*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		e.ws.SendDone(id)
		return
	}

	stagedSummary, _ := e.git.Run(ctx, "diff --cached --stat", repo, 10*time.Second)
	stagedPatch, _ := e.git.Run(ctx, "diff --cached", repo, 10*time.Second)

	if stagedPatch == "" {
		send("error", map[string]any{"error": "No changes to commit"})
		e.ws.SendDone(id)
		return
	}

	sendProgress("generating")
	cfg, _ := e.cache.LoadConfig()
	model := cfg.OpenCodeModel
	if model == "" {
		model = "CrofAI/deepseek-v4-flash"
	}

	commitMsg, err := generateCommitMessage(ctx, repo, branch, stagedSummary, stagedPatch, model)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		e.ws.SendDone(id)
		return
	}

	sendProgress("committing")
	fullMessage := commitMsg.Subject
	if commitMsg.Body != "" {
		fullMessage = commitMsg.Subject + "\n\n" + commitMsg.Body
	}
	_, err = e.git.RunWithLock(ctx, fmt.Sprintf(`commit -m "%s"`, escapeCommitMsg(fullMessage)), repo, 15*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		e.ws.SendDone(id)
		return
	}

	sendProgress("pushing")
	_, err = e.git.RunWithLock(ctx, "push", repo, 60*time.Second)
	if err != nil {
		send("error", map[string]any{"error": err.Error()})
		e.ws.SendDone(id)
		return
	}

	updateRepoInCache(e.git, e.cache, repo)
	send("done", map[string]any{"subject": commitMsg.Subject, "body": commitMsg.Body})
	e.ws.SendReposUpdate(getLocalRepos(e.cache))
	e.ws.SendDone(id)
}

func (e *Executor) handlePull(id string, params map[string]any) {
	repo, _ := params["repo"].(string)
	if repo == "" {
		e.ws.SendError(id, `Missing "repo" parameter`)
		return
	}

	ctx := context.Background()
	output, err := e.git.RunWithLock(ctx, "pull", repo, 30*time.Second)
	if err != nil {
		e.ws.SendResult(id, PullPushResult{Ok: false, Error: strPtr(err.Error())})
		return
	}

	updateRepoInCache(e.git, e.cache, repo)
	e.ws.SendReposUpdate(getLocalRepos(e.cache))
	e.ws.SendResult(id, PullPushResult{Ok: true, Output: &output})
}

func (e *Executor) handlePush(id string, params map[string]any) {
	repo, _ := params["repo"].(string)
	if repo == "" {
		e.ws.SendError(id, `Missing "repo" parameter`)
		return
	}

	ctx := context.Background()
	output, err := e.git.RunWithLock(ctx, "push", repo, 60*time.Second)
	if err != nil {
		e.ws.SendResult(id, PullPushResult{Ok: false, Error: strPtr(err.Error())})
		return
	}

	updateRepoInCache(e.git, e.cache, repo)
	e.ws.SendReposUpdate(getLocalRepos(e.cache))
	e.ws.SendResult(id, PullPushResult{Ok: true, Output: &output})
}

func (e *Executor) handleRescanRepo(id string, params map[string]any) {
	repo, _ := params["repo"].(string)
	if repo == "" {
		e.ws.SendError(id, `Missing "repo" parameter`)
		return
	}

	ctx := context.Background()
	status, err := e.git.GetStatusWithLock(ctx, repo)
	if err != nil {
		e.ws.SendResult(id, RescanResult{Ok: false, Error: strPtr("Failed to get status")})
		return
	}

	updated := makeRepoFromStatus(repo, status)
	updateRepoInCache(e.git, e.cache, repo)
	e.ws.SendResult(id, RescanResult{Ok: true, Repo: &updated})
}

func (e *Executor) handleCheckPull(id string, params map[string]any) {
	repo, _ := params["repo"].(string)
	if repo == "" {
		e.ws.SendError(id, `Missing "repo" parameter`)
		return
	}

	ctx := context.Background()
	e.git.RunWithLock(ctx, "fetch origin", repo, 30*time.Second)

	status, err := e.git.GetStatusWithLock(ctx, repo)
	if err != nil {
		e.ws.SendResult(id, RescanResult{Ok: false, Error: strPtr("Failed to get status after fetch")})
		return
	}

	updated := makeRepoFromStatus(repo, status)
	updateRepoInCache(e.git, e.cache, repo)
	e.ws.SendResult(id, RescanResult{Ok: true, Repo: &updated})
}

func (e *Executor) handleUpdateRepoSettings(id string, params map[string]any) {
	repo, _ := params["repo"].(string)
	if repo == "" {
		e.ws.SendError(id, `Missing "repo" parameter`)
		return
	}

	repos, err := e.cache.Load()
	if err != nil {
		repos, _ = e.cache.Load()
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

	e.cache.Save(updated)
	e.ws.SendResult(id, map[string]bool{"ok": true})
}

func (e *Executor) handleSetConfig(id string, params map[string]any) {
	existing, _ := e.cache.LoadConfig()

	if v, ok := params["rootDir"]; ok {
		if s, ok := v.(string); ok {
			existing.RootDir = s
			e.cache.AddScannedDir(s)
		}
	}
	if v, ok := params["opencodeModel"]; ok {
		if s, ok := v.(string); ok {
			existing.OpenCodeModel = s
		}
	}

	if err := e.cache.SaveConfig(existing); err != nil {
		e.ws.SendError(id, err.Error())
		return
	}

	e.ws.SendResult(id, map[string]bool{"ok": true})
}

// --- Helpers ---

func makeRepoFromStatus(repoPath string, status *GitStatusResult) GitRepo {
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
		Machine:        "local",
	}
}

func updateRepoInCache(git *GitService, cache *CacheService, repoPath string) {
	ctx := context.Background()
	status, err := git.GetStatus(ctx, repoPath)
	if err != nil {
		return
	}
	repos, err := cache.Load()
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
		Machine:        "local",
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

	cache.Save(repos)
}

func getLocalRepos(cache *CacheService) []GitRepo {
	repos, _ := cache.Load()
	return repos
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
