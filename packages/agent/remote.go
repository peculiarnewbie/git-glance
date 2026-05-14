package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"
)

type RemoteMachineService struct {
	mu              sync.RWMutex
	machines        []MachineState
	setRemoteRepos  func(machine string, repos []GitRepo)
	httpClient      *http.Client
}

func NewRemoteMachineService(
	setRemoteRepos func(machine string, repos []GitRepo),
	httpClient *http.Client,
) *RemoteMachineService {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	return &RemoteMachineService{
		setRemoteRepos: setRemoteRepos,
		httpClient:     httpClient,
	}
}

func (r *RemoteMachineService) UpdateConfig(config PersistedConfig) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machines = make([]MachineState, len(config.Machines))
	for i, m := range config.Machines {
		r.machines[i] = MachineState{Name: m.Name, URL: m.URL}
	}
}

func (r *RemoteMachineService) StartPolling(ctx context.Context, config PersistedConfig) {
	r.UpdateConfig(config)
	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		r.pollAll(ctx)
		for {
			select {
			case <-ticker.C:
				r.pollAll(ctx)
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (r *RemoteMachineService) pollAll(ctx context.Context) {
	r.mu.RLock()
	machines := make([]MachineState, len(r.machines))
	copy(machines, r.machines)
	r.mu.RUnlock()

	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)

	for i := range machines {
		wg.Add(1)
		sem <- struct{}{}
		go func(m *MachineState) {
			defer wg.Done()
			defer func() { <-sem }()
			r.fetchMachineRepos(ctx, m)
		}(&machines[i])
	}
	wg.Wait()

	r.mu.Lock()
	r.machines = machines
	r.mu.Unlock()
}

func (r *RemoteMachineService) fetchMachineRepos(ctx context.Context, m *MachineState) {
	req, err := http.NewRequestWithContext(ctx, "GET", m.URL+"/repos", nil)
	if err != nil {
		m.Online = false
		r.setRemoteRepos(m.Name, nil)
		return
	}
	resp, err := r.httpClient.Do(req)
	if err != nil {
		m.Online = false
		r.setRemoteRepos(m.Name, nil)
		return
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		m.Online = false
		r.setRemoteRepos(m.Name, nil)
		return
	}

	var result struct {
		Repos []GitRepo `json:"repos"`
	}
	if err := json.Unmarshal(body, &result); err != nil {
		m.Online = false
		r.setRemoteRepos(m.Name, nil)
		return
	}

	tagged := make([]GitRepo, len(result.Repos))
	for i, repo := range result.Repos {
		repo.Machine = m.Name
		repo.Settings = nil
		tagged[i] = repo
	}

	now := time.Now().UnixMilli()
	m.Online = true
	m.LastSeen = &now
	r.setRemoteRepos(m.Name, tagged)
}

func (r *RemoteMachineService) GetStatuses() []MachineStatus {
	r.mu.RLock()
	defer r.mu.RUnlock()
	statuses := make([]MachineStatus, len(r.machines))
	for i, m := range r.machines {
		statuses[i] = MachineStatus{
			Name:     m.Name,
			URL:      m.URL,
			Online:   m.Online,
			LastSeen: m.LastSeen,
		}
	}
	return statuses
}

func (r *RemoteMachineService) ProxyRequest(ctx context.Context, machineName, method, path, reqBody string) (PullPushResult, error) {
	r.mu.RLock()
	var target *MachineState
	for i := range r.machines {
		if r.machines[i].Name == machineName {
			target = &r.machines[i]
			break
		}
	}
	r.mu.RUnlock()

	if target == nil {
		return PullPushResult{Ok: false, Error: strPtr("Unknown machine")}, fmt.Errorf("unknown machine: %s", machineName)
	}

	url := target.URL + path
	var req *http.Request
	var err error
	if reqBody != "" {
		req, err = http.NewRequestWithContext(ctx, method, url, bytes.NewBufferString(reqBody))
	} else {
		req, err = http.NewRequestWithContext(ctx, method, url, nil)
	}
	if err != nil {
		return PullPushResult{Ok: false, Error: strPtr(err.Error())}, err
	}

	resp, err := r.httpClient.Do(req)
	if err != nil {
		return PullPushResult{Ok: false, Error: strPtr(err.Error())}, err
	}
	defer resp.Body.Close()

	var result PullPushResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return PullPushResult{Ok: false, Error: strPtr(err.Error())}, err
	}
	return result, nil
}

func strPtr(s string) *string {
	return &s
}
