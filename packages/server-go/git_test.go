package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
)

func runGitTestCmd(t *testing.T, repoPath string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = repoPath
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com", "GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func writeTestFile(t *testing.T, repoPath, name, content string) {
	t.Helper()
	path := filepath.Join(repoPath, name)
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestGetStatusIncludesStagedUnstagedAndUntrackedFiles(t *testing.T) {
	repoPath := t.TempDir()
	runGitTestCmd(t, repoPath, "init", "-q")
	writeTestFile(t, repoPath, "staged.txt", "base\n")
	writeTestFile(t, repoPath, "unstaged.txt", "base\n")
	runGitTestCmd(t, repoPath, "add", ".")
	runGitTestCmd(t, repoPath, "commit", "-q", "-m", "initial")

	writeTestFile(t, repoPath, "staged.txt", "staged\n")
	runGitTestCmd(t, repoPath, "add", "staged.txt")
	writeTestFile(t, repoPath, "unstaged.txt", "unstaged\n")
	writeTestFile(t, repoPath, "untracked.txt", "new\n")

	status, err := NewGitService().GetStatus(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}

	if status.Staged != 1 || !reflect.DeepEqual(status.StagedFiles, []FileStatus{{Path: "staged.txt", Status: "M "}}) {
		t.Fatalf("staged = %d %#v", status.Staged, status.StagedFiles)
	}
	if status.Unstaged != 1 || !reflect.DeepEqual(status.UnstagedFiles, []FileStatus{{Path: "unstaged.txt", Status: " M"}}) {
		t.Fatalf("unstaged = %d %#v", status.Unstaged, status.UnstagedFiles)
	}
	if status.Untracked != 1 || !reflect.DeepEqual(status.UntrackedFiles, []FileStatus{{Path: "untracked.txt", Status: "??"}}) {
		t.Fatalf("untracked = %d %#v", status.Untracked, status.UntrackedFiles)
	}
}

func TestGetStatusPreservesLeadingSpaceForFirstUnstagedLine(t *testing.T) {
	repoPath := t.TempDir()
	runGitTestCmd(t, repoPath, "init", "-q")
	writeTestFile(t, repoPath, "package.json", "base\n")
	runGitTestCmd(t, repoPath, "add", ".")
	runGitTestCmd(t, repoPath, "commit", "-q", "-m", "initial")
	writeTestFile(t, repoPath, "package.json", "unstaged\n")

	status, err := NewGitService().GetStatus(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}

	if status.Staged != 0 || len(status.StagedFiles) != 0 {
		t.Fatalf("staged = %d %#v", status.Staged, status.StagedFiles)
	}
	if status.Unstaged != 1 || !reflect.DeepEqual(status.UnstagedFiles, []FileStatus{{Path: "package.json", Status: " M"}}) {
		t.Fatalf("unstaged = %d %#v", status.Unstaged, status.UnstagedFiles)
	}
}

func TestGetStatusIgnoresRepoConfigThatHidesUntrackedFiles(t *testing.T) {
	repoPath := t.TempDir()
	runGitTestCmd(t, repoPath, "init", "-q")
	writeTestFile(t, repoPath, "tracked.txt", "base\n")
	runGitTestCmd(t, repoPath, "add", ".")
	runGitTestCmd(t, repoPath, "commit", "-q", "-m", "initial")
	runGitTestCmd(t, repoPath, "config", "status.showUntrackedFiles", "no")
	writeTestFile(t, repoPath, "untracked.txt", "new\n")

	status, err := NewGitService().GetStatus(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if status.Untracked != 1 || !reflect.DeepEqual(status.UntrackedFiles, []FileStatus{{Path: "untracked.txt", Status: "??"}}) {
		t.Fatalf("untracked = %d %#v", status.Untracked, status.UntrackedFiles)
	}
}

func TestGetStatusParsesRenamedStagedFileAsNewPath(t *testing.T) {
	repoPath := t.TempDir()
	runGitTestCmd(t, repoPath, "init", "-q")
	writeTestFile(t, repoPath, "old.txt", "base\n")
	runGitTestCmd(t, repoPath, "add", ".")
	runGitTestCmd(t, repoPath, "commit", "-q", "-m", "initial")
	runGitTestCmd(t, repoPath, "mv", "old.txt", "new.txt")

	status, err := NewGitService().GetStatus(context.Background(), repoPath)
	if err != nil {
		t.Fatal(err)
	}
	if status.Staged != 1 || !reflect.DeepEqual(status.StagedFiles, []FileStatus{{Path: "new.txt", Status: "R "}}) {
		t.Fatalf("staged = %d %#v", status.Staged, status.StagedFiles)
	}
}
