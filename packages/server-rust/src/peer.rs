use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message as TungMessage;
use futures::{SinkExt, StreamExt};
use axum::extract::ws::{Message as AxumMessage, WebSocket as AxumWebSocket};
use serde_json::json;

use crate::cache::CacheService;
use crate::git::GitService;
use crate::types::*;

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

fn now_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos()
}

// ─── PeerConnection: a single WebSocket link to a remote machine ─────

struct PeerConnectionInner {
    writer: Option<futures::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        TungMessage,
    >>,
    pending: HashMap<String, tokio::sync::oneshot::Sender<PeerEnvelope>>,
}

pub struct PeerConnection {
    inner: Arc<Mutex<PeerConnectionInner>>,
    name: String,
    url: String,
    token: String,
    manager_ref: Arc<PeerManager>,
}

impl PeerConnection {
    fn new(
        name: String,
        url: String,
        token: String,
        manager_ref: Arc<PeerManager>,
    ) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Mutex::new(PeerConnectionInner {
                writer: None,
                pending: HashMap::new(),
            })),
            name,
            url,
            token,
            manager_ref,
        })
    }

    pub async fn connect(self: &Arc<Self>) -> Result<(), String> {
        let ws_url = if let Ok(mut parsed) = url::Url::parse(&self.url) {
            parsed.set_scheme("ws").unwrap();
            parsed.set_path("/peer");
            parsed.to_string()
        } else {
            return Err(format!("invalid peer URL: {}", self.url));
        };

        let (ws_stream, _) = tokio_tungstenite::connect_async(&ws_url)
            .await
            .map_err(|e| format!("peer dial {}: {}", self.url, e))?;

        let (write, read) = ws_stream.split();

        {
            let mut inner = self.inner.lock().await;
            inner.writer = Some(write);
        }

        self.write_raw(&PeerEnvelope {
            envelope_type: "auth".to_string(),
            token: self.token.clone(),
            ..Default::default()
        })
        .await?;

        println!("[peer] auth sent to {}", self.name);

        let this = Arc::clone(self);
        let read_inner = Arc::clone(&this.inner);
        let manager_ref = Arc::clone(&self.manager_ref);

        tokio::spawn(async move {
            let mut read = read;
            loop {
                match read.next().await {
                    Some(Ok(TungMessage::Text(data))) => {
                        if let Ok(env) = serde_json::from_str::<PeerEnvelope>(&data) {
                            handle_outgoing_envelope(
                                &read_inner,
                                &manager_ref,
                                &this.name,
                                env,
                            )
                            .await;
                        }
                    }
                    Some(Ok(TungMessage::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            println!("[peer] disconnected from {}", this.name);
        });

        Ok(())
    }

    async fn write_raw(&self, msg: &PeerEnvelope) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        let writer = inner
            .writer
            .as_mut()
            .ok_or_else(|| format!("peer {}: not connected", self.name))?;
        let data = serde_json::to_string(msg).map_err(|e| format!("serialize: {}", e))?;
        writer
            .send(TungMessage::Text(data.into()))
            .await
            .map_err(|e| format!("write: {}", e))
    }

    pub async fn request(
        &self,
        action: &str,
        payload: Option<serde_json::Value>,
    ) -> Result<PeerEnvelope, String> {
        let id = format!("{}-{}", self.name, now_nanos());

        let (tx, rx) = tokio::sync::oneshot::channel();
        {
            let mut inner = self.inner.lock().await;
            inner.pending.insert(id.clone(), tx);
        }

        let env = PeerEnvelope {
            envelope_type: "req".to_string(),
            id: id.clone(),
            action: action.to_string(),
            payload,
            ..Default::default()
        };

        self.write_raw(&env).await?;

        match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(env)) => Ok(env),
            Ok(Err(_)) => {
                let mut inner = self.inner.lock().await;
                inner.pending.remove(&id);
                Err(format!("peer request {} dropped", action))
            }
            Err(_) => {
                let mut inner = self.inner.lock().await;
                inner.pending.remove(&id);
                Err(format!("peer request {} timed out", action))
            }
        }
    }

    pub async fn cancel(&self) {
        let mut inner = self.inner.lock().await;
        inner.writer = None;
        inner.pending.clear();
    }
}

async fn handle_outgoing_envelope(
    inner: &Arc<Mutex<PeerConnectionInner>>,
    manager: &Arc<PeerManager>,
    peer_name: &str,
    env: PeerEnvelope,
) {
    match env.envelope_type.as_str() {
        "auth" => {
            let ok = !env.token.is_empty() && env.token == manager.local_token;
            let resp = PeerEnvelope {
                envelope_type: "auth".to_string(),
                id: env.id,
                ok,
                error: if ok { String::new() } else { "invalid token".to_string() },
                ..Default::default()
            };
            let mut inner = inner.lock().await;
            if let Some(writer) = &mut inner.writer {
                if let Ok(data) = serde_json::to_string(&resp) {
                    let _ = writer.send(TungMessage::Text(data.into())).await;
                }
            }
        }
        "res" => {
            let mut inner = inner.lock().await;
            if let Some(ch) = inner.pending.remove(&env.id) {
                let _ = ch.send(env);
            }
        }
        "push" => {
            manager.on_peer_push(peer_name, env).await;
        }
        "req" => {
            let inner = Arc::clone(inner);
            let manager = Arc::clone(manager);
            let name = peer_name.to_string();
            tokio::spawn(async move {
                handle_outgoing_request(&inner, &manager, &name, env).await;
            });
        }
        _ => {}
    }
}

async fn handle_outgoing_request(
    inner: &Arc<Mutex<PeerConnectionInner>>,
    manager: &Arc<PeerManager>,
    _peer_name: &str,
    env: PeerEnvelope,
) {
    let mut resp = PeerEnvelope {
        envelope_type: "res".to_string(),
        id: env.id.clone(),
        ..Default::default()
    };

    match env.action.as_str() {
        "getRepos" => {
            let repos = manager.cache.get_all_repos().await;
            let local: Vec<GitRepo> = repos
                .into_iter()
                .filter(|r| r.machine == manager.local_name || r.machine.is_empty())
                .map(|mut r| {
                    if r.machine.is_empty() {
                        r.machine = manager.local_name.clone();
                    }
                    r
                })
                .collect();
            if let Ok(data) = serde_json::to_string(&json!({"repos": local})) {
                resp.ok = true;
                resp.payload = Some(serde_json::from_str(&data).unwrap_or_default());
            }
        }
        "pull" => {
            if let Some(payload) = &env.payload {
                if let Ok(pp) = serde_json::from_value::<PeerPullPushPayload>(payload.clone()) {
                    match manager.git.run_with_lock("pull", &pp.path, Duration::from_secs(30)).await {
                        Ok(output) => {
                            resp.ok = true;
                            resp.payload = Some(
                                serde_json::to_value(PullPushResult { ok: true, output: Some(output), error: None }).unwrap(),
                            );
                        }
                        Err(e) => resp.error = e.to_string(),
                    }
                }
            }
        }
        "push" => {
            if let Some(payload) = &env.payload {
                if let Ok(pp) = serde_json::from_value::<PeerPullPushPayload>(payload.clone()) {
                    match manager.git.run_with_lock("push", &pp.path, Duration::from_secs(60)).await {
                        Ok(output) => {
                            resp.ok = true;
                            resp.payload = Some(
                                serde_json::to_value(PullPushResult { ok: true, output: Some(output), error: None }).unwrap(),
                            );
                        }
                        Err(e) => resp.error = e.to_string(),
                    }
                }
            }
        }
        _ => {
            resp.error = format!("unknown action: {}", env.action);
        }
    }

    let mut guard = inner.lock().await;
    if let Some(writer) = &mut guard.writer {
        if let Ok(data) = serde_json::to_string(&resp) {
            let _ = writer.send(TungMessage::Text(data.into())).await;
        }
    }
}

// ─── PeerManager: manages all peer connections ──────────────────────

pub struct PeerManager {
    peers: RwLock<HashMap<String, Arc<PeerConnection>>>,
    machines: RwLock<Vec<MachineState>>,
    pub local_name: String,
    pub local_token: String,
    pub cache: Arc<CacheService>,
    pub git: Arc<GitService>,
}

impl PeerManager {
    pub fn new(
        local_name: String,
        local_token: String,
        cache: Arc<CacheService>,
        git: Arc<GitService>,
    ) -> Self {
        Self {
            peers: RwLock::new(HashMap::new()),
            machines: RwLock::new(Vec::new()),
            local_name,
            local_token,
            cache,
            git,
        }
    }

    pub async fn update_config(self: &Arc<Self>, config: &PersistedConfig) {
        let by_name: HashMap<&str, &ServerConfigMachine> =
            config.machines.iter().map(|m| (m.name.as_str(), m)).collect();

        // Disconnect removed peers
        {
            let mut peers = self.peers.write().await;
            let mut to_remove = Vec::new();
            for (name, peer) in peers.iter() {
                if !by_name.contains_key(name.as_str()) {
                    peer.cancel().await;
                    to_remove.push(name.clone());
                    self.cache.clear_remote_repos(name).await;
                    println!("[peer] disconnected from {}", name);
                }
            }
            for name in to_remove {
                peers.remove(&name);
            }
        }

        // Update machine list
        {
            let mut machines = self.machines.write().await;
            *machines = Vec::new();
            for m in &config.machines {
                let peers = self.peers.read().await;
                let online = peers.contains_key(&m.name);
                drop(peers);
                machines.push(MachineState {
                    name: m.name.clone(),
                    url: m.url.clone(),
                    token: m.token.clone(),
                    online,
                    last_seen: None,
                });
            }
        }

        // Connect new or updated peers
        for m in &config.machines {
            if m.url.is_empty() || m.token.is_empty() {
                continue;
            }

            {
                let peers = self.peers.read().await;
                if let Some(existing) = peers.get(&m.name) {
                    if existing.url == m.url && existing.token == m.token {
                        continue;
                    }
                    existing.cancel().await;
                }
            }

            let peer = PeerConnection::new(
                m.name.clone(),
                m.url.clone(),
                m.token.clone(),
                Arc::clone(self),
            );

            {
                let mut peers = self.peers.write().await;
                peers.insert(m.name.clone(), Arc::clone(&peer));
            }

            let pm = Arc::clone(self);
            let name = m.name.clone();
            let remote_url = m.url.clone();
            let token = m.token.clone();

            tokio::spawn(async move {
                let mut backoff = Duration::from_secs(1);
                let max_backoff = Duration::from_secs(60);
                loop {
                    println!("[peer] connecting to {} at {}", name, remote_url);

                    let fresh_peer = PeerConnection::new(
                        name.clone(),
                        remote_url.clone(),
                        token.clone(),
                        Arc::clone(&pm),
                    );

                    match fresh_peer.connect().await {
                        Ok(()) => {
                            {
                                let mut peers = pm.peers.write().await;
                                peers.insert(name.clone(), Arc::clone(&fresh_peer));
                            }

                            let now = now_millis();
                            {
                                let mut machines = pm.machines.write().await;
                                for m in machines.iter_mut() {
                                    if m.name == name {
                                        m.online = true;
                                        m.last_seen = Some(now);
                                        break;
                                    }
                                }
                            }

                            {
                                let pm2 = Arc::clone(&pm);
                                let name2 = name.clone();
                                tokio::spawn(async move {
                                    pm2.fetch_remote_repos(&name2).await;
                                });
                            }

                            // Wait indefinitely (read loop handles disconnect)
                            let () = std::future::pending().await;
                            return;
                        }
                        Err(e) => {
                            println!(
                                "[peer] connection to {} failed: {} (retry in {:?})",
                                name, e, backoff
                            );

                            {
                                let mut machines = pm.machines.write().await;
                                for m in machines.iter_mut() {
                                    if m.name == name {
                                        m.online = false;
                                        break;
                                    }
                                }
                            }

                            tokio::time::sleep(backoff).await;
                            backoff = (backoff * 2).min(max_backoff);
                        }
                    }
                }
            });
        }
    }

    #[allow(dead_code)]
    pub async fn on_peer_disconnected(&self, name: &str) {
        {
            let mut machines = self.machines.write().await;
            for m in machines.iter_mut() {
                if m.name == name {
                    m.online = false;
                    break;
                }
            }
        }
        self.cache.clear_remote_repos(name).await;
    }

    pub async fn on_peer_push(self: &Arc<Self>, machine: &str, env: PeerEnvelope) {
        if env.event == "reposUpdated" {
            let machine = machine.to_string();
            let pm = Arc::clone(self);
            tokio::spawn(async move {
                pm.fetch_remote_repos(&machine).await;
            });
        }
    }

    pub async fn fetch_remote_repos(&self, machine: &str) {
        let peer = {
            let peers = self.peers.read().await;
            peers.get(machine).cloned()
        };

        let peer = match peer {
            Some(p) => p,
            None => return,
        };

        let env = match peer.request("getRepos", None).await {
            Ok(e) => e,
            Err(e) => {
                println!("[peer] fetch repos from {} failed: {}", machine, e);
                return;
            }
        };

        if !env.ok {
            println!("[peer] fetch repos from {} error: {}", machine, env.error);
            return;
        }

        if let Some(payload) = &env.payload {
            if let Some(repos_val) = payload.get("repos") {
                if let Ok(repos) = serde_json::from_value::<Vec<GitRepo>>(repos_val.clone()) {
                    let tagged: Vec<GitRepo> = repos
                        .into_iter()
                        .map(|mut r| {
                            r.machine = machine.to_string();
                            r
                        })
                        .collect();
                    self.cache
                        .set_remote_repos(machine, tagged.clone())
                        .await;
                    println!(
                        "[peer] received {} repos from {}",
                        tagged.len(),
                        machine
                    );
                }
            }
        }
    }

    pub async fn proxy_pull(
        &self,
        machine: &str,
        repo_path: &str,
    ) -> Result<PullPushResult, String> {
        let peer = {
            let peers = self.peers.read().await;
            peers.get(machine).cloned()
        };

        let peer = peer.ok_or_else(|| format!("peer {} not connected", machine))?;

        let env = peer
            .request(
                "pull",
                Some(serde_json::to_value(PeerPullPushPayload {
                    path: repo_path.to_string(),
                })
                .unwrap()),
            )
            .await?;

        if !env.ok {
            return Err(format!("pull on {} failed: {}", machine, env.error));
        }

        env.payload
            .ok_or_else(|| "empty payload".to_string())
            .and_then(|p| serde_json::from_value(p).map_err(|e| e.to_string()))
    }

    pub async fn proxy_push(
        &self,
        machine: &str,
        repo_path: &str,
    ) -> Result<PullPushResult, String> {
        let peer = {
            let peers = self.peers.read().await;
            peers.get(machine).cloned()
        };

        let peer = peer.ok_or_else(|| format!("peer {} not connected", machine))?;

        let env = peer
            .request(
                "push",
                Some(serde_json::to_value(PeerPullPushPayload {
                    path: repo_path.to_string(),
                })
                .unwrap()),
            )
            .await?;

        if !env.ok {
            return Err(format!("push on {} failed: {}", machine, env.error));
        }

        env.payload
            .ok_or_else(|| "empty payload".to_string())
            .and_then(|p| serde_json::from_value(p).map_err(|e| e.to_string()))
    }

    pub async fn get_statuses(&self) -> Vec<MachineStatus> {
        let machines = self.machines.read().await;
        machines
            .iter()
            .map(|m| MachineStatus {
                name: m.name.clone(),
                url: m.url.clone(),
                online: m.online,
                last_seen: m.last_seen,
            })
            .collect()
    }

    pub async fn notify_repos_updated(&self) {
        let peers = self.peers.read().await;
        for peer in peers.values() {
            let env = PeerEnvelope {
                envelope_type: "push".to_string(),
                event: "reposUpdated".to_string(),
                ..Default::default()
            };
            let _ = peer.write_raw(&env).await;
        }
    }
}

// ─── Incoming peer WebSocket handler ────────────────────────────────

pub async fn handle_peer_ws(socket: AxumWebSocket, manager: Arc<PeerManager>) {
    println!("[peer] incoming connection");

    let (mut write, mut read) = socket.split();
    let mut authenticated = false;
    let mut _peer_name = String::new();

    while let Some(msg) = read.next().await {
        let msg = match msg {
            Ok(AxumMessage::Text(t)) => t,
            Ok(_) => continue,
            Err(_) => break,
        };

        let env: PeerEnvelope = match serde_json::from_str(&msg) {
            Ok(e) => e,
            Err(_) => continue,
        };

        if !authenticated {
            if env.envelope_type != "auth" {
                let _ = write
                    .send(AxumMessage::Text(
                        serde_json::to_string(&PeerEnvelope {
                            envelope_type: "auth".to_string(),
                            ok: false,
                            error: "auth required".to_string(),
                            ..Default::default()
                        })
                        .unwrap()
                        .into(),
                    ))
                    .await;
                let _ = write.close().await;
                return;
            }

            if env.token.is_empty() || env.token != manager.local_token {
                let _ = write
                    .send(AxumMessage::Text(
                        serde_json::to_string(&PeerEnvelope {
                            envelope_type: "auth".to_string(),
                            ok: false,
                            error: "invalid token".to_string(),
                            ..Default::default()
                        })
                        .unwrap()
                        .into(),
                    ))
                    .await;
                let _ = write.close().await;
                return;
            }

            authenticated = true;
            _peer_name = env.id.clone();

            let _ = write
                .send(AxumMessage::Text(
                    serde_json::to_string(&PeerEnvelope {
                        envelope_type: "auth".to_string(),
                        ok: true,
                        ..Default::default()
                    })
                    .unwrap()
                    .into(),
                ))
                .await;
            println!("[peer] authenticated incoming connection from {}", _peer_name);
            continue;
        }

        if env.envelope_type == "req" {
            let action = env.action.clone();
            let id = env.id.clone();
            let payload = env.payload.clone();

            let mut resp = PeerEnvelope {
                envelope_type: "res".to_string(),
                id: id.clone(),
                ..Default::default()
            };

            match action.as_str() {
                "getRepos" => {
                    let repos = manager.cache.get_all_repos().await;
                    let local: Vec<GitRepo> = repos
                        .into_iter()
                        .filter(|r| r.machine == manager.local_name || r.machine.is_empty())
                        .map(|mut r| {
                            if r.machine.is_empty() {
                                r.machine = manager.local_name.clone();
                            }
                            r
                        })
                        .collect();
                    if let Ok(data) = serde_json::to_string(&json!({"repos": local})) {
                        resp.ok = true;
                        resp.payload = Some(serde_json::from_str(&data).unwrap_or_default());
                    }
                }
                "pull" => {
                    if let Some(p) = &payload {
                        if let Ok(pp) = serde_json::from_value::<PeerPullPushPayload>(p.clone()) {
                            match manager
                                .git
                                .run_with_lock("pull", &pp.path, Duration::from_secs(30))
                                .await
                            {
                                Ok(output) => {
                                    resp.ok = true;
                                    resp.payload = Some(
                                        serde_json::to_value(PullPushResult { ok: true, output: Some(output), error: None }).unwrap(),
                                    );
                                }
                                Err(e) => resp.error = e.to_string(),
                            }
                        }
                    }
                }
                "push" => {
                    if let Some(p) = &payload {
                        if let Ok(pp) = serde_json::from_value::<PeerPullPushPayload>(p.clone()) {
                            match manager
                                .git
                                .run_with_lock("push", &pp.path, Duration::from_secs(60))
                                .await
                            {
                                Ok(output) => {
                                    resp.ok = true;
                                    resp.payload = Some(
                                        serde_json::to_value(PullPushResult { ok: true, output: Some(output), error: None }).unwrap(),
                                    );
                                }
                                Err(e) => resp.error = e.to_string(),
                            }
                        }
                    }
                }
                _ => {
                    resp.error = format!("unknown action: {}", action);
                }
            }

            if let Ok(data) = serde_json::to_string(&resp) {
                let _ = write.send(AxumMessage::Text(data.into())).await;
            }
        }
    }
}

impl Default for PeerEnvelope {
    fn default() -> Self {
        Self {
            envelope_type: String::new(),
            id: String::new(),
            token: String::new(),
            action: String::new(),
            event: String::new(),
            ok: false,
            error: String::new(),
            payload: None,
        }
    }
}
