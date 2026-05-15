package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type WSClient struct {
	conn   *websocket.Conn
	ctx    context.Context
	cancel context.CancelFunc
	mu     sync.Mutex
}

func connectWS(wsURL, secret string) (*WSClient, error) {
	u, err := url.Parse(wsURL)
	if err != nil {
		return nil, fmt.Errorf("invalid URL: %w", err)
	}

	q := u.Query()
	q.Set("token", secret)
	u.RawQuery = q.Encode()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, u.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("dial failed: %w", err)
	}

	ctx2, cancel2 := context.WithCancel(context.Background())
	return &WSClient{conn: conn, ctx: ctx2, cancel: cancel2}, nil
}

func (c *WSClient) Register(agentId string, repos []GitRepo, config PersistedConfig) error {
	msg := map[string]any{
		"type":    "register",
		"agentId": agentId,
		"repos":   repos,
		"config":  config,
	}
	return c.sendJSON(msg)
}

func (c *WSClient) SendResult(id string, data any) error {
	log.Printf("[exec] id=%s ok", id)
	return c.sendJSON(map[string]any{"type": "result", "id": id, "data": data})
}

func (c *WSClient) SendError(id string, errMsg string) error {
	log.Printf("[exec] id=%s error: %s", id, errMsg)
	return c.sendJSON(map[string]any{"type": "error", "id": id, "error": errMsg})
}

func (c *WSClient) SendProgress(id string, data any) error {
	return c.sendJSON(map[string]any{"type": "progress", "id": id, "data": data})
}

func (c *WSClient) SendDone(id string) error {
	return c.sendJSON(map[string]any{"type": "done", "id": id})
}

func (c *WSClient) SendReposUpdate(repos []GitRepo) error {
	return c.sendJSON(map[string]any{"type": "register_repos", "repos": repos})
}

func (c *WSClient) ReadMessage() ([]byte, error) {
	_, msg, err := c.conn.Read(c.ctx)
	return msg, err
}

func (c *WSClient) Close() {
	c.cancel()
	c.conn.Close(websocket.StatusNormalClosure, "bye")
}

func (c *WSClient) sendJSON(v any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return c.conn.Write(c.ctx, websocket.MessageText, data)
}
