package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type AgentConfig struct {
	DOURL         string `json:"do_url"`
	Secret        string `json:"secret"`
	AgentID       string `json:"agent_id"`
	RootDir       string `json:"root_dir"`
	OpenCodeModel string `json:"opencode_model"`
}

func main() {
	remotePtr := flag.String("remote", "", "DO WebSocket URL (e.g. wss://git-glance.peculiarnewbie.com/ws)")
	rootDirPtr := flag.String("root", "", "Root directory to scan")
	flag.Parse()

	if *remotePtr != "" {
		os.Setenv("GLANCE_DO_URL", *remotePtr)
	}
	if *rootDirPtr != "" {
		os.Setenv("GLANCE_ROOT_DIR", *rootDirPtr)
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("cannot get home dir: %v", err)
	}

	configDir := filepath.Join(homeDir, ".git-glance")
	agentConfigPath := filepath.Join(configDir, "agent.json")
	cachePath := filepath.Join(configDir, "repo-cache.json")
	persistedConfigPath := filepath.Join(configDir, "config.json")

	cfg := readAgentConfig(agentConfigPath)

	if cfg.AgentID == "" {
		hostname, _ := os.Hostname()
		cfg.AgentID = hostname
	}

	cfg = promptMissing(cfg, agentConfigPath)

	cache := NewCacheService(cachePath, persistedConfigPath)
	git := NewGitService()
	agent := NewAgent(cfg, cache, git)
	agent.Run()
}

func promptMissing(cfg AgentConfig, path string) AgentConfig {
	stat, _ := os.Stdin.Stat()
	isTTY := stat.Mode()&os.ModeCharDevice != 0
	if !isTTY {
		return cfg
	}

	scanner := bufio.NewScanner(os.Stdin)

	if cfg.DOURL == "" {
		fmt.Print("Enter DO WebSocket URL (e.g. wss://git-glance-dev.workers.dev/ws): ")
		scanner.Scan()
		cfg.DOURL = strings.TrimSpace(scanner.Text())
	}

	if cfg.Secret == "" {
		fmt.Print("Enter GLANCE_SECRET: ")
		scanner.Scan()
		cfg.Secret = strings.TrimSpace(scanner.Text())
	}

	if cfg.RootDir == "" {
		fmt.Print("Enter root directory to scan (e.g. /home/bolt/git): ")
		scanner.Scan()
		cfg.RootDir = strings.TrimSpace(scanner.Text())
	} else {
		fmt.Printf("Root directory: %s\n", cfg.RootDir)
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err == nil {
		data, _ := json.MarshalIndent(cfg, "", "  ")
		os.WriteFile(path, data, 0644)
		fmt.Printf("Saved config to %s\n", path)
	}

	return cfg
}

func readAgentConfig(path string) AgentConfig {
	raw, err := os.ReadFile(path)
	if err != nil {
		log.Printf("No agent config found at %s, creating default", path)
		defaultCfg := AgentConfig{
			DOURL:   os.Getenv("GLANCE_DO_URL"),
			Secret:  os.Getenv("GLANCE_SECRET"),
			AgentID: os.Getenv("GLANCE_AGENT_ID"),
			RootDir: os.Getenv("GLANCE_ROOT_DIR"),
		}
		if defaultCfg.DOURL == "" {
			defaultCfg.DOURL = "ws://localhost:3456/ws"
		}
		return defaultCfg
	}
	var cfg AgentConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		log.Fatalf("invalid agent config: %v", err)
	}
	if v := os.Getenv("GLANCE_DO_URL"); v != "" {
		cfg.DOURL = v
	}
	if v := os.Getenv("GLANCE_SECRET"); v != "" {
		cfg.Secret = v
	}
	if v := os.Getenv("GLANCE_AGENT_ID"); v != "" {
		cfg.AgentID = v
	}
	if v := os.Getenv("GLANCE_ROOT_DIR"); v != "" {
		cfg.RootDir = v
	}
	return cfg
}

type Agent struct {
	cfg   AgentConfig
	cache *CacheService
	git   *GitService
}

func NewAgent(cfg AgentConfig, cache *CacheService, git *GitService) *Agent {
	return &Agent{cfg: cfg, cache: cache, git: git}
}

func (a *Agent) Run() {
	delay := 1 * time.Second
	maxDelay := 30 * time.Second

	for {
		log.Printf("Connecting to %s as %s...", a.cfg.DOURL, a.cfg.AgentID)

		ws, err := connectWS(a.cfg.DOURL, a.cfg.Secret)
		if err != nil {
			log.Printf("Connection failed: %v (retry in %v)", err, delay)
			time.Sleep(delay)
			delay = minDuration(delay*2, maxDelay)
			continue
		}

		delay = 1 * time.Second

		repos, _ := a.cache.Load()
		config := a.readConfig()

		changed := false
		for i, r := range repos {
			if r.Machine != "" && r.Machine != a.cfg.AgentID {
				repos[i].Machine = a.cfg.AgentID
				changed = true
			}
		}
		if changed {
			a.cache.Save(repos)
		}

		err = ws.Register(a.cfg.AgentID, repos, config)
		if err != nil {
			log.Printf("Register failed: %v", err)
			ws.Close()
			continue
		}

		log.Printf("Connected and registered as %s", a.cfg.AgentID)
		go func() {
			ticker := time.NewTicker(20 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ws.ctx.Done():
					return
				case <-ticker.C:
					if err := ws.SendHeartbeat(); err != nil {
						return
					}
				}
			}
		}()

		executor := NewClientExecutor(a.git, a.cache, ws, a.cfg)
		executor.Run()

		ws.Close()
		log.Printf("Disconnected, reconnecting...")
	}
}

func (a *Agent) readConfig() PersistedConfig {
	cfg, _ := a.cache.LoadConfig()
	if cfg.OpenCodeModel == "" {
		cfg.OpenCodeModel = "CrofAI/deepseek-v4-flash"
	}
	if a.cfg.OpenCodeModel != "" {
		cfg.OpenCodeModel = a.cfg.OpenCodeModel
	}
	return cfg
}

func minDuration(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}
