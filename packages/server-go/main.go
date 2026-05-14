package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	port := flag.Int("port", 3456, "HTTP server port")
	staticDir := flag.String("static", "", "Static files directory")
	devURL := flag.String("dev-url", "", "Dev URL to redirect to (e.g. http://localhost:8912)")
	flag.Parse()

	if v := os.Getenv("PORT"); v != "" {
		fmt.Sscanf(v, "%d", port)
	}
	if v := os.Getenv("STATIC_DIR"); v != "" {
		*staticDir = v
	}
	if v := os.Getenv("DEV_URL"); v != "" {
		*devURL = v
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		log.Fatalf("cannot get home dir: %v", err)
	}

	configDir := os.Getenv("CONFIG_DIR")
	if configDir == "" {
		configDir = filepath.Join(homeDir, ".git-glance")
	}

	cachePath := filepath.Join(configDir, "repo-cache.json")
	configPath := filepath.Join(configDir, "config.json")

	cache := NewCacheService(cachePath, configPath)
	git := NewGitService()

	remote := NewRemoteMachineService(
		func(machine string, repos []GitRepo) {
			cache.SetRemoteRepos(machine, repos)
		},
		nil,
	)

	// Start remote machine polling
	deps := &ServerDeps{Git: git, Cache: cache, Remote: remote}
	go func() {
		cfg, err := cache.LoadConfig()
		if err == nil {
			remote.StartPolling(context.Background(), cfg)
		}
	}()

	mux := http.NewServeMux()

	// WebSocket endpoint
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleWS(w, r, deps)
	})

	// Health endpoint (HTTP GET for backwards compat / health checks)
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"status":"ok"}`))
	})

	// Static file serving
	if *staticDir != "" {
		mux.Handle("/", serveStatic(*staticDir, *devURL))
	} else {
		// Try to find static files
		candidates := []string{
			filepath.Join("public"),
			filepath.Join("..", "desktop", "renderer-dist"),
		}
		found := ""
		for _, c := range candidates {
			abs, err := filepath.Abs(c)
			if err == nil {
				if _, err := os.Stat(filepath.Join(abs, "index.html")); err == nil {
					found = abs
					break
				}
			}
		}
		if found != "" {
			log.Printf("Serving static files from %s", found)
			mux.Handle("/", serveStatic(found, *devURL))
		} else {
			log.Printf("No static directory found, running API-only mode")
			mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"status":"git-glance API server"}`))
			})
		}
	}

	addr := fmt.Sprintf(":%d", *port)
	log.Printf("Starting server on %s", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func serveStatic(staticDir, devURL string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			http.Error(w, "WebSocket upgrade required", http.StatusUpgradeRequired)
			return
		}

		if devURL != "" && isLoopback(r.Host) {
			redirect := devURL + r.URL.Path
			if r.URL.RawQuery != "" {
				redirect += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, redirect, http.StatusFound)
			return
		}

		filePath := filepath.Join(staticDir, r.URL.Path)
		if r.URL.Path == "/" || !fileExists(filePath) {
			http.ServeFile(w, r, filepath.Join(staticDir, "index.html"))
			return
		}
		http.ServeFile(w, r, filePath)
	})
}

var loopbackHosts = map[string]bool{
	"127.0.0.1": true,
	"::1":       true,
	"localhost": true,
}

func isLoopback(host string) bool {
	h := strings.Split(host, ":")[0]
	return loopbackHosts[h]
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// main.go has no direct Go deps beyond stdlib
