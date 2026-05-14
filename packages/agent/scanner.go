package main

import (
	"context"
	"os"
	"path/filepath"
	"time"
)

var scanCanceled bool

func CancelScan() {
	scanCanceled = true
}

func ResetCancel() {
	scanCanceled = false
}

func findGitRepos(rootDir string) []string {
	var repos []string
	filepath.Walk(rootDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return filepath.SkipDir
		}
		if info.Name() == ".git" && info.IsDir() {
			repos = append(repos, filepath.Dir(path))
			return filepath.SkipDir
		}
		if info.IsDir() && info.Name()[0] == '.' && info.Name() != ".git" {
			return filepath.SkipDir
		}
		if info.IsDir() && info.Name() == "node_modules" {
			return filepath.SkipDir
		}
		return nil
	})
	return repos
}

func scanOneRepo(ctx context.Context, git *GitService, repoPath, machine string) GitRepo {
	status, err := git.GetStatusWithLock(ctx, repoPath)
	name := filepath.Base(repoPath)
	if err != nil {
		errStr := err.Error()
		return GitRepo{
			Name:    name,
			Path:    repoPath,
			Machine: machine,
			Error:   &errStr,
		}
	}
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
		Machine:        machine,
	}
}

func mergeSettings(repo GitRepo, existingRepos []GitRepo) GitRepo {
	for _, e := range existingRepos {
		if e.Path == repo.Path && e.Settings != nil {
			repo.Settings = e.Settings
			break
		}
	}
	return repo
}

func scanGitReposConcurrently(ctx context.Context, git *GitService, repoPaths []string, machine string, existingRepos []GitRepo) ([]GitRepo, []int) {
	type result struct {
		index int
		repo  GitRepo
	}

	results := make([]GitRepo, len(repoPaths))
	sem := make(chan struct{}, 8)
	resCh := make(chan result, len(repoPaths))

	for i, path := range repoPaths {
		sem <- struct{}{}
		go func(idx int, p string) {
			defer func() { <-sem }()
			repoCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			repo := scanOneRepo(repoCtx, git, p, machine)
			repo = mergeSettings(repo, existingRepos)
			resCh <- result{idx, repo}
		}(i, path)
	}

	for i := 0; i < len(repoPaths); i++ {
		r := <-resCh
		results[r.index] = r.repo
	}

	scannedResults := make([]GitRepo, 0, len(repoPaths))
	fetchable := make([]int, 0)
	for i, repo := range results {
		if repo.Path != "" {
			scannedResults = append(scannedResults, repo)
			if !scanCanceled && repo.Settings != nil && !repo.Settings.SkipPullCheck && !repo.Settings.Hidden {
				fetchable = append(fetchable, i)
			}
		}
	}

	return scannedResults, fetchable
}

func fetchReposConcurrently(ctx context.Context, git *GitService, scannedResults []GitRepo, fetchable []int, progressCh chan<- ScanProgress) {
	if progressCh == nil {
		progressCh = make(chan ScanProgress, 100)
	}

	fetchTotal := len(fetchable)
	fetchSem := make(chan struct{}, 4)
	type fetchResult struct {
		index int
		repo  GitRepo
	}
	fetchRes := make(chan fetchResult, fetchTotal)

	for _, idx := range fetchable {
		if scanCanceled {
			break
		}
		fetchSem <- struct{}{}
		go func(i int) {
			defer func() { <-fetchSem }()

			repo := scannedResults[i]
			select {
			case progressCh <- ScanProgress{Phase: "fetching", Total: fetchTotal, Current: 0, Repo: &repo}:
			default:
			}

			fetchCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()

			git.RunWithLock(fetchCtx, "fetch origin", repo.Path, 30*time.Second)
			status, _ := git.GetStatusWithLock(ctx, repo.Path)
			if status != nil {
				now := time.Now().UnixMilli()
				commitTimeMs := int64(0)
				if status.LastCommitTime != nil {
					commitTimeMs = *status.LastCommitTime * 1000
				}
				updated := GitRepo{
					Name:           repo.Name,
					Path:           repo.Path,
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
					Machine:        repo.Machine,
					Settings:       repo.Settings,
				}
				fetchRes <- fetchResult{i, updated}
			} else {
				fetchRes <- fetchResult{i, repo}
			}
		}(idx)
	}

	for i := 0; i < fetchTotal; i++ {
		r := <-fetchRes
		scannedResults[r.index] = r.repo
		select {
		case progressCh <- ScanProgress{Phase: "fetching", Total: fetchTotal, Current: i + 1, Repo: &r.repo}:
		default:
		}
	}
}

func scanAll(ctx context.Context, git *GitService, cache *CacheService, rootDir, machine string, progressCh chan<- ScanProgress) {
	defer close(progressCh)

	repoPaths := findGitRepos(rootDir)
	total := len(repoPaths)

	existingRepos, _ := cache.Load()

	progressCh <- ScanProgress{Phase: "discovering", Total: total}

	scannedResults, fetchable := scanGitReposConcurrently(ctx, git, repoPaths, machine, existingRepos)

	for i, repo := range scannedResults {
		r := repo
		progressCh <- ScanProgress{Phase: "scanning", Total: total, Current: i + 1, Repo: &r}
	}

	if !scanCanceled {
		cache.Save(scannedResults)
	}

	fetchReposConcurrently(ctx, git, scannedResults, fetchable, progressCh)

	if !scanCanceled {
		cache.Save(scannedResults)
	}

	for i, repo := range scannedResults {
		r := repo
		progressCh <- ScanProgress{Phase: "fetching", Total: len(scannedResults), Current: i + 1, Repo: &r}
	}

	progressCh <- ScanProgress{Phase: "done", Total: len(scannedResults), Current: len(scannedResults)}
}

func scanOnly(ctx context.Context, git *GitService, cache *CacheService, rootDir, machine string, progressCh chan<- ScanProgress) {
	defer close(progressCh)

	repoPaths := findGitRepos(rootDir)
	total := len(repoPaths)

	existingRepos, _ := cache.Load()

	progressCh <- ScanProgress{Phase: "discovering", Total: total}

	scannedResults, _ := scanGitReposConcurrently(ctx, git, repoPaths, machine, existingRepos)

	for i, repo := range scannedResults {
		r := repo
		progressCh <- ScanProgress{Phase: "scanning", Total: total, Current: i + 1, Repo: &r}
	}

	if !scanCanceled {
		cache.Save(scannedResults)
	}

	progressCh <- ScanProgress{Phase: "done", Total: len(scannedResults), Current: len(scannedResults)}
}
