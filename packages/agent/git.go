package main

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

type GitCommandError struct {
	Command  string
	RepoPath string
	Cause    string
}

func (e *GitCommandError) Error() string {
	return fmt.Sprintf("git %s in %s: %s", e.Command, e.RepoPath, e.Cause)
}

type repoLock struct {
	ch chan struct{}
}

type GitService struct {
	mu     sync.Mutex
	locks  map[string]*repoLock
}

func NewGitService() *GitService {
	return &GitService{
		locks: make(map[string]*repoLock),
	}
}

func (g *GitService) withRepoLock(repoPath string) func() {
	g.mu.Lock()
	rl, ok := g.locks[repoPath]
	if !ok {
		rl = &repoLock{ch: make(chan struct{}, 1)}
		rl.ch <- struct{}{}
		g.locks[repoPath] = rl
	}
	g.mu.Unlock()
	<-rl.ch
	return func() {
		rl.ch <- struct{}{}
	}
}

func (g *GitService) execGit(ctx context.Context, args, repoPath string, timeout time.Duration) (string, error) {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	parts := strings.Fields(args)
	if len(parts) == 0 {
		return "", &GitCommandError{Command: "git", RepoPath: repoPath, Cause: "empty args"}
	}
	cmd := exec.CommandContext(ctx, "git", parts...)
	cmd.Dir = repoPath
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0")

	out, err := cmd.Output()
	if err != nil {
		return "", &GitCommandError{
			Command:  "git " + args,
			RepoPath: repoPath,
			Cause:    err.Error(),
		}
	}
	return strings.TrimSpace(string(out)), nil
}

func (g *GitService) execGitArgs(ctx context.Context, args []string, repoPath string, timeout time.Duration) (string, error) {
	if timeout == 0 {
		timeout = 10 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = repoPath
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0")

	out, err := cmd.Output()
	if err != nil {
		return "", &GitCommandError{
			Command:  "git " + strings.Join(args, " "),
			RepoPath: repoPath,
			Cause:    err.Error(),
		}
	}
	return strings.TrimSpace(string(out)), nil
}

func (g *GitService) safeExec(ctx context.Context, args, repoPath string, timeout time.Duration) *string {
	s, err := g.execGit(ctx, args, repoPath, timeout)
	if err != nil {
		return nil
	}
	return &s
}

func (g *GitService) Run(ctx context.Context, args, repoPath string, timeout time.Duration) (string, error) {
	return g.execGit(ctx, args, repoPath, timeout)
}

func (g *GitService) RunWithLock(ctx context.Context, args, repoPath string, timeout time.Duration) (string, error) {
	unlock := g.withRepoLock(repoPath)
	defer unlock()
	return g.execGit(ctx, args, repoPath, timeout)
}

func (g *GitService) RunWithLockArgs(ctx context.Context, args []string, repoPath string, timeout time.Duration) (string, error) {
	unlock := g.withRepoLock(repoPath)
	defer unlock()
	return g.execGitArgs(ctx, args, repoPath, timeout)
}

func (g *GitService) GetStatus(ctx context.Context, repoPath string) (*GitStatusResult, error) {
	rawStatus, err := g.execGit(ctx, "status --porcelain", repoPath, 10*time.Second)
	if err != nil {
		return nil, err
	}
	branch, err := g.execGit(ctx, "rev-parse --abbrev-ref HEAD", repoPath, 5*time.Second)
	if err != nil {
		return nil, err
	}
	remoteOption := g.safeExec(ctx, "rev-parse --abbrev-ref --symbolic-full-name @{upstream}", repoPath, 5*time.Second)

	var ahead, behind int
	if remoteOption != nil {
		revList := g.safeExec(ctx, "rev-list --left-right --count HEAD...@{upstream}", repoPath, 10*time.Second)
		if revList != nil {
			parts := strings.Fields(*revList)
			if len(parts) >= 2 {
				ahead, _ = strconv.Atoi(parts[0])
				behind, _ = strconv.Atoi(parts[1])
			}
		}
	}

	lines := strings.Split(rawStatus, "\n")
	var staged, unstaged, untracked int
	for _, l := range lines {
		if l == "" {
			continue
		}
		if strings.HasPrefix(l, "??") {
			untracked++
		} else {
			if l[0] != ' ' {
				staged++
			}
			if len(l) > 1 && l[1] != ' ' {
				unstaged++
			}
		}
	}
	hasChanges := staged > 0 || unstaged > 0 || untracked > 0

	var lastCommitTime *int64
	if lct := g.safeExec(ctx, "log -1 --format=%ct", repoPath, 5*time.Second); lct != nil {
		if t, err := strconv.ParseInt(*lct, 10, 64); err == nil {
			lastCommitTime = &t
		}
	}

	weekCommits := 0
	if lastCommitTime != nil && time.Since(time.Unix(*lastCommitTime, 0)) < 7*24*time.Hour {
		if raw := g.safeExec(ctx, `rev-list --count --since="1 week ago" HEAD`, repoPath, 10*time.Second); raw != nil {
			weekCommits, _ = strconv.Atoi(*raw)
		}
	}

	return &GitStatusResult{
		Branch:         branch,
		Remote:         remoteOption,
		HasChanges:     hasChanges,
		Staged:         staged,
		Unstaged:       unstaged,
		Untracked:      untracked,
		Ahead:          ahead,
		Behind:         behind,
		LastCommitTime: lastCommitTime,
		WeekCommits:    weekCommits,
	}, nil
}

func (g *GitService) GetStatusWithLock(ctx context.Context, repoPath string) (*GitStatusResult, error) {
	unlock := g.withRepoLock(repoPath)
	defer unlock()
	return g.GetStatus(ctx, repoPath)
}
