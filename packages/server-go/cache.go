package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"
)

type CacheService struct {
	mu sync.RWMutex

	cachePath  string
	configPath string
	cacheDir   string
	configDir  string

	remoteRepos map[string][]GitRepo
	scannedDirs  []string
}

func NewCacheService(cachePath, configPath string) *CacheService {
	return &CacheService{
		cachePath:    cachePath,
		configPath:   configPath,
		cacheDir:     filepath.Dir(cachePath),
		configDir:    filepath.Dir(configPath),
		remoteRepos: make(map[string][]GitRepo),
	}
}

func snakeToCamel(s string) string {
	var b strings.Builder
	nextUpper := false
	for _, r := range s {
		if r == '_' {
			nextUpper = true
		} else if nextUpper {
			b.WriteRune(unicode.ToUpper(r))
			nextUpper = false
		} else {
			b.WriteRune(r)
		}
	}
	return b.String()
}

func normalizeKeys(v any) any {
	switch m := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(m))
		for k, val := range m {
			out[snakeToCamel(k)] = normalizeKeys(val)
		}
		return out
	case []any:
		for i, val := range m {
			m[i] = normalizeKeys(val)
		}
		return m
	default:
		return v
	}
}

func (c *CacheService) Load() ([]GitRepo, error) {
	raw, err := os.ReadFile(c.cachePath)
	if err != nil {
		return []GitRepo{}, nil
	}
	// Normalize snake_case keys from Rust server to camelCase expected by Go struct
	var rawAny any
	if err := json.Unmarshal(raw, &rawAny); err == nil {
		rawAny = normalizeKeys(rawAny)
		if normalized, err := json.Marshal(rawAny); err == nil {
			raw = normalized
		}
	}
	var repos []GitRepo
	if err := json.Unmarshal(raw, &repos); err != nil {
		return []GitRepo{}, nil
	}
	return repos, nil
}

func (c *CacheService) Save(repos []GitRepo) error {
	if err := os.MkdirAll(c.cacheDir, 0755); err != nil {
		return err
	}
	data, err := json.Marshal(repos)
	if err != nil {
		return err
	}
	return os.WriteFile(c.cachePath, data, 0644)
}

func (c *CacheService) LoadConfig() (PersistedConfig, error) {
	raw, err := os.ReadFile(c.configPath)
	if err != nil {
		return PersistedConfig{}, nil
	}
	var cfg PersistedConfig
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return PersistedConfig{}, nil
	}
	return cfg, nil
}

func (c *CacheService) SaveConfig(cfg PersistedConfig) error {
	if err := os.MkdirAll(c.configDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(c.configPath, data, 0644)
}

func (c *CacheService) GetScannedDirs() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]string, len(c.scannedDirs))
	copy(out, c.scannedDirs)
	return out
}

func (c *CacheService) AddScannedDir(dir string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, d := range c.scannedDirs {
		if d == dir {
			return
		}
	}
	c.scannedDirs = append(c.scannedDirs, dir)
}

func (c *CacheService) SetRemoteRepos(machine string, repos []GitRepo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.remoteRepos[machine] = repos
}

func (c *CacheService) ClearRemoteRepos(machine string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.remoteRepos, machine)
}

func (c *CacheService) GetAllRepos() ([]GitRepo, error) {
	local, err := c.Load()
	if err != nil {
		return nil, err
	}
	c.mu.RLock()
	defer c.mu.RUnlock()
	all := make([]GitRepo, len(local))
	copy(all, local)
	for _, repos := range c.remoteRepos {
		all = append(all, repos...)
	}
	return all, nil
}
