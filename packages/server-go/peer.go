package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// ─── PeerConnection: a single WebSocket link to a remote machine ─────

type PeerConnection struct {
	mu      sync.Mutex
	conn    *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc

	name    string
	url     string
	token   string
	manager *PeerManager

	pending   map[string]chan<- PeerEnvelope
	pendingMu sync.Mutex
}

func newPeerConnection(ctx context.Context, name, remoteURL, token string, manager *PeerManager) *PeerConnection {
	ctx, cancel := context.WithCancel(ctx)
	return &PeerConnection{
		ctx:     ctx,
		cancel:  cancel,
		name:    name,
		url:     remoteURL,
		token:   token,
		manager: manager,
		pending: make(map[string]chan<- PeerEnvelope),
	}
}

func (p *PeerConnection) connect() error {
	u, err := url.Parse(p.url)
	if err != nil {
		return fmt.Errorf("invalid peer URL %s: %w", p.url, err)
	}
	u.Scheme = "ws"
	u.Path = "/peer"

	conn, _, err := websocket.Dial(p.ctx, u.String(), nil)
	if err != nil {
		return fmt.Errorf("peer dial %s: %w", p.url, err)
	}
	p.mu.Lock()
	p.conn = conn
	p.mu.Unlock()

	auth, _ := json.Marshal(PeerEnvelope{Type: "auth", Token: p.token})
	if err := p.write(PeerEnvelope{Type: "auth", Token: p.token}); err != nil {
		conn.Close(websocket.StatusNormalClosure, "auth failed")
		return fmt.Errorf("peer auth send: %w", err)
	}

	log.Printf("[peer] auth sent to %s", p.name)
	_ = auth // used above
	go p.readLoop()
	return nil
}

func (p *PeerConnection) write(msg PeerEnvelope) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn == nil {
		return fmt.Errorf("peer %s: not connected", p.name)
	}
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return p.conn.Write(p.ctx, websocket.MessageText, data)
}

func (p *PeerConnection) readLoop() {
	defer p.manager.onPeerDisconnected(p.name)
	for {
		_, data, err := p.conn.Read(p.ctx)
		if err != nil {
			return
		}
		var env PeerEnvelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		p.handleEnvelope(env)
	}
}

func (p *PeerConnection) handleEnvelope(env PeerEnvelope) {
	switch env.Type {
	case "auth":
		ok := env.Token != "" && env.Token == p.manager.localToken
		envResp := PeerEnvelope{Type: "auth", ID: env.ID, OK: ok}
		if !ok {
			envResp.Error = "invalid token"
		}
		p.write(envResp)

	case "res":
		p.pendingMu.Lock()
		ch, ok := p.pending[env.ID]
		delete(p.pending, env.ID)
		p.pendingMu.Unlock()
		if ok {
			ch <- env
		}

	case "push":
		p.manager.onPeerPush(p.name, env)

	case "req":
		go p.handleRequest(env)
	}
}

func (p *PeerConnection) handleRequest(env PeerEnvelope) {
	resp := PeerEnvelope{Type: "res", ID: env.ID}
	switch env.Action {
	case "getRepos":
		repos, err := p.manager.cache.GetAllRepos()
		if err != nil {
			resp.OK = false
			resp.Error = err.Error()
		} else {
			local := make([]GitRepo, 0, len(repos))
			for _, r := range repos {
				if r.Machine == p.manager.localName || r.Machine == "" {
					r.Machine = p.manager.localName
					local = append(local, r)
				}
			}
			data, _ := json.Marshal(map[string]any{"repos": local})
			resp.OK = true
			resp.Payload = data
		}

	case "pull":
		var pp PeerPullPushPayload
		json.Unmarshal(env.Payload, &pp)
		output, err := p.manager.git.RunWithLock(p.ctx, "pull", pp.Path, 30*time.Second)
		if err != nil {
			resp.OK = false
			resp.Error = err.Error()
		} else {
			data, _ := json.Marshal(PullPushResult{Ok: true, Output: &output})
			resp.OK = true
			resp.Payload = data
		}

	case "push":
		var pp PeerPullPushPayload
		json.Unmarshal(env.Payload, &pp)
		output, err := p.manager.git.RunWithLock(p.ctx, "push", pp.Path, 60*time.Second)
		if err != nil {
			resp.OK = false
			resp.Error = err.Error()
		} else {
			data, _ := json.Marshal(PullPushResult{Ok: true, Output: &output})
			resp.OK = true
			resp.Payload = data
		}

	default:
		resp.OK = false
		resp.Error = fmt.Sprintf("unknown action: %s", env.Action)
	}
	p.write(resp)
}

func (p *PeerConnection) request(action string, payload any) (PeerEnvelope, error) {
	id := fmt.Sprintf("%s-%d", p.name, time.Now().UnixNano())
	ch := make(chan PeerEnvelope, 1)

	p.pendingMu.Lock()
	p.pending[id] = ch
	p.pendingMu.Unlock()

	var raw json.RawMessage
	if payload != nil {
		raw, _ = json.Marshal(payload)
	}
	err := p.write(PeerEnvelope{Type: "req", ID: id, Action: action, Payload: raw})
	if err != nil {
		return PeerEnvelope{}, err
	}

	select {
	case env := <-ch:
		return env, nil
	case <-p.ctx.Done():
		return PeerEnvelope{}, p.ctx.Err()
	case <-time.After(30 * time.Second):
		return PeerEnvelope{}, fmt.Errorf("peer request %s timed out", action)
	}
}

// ─── PeerManager: manages all peer connections ──────────────────────

type PeerManager struct {
	mu         sync.RWMutex
	peers      map[string]*PeerConnection
	machines   []MachineState
	localName  string
	localToken string

	cache    *CacheService
	git      *GitService

	// For passing machine status updates to ws clients
	machineHandlers   []func([]MachineState)
	machineHandlersMu sync.RWMutex
}

func NewPeerManager(localName, localToken string, cache *CacheService, git *GitService) *PeerManager {
	return &PeerManager{
		peers:      make(map[string]*PeerConnection),
		localName:  localName,
		localToken: localToken,
		cache:      cache,
		git:        git,
	}
}

func (pm *PeerManager) OnMachineStatus(fn func([]MachineState)) {
	pm.machineHandlersMu.Lock()
	pm.machineHandlers = append(pm.machineHandlers, fn)
	pm.machineHandlersMu.Unlock()
}

func (pm *PeerManager) fireMachineStatus() {
	pm.mu.RLock()
	machines := make([]MachineState, len(pm.machines))
	copy(machines, pm.machines)
	pm.mu.RUnlock()

	pm.machineHandlersMu.RLock()
	for _, fn := range pm.machineHandlers {
		fn(machines)
	}
	pm.machineHandlersMu.RUnlock()
}

func (pm *PeerManager) UpdateConfig(config PersistedConfig) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	byName := make(map[string]ServerConfigMachine, len(config.Machines))
	for _, m := range config.Machines {
		byName[m.Name] = m
	}

	// Disconnect removed peers
	for name, peer := range pm.peers {
		if _, keep := byName[name]; !keep {
			peer.cancel()
			delete(pm.peers, name)
			pm.cache.ClearRemoteRepos(name)
			log.Printf("[peer] disconnected from %s", name)
		}
	}

	// Connect new or updated peers
	pm.machines = make([]MachineState, 0, len(config.Machines))
	for _, m := range config.Machines {
		state := MachineState{
			Name:   m.Name,
			URL:    m.URL,
			Token:  m.Token,
			Online: false,
		}
		pm.machines = append(pm.machines, state)

		if existing, ok := pm.peers[m.Name]; ok {
			if existing.url == m.URL && existing.token == m.Token {
				state.Online = true
				continue
			}
			existing.cancel()
		}

		if m.URL != "" && m.Token != "" {
			pm.connectPeer(m.Name, m.URL, m.Token)
		}
	}

	go pm.fireMachineStatus()
}

func (pm *PeerManager) connectPeer(name, remoteURL, token string) {
	peer := newPeerConnection(context.Background(), name, remoteURL, token, pm)
	pm.peers[name] = peer

	go func() {
		backoff := 1 * time.Second
		maxBackoff := 60 * time.Second
		for {
			log.Printf("[peer] connecting to %s at %s", name, remoteURL)
			if err := peer.connect(); err != nil {
				log.Printf("[peer] connection to %s failed: %v (retry in %v)", name, err, backoff)

				pm.mu.Lock()
				for i := range pm.machines {
					if pm.machines[i].Name == name {
						pm.machines[i].Online = false
						break
					}
				}
				pm.mu.Unlock()
				pm.fireMachineStatus()

				select {
				case <-time.After(backoff):
				case <-peer.ctx.Done():
					return
				}
				backoff *= 2
				if backoff > maxBackoff {
					backoff = maxBackoff
				}
				continue
			}

			now := time.Now().UnixMilli()
			pm.mu.Lock()
			for i := range pm.machines {
				if pm.machines[i].Name == name {
					pm.machines[i].Online = true
					pm.machines[i].LastSeen = &now
					break
				}
			}
			pm.mu.Unlock()
			pm.fireMachineStatus()

			// Fetch initial repos on connect
			go pm.fetchRemoteRepos(name)

			// Block until disconnected
			<-peer.ctx.Done()
			return
		}
	}()
}

func (pm *PeerManager) onPeerDisconnected(name string) {
	pm.mu.Lock()
	for i := range pm.machines {
		if pm.machines[i].Name == name {
			pm.machines[i].Online = false
			break
		}
	}
	pm.mu.Unlock()
	pm.cache.ClearRemoteRepos(name)
	pm.fireMachineStatus()
}

func (pm *PeerManager) onPeerPush(machine string, env PeerEnvelope) {
	switch env.Event {
	case "reposUpdated":
		go pm.fetchRemoteRepos(machine)
	}
}

func (pm *PeerManager) fetchRemoteRepos(machine string) {
	pm.mu.RLock()
	peer, ok := pm.peers[machine]
	pm.mu.RUnlock()
	if !ok {
		return
	}

	env, err := peer.request("getRepos", nil)
	if err != nil {
		log.Printf("[peer] fetch repos from %s failed: %v", machine, err)
		return
	}
	if !env.OK {
		log.Printf("[peer] fetch repos from %s error: %s", machine, env.Error)
		return
	}

	var result struct {
		Repos []GitRepo `json:"repos"`
	}
	if err := json.Unmarshal(env.Payload, &result); err != nil {
		log.Printf("[peer] parse repos from %s: %v", machine, err)
		return
	}

	tagged := make([]GitRepo, len(result.Repos))
	for i, repo := range result.Repos {
		repo.Machine = machine
		tagged[i] = repo
	}
	pm.cache.SetRemoteRepos(machine, tagged)
	log.Printf("[peer] received %d repos from %s", len(tagged), machine)
}

func (pm *PeerManager) ProxyPull(machine, repoPath string) (PullPushResult, error) {
	pm.mu.RLock()
	peer, ok := pm.peers[machine]
	pm.mu.RUnlock()
	if !ok {
		return PullPushResult{Ok: false, Error: strPtr("peer not connected")}, fmt.Errorf("peer %s not connected", machine)
	}

	env, err := peer.request("pull", PeerPullPushPayload{Path: repoPath})
	if err != nil {
		return PullPushResult{Ok: false, Error: strPtr(err.Error())}, err
	}
	if !env.OK {
		return PullPushResult{Ok: false, Error: &env.Error}, fmt.Errorf("pull on %s failed: %s", machine, env.Error)
	}

	var result PullPushResult
	json.Unmarshal(env.Payload, &result)
	return result, nil
}

func (pm *PeerManager) ProxyPush(machine, repoPath string) (PullPushResult, error) {
	pm.mu.RLock()
	peer, ok := pm.peers[machine]
	pm.mu.RUnlock()
	if !ok {
		return PullPushResult{Ok: false, Error: strPtr("peer not connected")}, fmt.Errorf("peer %s not connected", machine)
	}

	env, err := peer.request("push", PeerPullPushPayload{Path: repoPath})
	if err != nil {
		return PullPushResult{Ok: false, Error: strPtr(err.Error())}, err
	}
	if !env.OK {
		return PullPushResult{Ok: false, Error: &env.Error}, fmt.Errorf("push on %s failed: %s", machine, env.Error)
	}

	var result PullPushResult
	json.Unmarshal(env.Payload, &result)
	return result, nil
}

func (pm *PeerManager) GetStatuses() []MachineStatus {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	statuses := make([]MachineStatus, len(pm.machines))
	for i, m := range pm.machines {
		statuses[i] = MachineStatus{
			Name:     m.Name,
			URL:      m.URL,
			Online:   m.Online,
			LastSeen: m.LastSeen,
		}
	}
	return statuses
}

// ─── Incoming peer WebSocket handler ────────────────────────────────

func handlePeerWS(w http.ResponseWriter, r *http.Request, pm *PeerManager) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{"*"},
	})
	if err != nil {
		log.Printf("[peer] WS accept error: %v", err)
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	authenticated := false
	var peerName string

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			break
		}

		var env PeerEnvelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}

		if !authenticated {
			if env.Type != "auth" {
				conn.Close(websocket.StatusPolicyViolation, "auth required")
				return
			}
			if env.Token == "" || env.Token != pm.localToken {
				authResp, _ := json.Marshal(PeerEnvelope{Type: "auth", OK: false, Error: "invalid token"})
				conn.Write(ctx, websocket.MessageText, authResp)
				conn.Close(websocket.StatusPolicyViolation, "invalid token")
				return
			}
			authenticated = true
			peerName = env.ID // optional: remote machine can identify itself

			authResp, _ := json.Marshal(PeerEnvelope{Type: "auth", OK: true})
			conn.Write(ctx, websocket.MessageText, authResp)
			log.Printf("[peer] authenticated incoming connection from %s", peerName)
			continue
		}

		switch env.Type {
		case "req":
			go handleIncomingPeerRequest(ctx, conn, env, pm)
		}
	}
}

func handleIncomingPeerRequest(ctx context.Context, conn *websocket.Conn, env PeerEnvelope, pm *PeerManager) {
	resp := PeerEnvelope{Type: "res", ID: env.ID}

	switch env.Action {
	case "getRepos":
		repos, err := pm.cache.GetAllRepos()
		if err != nil {
			resp.OK = false
			resp.Error = err.Error()
		} else {
			local := make([]GitRepo, 0, len(repos))
			for _, r := range repos {
				if r.Machine == pm.localName || r.Machine == "" {
					r.Machine = pm.localName
					local = append(local, r)
				}
			}
			data, _ := json.Marshal(map[string]any{"repos": local})
			resp.OK = true
			resp.Payload = data
		}

	case "pull":
		var pp PeerPullPushPayload
		json.Unmarshal(env.Payload, &pp)
		output, err := pm.git.RunWithLock(ctx, "pull", pp.Path, 30*time.Second)
		if err != nil {
			resp.OK = false
			resp.Error = err.Error()
		} else {
			data, _ := json.Marshal(PullPushResult{Ok: true, Output: &output})
			resp.OK = true
			resp.Payload = data
		}

	case "push":
		var pp PeerPullPushPayload
		json.Unmarshal(env.Payload, &pp)
		output, err := pm.git.RunWithLock(ctx, "push", pp.Path, 60*time.Second)
		if err != nil {
			resp.OK = false
			resp.Error = err.Error()
		} else {
			data, _ := json.Marshal(PullPushResult{Ok: true, Output: &output})
			resp.OK = true
			resp.Payload = data
		}

	default:
		resp.OK = false
		resp.Error = fmt.Sprintf("unknown action: %s", env.Action)
	}

	data, _ := json.Marshal(resp)
	pmu := &sync.Mutex{}
	pmu.Lock()
	conn.Write(ctx, websocket.MessageText, data)
	pmu.Unlock()
}

// Broadcast reposUpdated push to all connected peers
func (pm *PeerManager) NotifyReposUpdated() {
	pm.mu.RLock()
	defer pm.mu.RUnlock()
	for _, peer := range pm.peers {
		peer.write(PeerEnvelope{Type: "push", Event: "reposUpdated"})
	}
}
