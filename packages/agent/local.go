package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/coder/websocket"
)

type localSender struct {
	conn *websocket.Conn
	ctx  context.Context
	mu   sync.Mutex
}

func (s *localSender) sendJSON(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.conn.Write(s.ctx, websocket.MessageText, data)
}

func (s *localSender) SendResult(id string, data any) error {
	return s.sendJSON(map[string]any{"type": "result", "id": id, "data": data})
}

func (s *localSender) SendError(id string, errMsg string) error {
	return s.sendJSON(map[string]any{"type": "error", "id": id, "error": errMsg})
}

func (s *localSender) SendProgress(id string, data any) error {
	return s.sendJSON(map[string]any{"type": "progress", "id": id, "data": data})
}

func (s *localSender) SendDone(id string) error {
	return s.sendJSON(map[string]any{"type": "done", "id": id})
}

func (s *localSender) ReadMessage() ([]byte, error) {
	_, msg, err := s.conn.Read(s.ctx)
	return msg, err
}

func (s *localSender) SendReposUpdate(repos []GitRepo) error {
	return nil
}

func serveLocal(addr string, git *GitService, cache *CacheService) {
	mux := http.NewServeMux()
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		handleLocalWS(w, r, git, cache)
	})

	server := &http.Server{
		Addr:    addr,
		Handler: mux,
	}

	log.Printf("Local WebSocket server listening on %s", addr)
	if err := server.ListenAndServe(); err != nil {
		log.Fatalf("Local server error: %v", err)
	}
}

func handleLocalWS(w http.ResponseWriter, r *http.Request, git *GitService, cache *CacheService) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		log.Printf("WebSocket accept error: %v", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	ctx := r.Context()
	sender := &localSender{conn: conn, ctx: ctx}

	repos, _ := cache.Load()
	cfg, _ := cache.LoadConfig()
	if cfg.OpenCodeModel == "" {
		cfg.OpenCodeModel = "CrofAI/deepseek-v4-flash"
	}

	initMsg := map[string]any{
		"type":        "init",
		"agentOnline": true,
		"repos":       repos,
		"config":      cfg,
	}
	if err := sender.sendJSON(initMsg); err != nil {
		log.Printf("Failed to send init: %v", err)
		return
	}

	executor := NewExecutor(git, cache, sender, AgentConfig{})

	for {
		_, msg, err := conn.Read(ctx)
		if err != nil {
			log.Printf("Read error: %v", err)
			return
		}

		var req struct {
			ID     string         `json:"id"`
			Action string         `json:"action"`
			Params map[string]any `json:"params"`
		}
		if err := json.Unmarshal(msg, &req); err != nil {
			log.Printf("Invalid message: %v", err)
			continue
		}

		if req.ID == "" || req.Action == "" {
			continue
		}

		go executor.handle(req.ID, req.Action, req.Params)
	}
}
