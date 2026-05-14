package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
)

type CommitMessage struct {
	Subject string `json:"subject"`
	Body    string `json:"body"`
}

func truncate(s string, max int) string {
	if len(s) > max {
		return s[:max] + "\n... [truncated]"
	}
	return s
}

func buildPrompt(branch, stagedSummary, stagedPatch string) string {
	if branch == "" {
		branch = "(detached)"
	}
	return fmt.Sprintf(`You write concise git commit messages.
Return a JSON object with keys: subject, body.
Rules:
- subject must be imperative, <= 72 chars, and no trailing period
- body can be empty string or short bullet points
- capture the primary user-visible or developer-visible change

Branch: %s

Staged files:
%s

Staged patch:
%s`, branch, truncate(stagedSummary, 6000), truncate(stagedPatch, 40000))
}

func generateCommitMessage(ctx context.Context, repoPath, branch, stagedSummary, stagedPatch, model string) (*CommitMessage, error) {
	prompt := buildPrompt(branch, stagedSummary, stagedPatch)

	args := []string{"run", "--format", "json", "-m", model, "--dir", repoPath}
	cmd := exec.CommandContext(ctx, "opencode", args...)
	cmd.Dir = repoPath
	cmd.Stdin = strings.NewReader(prompt)

	var stdout bytes.Buffer
	cmd.Stdout = &stdout

	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("opencode failed: %w", err)
	}

	rawText := ""
	for _, line := range strings.Split(stdout.String(), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var ev struct {
			Type string `json:"type"`
			Part *struct {
				Text string `json:"text"`
			} `json:"part,omitempty"`
		}
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			continue
		}
		if ev.Type == "text" && ev.Part != nil {
			rawText += ev.Part.Text
		}
	}

	if rawText == "" {
		return nil, fmt.Errorf("no text response from opencode")
	}

	start := strings.Index(rawText, "{")
	end := strings.LastIndex(rawText, "}")
	if start < 0 || end < 0 {
		return nil, fmt.Errorf("could not parse JSON from opencode response")
	}

	var msg CommitMessage
	if err := json.Unmarshal([]byte(rawText[start:end+1]), &msg); err != nil {
		return nil, fmt.Errorf("could not parse JSON: %w", err)
	}

	msg.Subject = strings.TrimSpace(msg.Subject)
	msg.Body = strings.TrimSpace(msg.Body)

	if msg.Subject == "" {
		return nil, fmt.Errorf("no subject in commit message")
	}

	return &msg, nil
}
