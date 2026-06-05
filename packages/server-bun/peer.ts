import type {
  GitRepo,
  MachineState,
  MachineStatus,
  PeerEnvelope,
  PeerPullPushPayload,
  PullPushResult,
  PersistedConfig,
  ServerConfigMachine,
} from "./types";
import type { CacheService } from "./cache";
import type { GitService } from "./git";

class PeerConnection {
  private ws: WebSocket | null = null;
  private pending = new Map<string, (env: PeerEnvelope) => void>();
  private ctx: AbortController;

  constructor(
    public name: string,
    public url: string,
    public token: string,
    private manager: PeerManager,
  ) {
    this.ctx = new AbortController();
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const u = new URL(this.url);
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        u.pathname = "/peer";

        const ws = new WebSocket(u.toString());
        this.ws = ws;

        ws.onopen = () => {
          this.write({ type: "auth", token: this.token });
          console.log(`[peer] auth sent to ${this.name}`);
          resolve();
        };

        ws.onmessage = (ev) => {
          try {
            const env: PeerEnvelope = JSON.parse(ev.data as string);
            this.handleEnvelope(env);
          } catch {}
        };

        ws.onclose = () => {
          this.manager.onPeerDisconnected(this.name);
        };

        ws.onerror = () => {
          reject(new Error(`peer dial ${this.url}`));
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  write(msg: PeerEnvelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ctx.abort();
    this.ws?.close();
  }

  private handleEnvelope(env: PeerEnvelope): void {
    switch (env.type) {
      case "auth": {
        const ok = env.token !== "" && env.token === this.manager.localToken;
        this.write({
          type: "auth",
          id: env.id,
          ok,
          error: ok ? undefined : "invalid token",
        });
        break;
      }
      case "res": {
        const ch = this.pending.get(env.id!);
        this.pending.delete(env.id!);
        if (ch) ch(env);
        break;
      }
      case "push":
        this.manager.onPeerPush(this.name, env);
        break;
      case "req":
        this.handleRequest(env);
        break;
    }
  }

  private async handleRequest(env: PeerEnvelope): Promise<void> {
    const resp: PeerEnvelope = { type: "res", id: env.id };

    switch (env.action) {
      case "getRepos": {
        try {
          const repos = this.manager.cache.getAllRepos();
          const local = repos
            .filter(
              (r) =>
                r.machine === this.manager.localName || r.machine === "",
            )
            .map((r) => ({ ...r, machine: this.manager.localName }));
          resp.ok = true;
          resp.payload = { repos: local };
        } catch (err: any) {
          resp.ok = false;
          resp.error = err.message;
        }
        break;
      }
      case "pull": {
        const pp: PeerPullPushPayload = env.payload;
        try {
          const output = await this.manager.git.runWithLock(
            ["pull"],
            pp.path,
            30_000,
          );
          resp.ok = true;
          resp.payload = { ok: true, output };
        } catch (err: any) {
          resp.ok = false;
          resp.error = err.message;
        }
        break;
      }
      case "push": {
        const pp: PeerPullPushPayload = env.payload;
        try {
          const output = await this.manager.git.runWithLock(
            ["push"],
            pp.path,
            60_000,
          );
          resp.ok = true;
          resp.payload = { ok: true, output };
        } catch (err: any) {
          resp.ok = false;
          resp.error = err.message;
        }
        break;
      }
      default:
        resp.ok = false;
        resp.error = `unknown action: ${env.action}`;
    }

    this.write(resp);
  }

  async request(
    action: string,
    payload?: any,
  ): Promise<PeerEnvelope> {
    const id = `${this.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`peer request ${action} timed out`));
      }, 30_000);

      this.pending.set(id, (env) => {
        clearTimeout(timer);
        resolve(env);
      });

      this.write({ type: "req", id, action, payload });
    });
  }
}

export class PeerManager {
  private peers = new Map<string, PeerConnection>();
  private machines: MachineState[] = [];
  private machineHandlers: ((states: MachineState[]) => void)[] = [];

  constructor(
    public localName: string,
    public localToken: string,
    public cache: CacheService,
    public git: GitService,
  ) {}

  onMachineStatus(fn: (states: MachineState[]) => void): void {
    this.machineHandlers.push(fn);
  }

  private fireMachineStatus(): void {
    const machines = [...this.machines];
    for (const fn of this.machineHandlers) {
      fn(machines);
    }
  }

  updateConfig(config: PersistedConfig): void {
    const byName = new Map<string, ServerConfigMachine>();
    for (const m of config.machines ?? []) {
      byName.set(m.name, m);
    }

    // Disconnect removed peers
    for (const [name, peer] of this.peers) {
      if (!byName.has(name)) {
        peer.close();
        this.peers.delete(name);
        this.cache.clearRemoteRepos(name);
        console.log(`[peer] disconnected from ${name}`);
      }
    }

    // Connect new or updated peers
    this.machines = [];
    for (const m of config.machines ?? []) {
      const state: MachineState = {
        name: m.name,
        url: m.url,
        token: m.token ?? "",
        online: false,
        lastSeen: null,
      };
      this.machines.push(state);

      const existing = this.peers.get(m.name);
      if (existing) {
        if (existing.url === m.url && existing.token === m.token) {
          state.online = true;
          continue;
        }
        existing.close();
      }

      if (m.url && m.token) {
        this.connectPeer(m.name, m.url, m.token);
      }
    }

    setTimeout(() => this.fireMachineStatus(), 0);
  }

  private connectPeer(
    name: string,
    remoteURL: string,
    token: string,
  ): void {
    const peer = new PeerConnection(name, remoteURL, token, this);
    this.peers.set(name, peer);

    (async () => {
      let backoff = 1000;
      const maxBackoff = 60_000;

      while (true) {
        console.log(`[peer] connecting to ${name} at ${remoteURL}`);
        try {
          await peer.connect();

          const now = Date.now();
          for (const m of this.machines) {
            if (m.name === name) {
              m.online = true;
              m.lastSeen = now;
              break;
            }
          }
          this.fireMachineStatus();

          // Fetch initial repos on connect
          this.fetchRemoteRepos(name).catch(() => {});

          // Wait for disconnect (peer ctx abort)
          await new Promise<void>((resolve) => {
            peer["ctx"].signal.addEventListener(
              "abort",
              () => resolve(),
              { once: true },
            );
          });
          return;
        } catch (err: any) {
          console.log(
            `[peer] connection to ${name} failed: ${err.message} (retry in ${backoff}ms)`,
          );

          for (const m of this.machines) {
            if (m.name === name) {
              m.online = false;
              break;
            }
          }
          this.fireMachineStatus();

          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, maxBackoff);
        }
      }
    })();
  }

  onPeerDisconnected(name: string): void {
    for (const m of this.machines) {
      if (m.name === name) {
        m.online = false;
        break;
      }
    }
    this.cache.clearRemoteRepos(name);
    this.fireMachineStatus();
  }

  onPeerPush(machine: string, env: PeerEnvelope): void {
    if (env.event === "reposUpdated") {
      this.fetchRemoteRepos(machine).catch(() => {});
    }
  }

  private async fetchRemoteRepos(machine: string): Promise<void> {
    const peer = this.peers.get(machine);
    if (!peer) return;

    try {
      const env = await peer.request("getRepos");
      if (!env.ok) {
        console.log(
          `[peer] fetch repos from ${machine} error: ${env.error}`,
        );
        return;
      }

      const repos: GitRepo[] = env.payload.repos;
      const tagged = repos.map((r) => ({ ...r, machine }));
      this.cache.setRemoteRepos(machine, tagged);
      console.log(
        `[peer] received ${tagged.length} repos from ${machine}`,
      );
    } catch (err: any) {
      console.log(
        `[peer] fetch repos from ${machine} failed: ${err.message}`,
      );
    }
  }

  async proxyPull(
    machine: string,
    repoPath: string,
  ): Promise<PullPushResult> {
    const peer = this.peers.get(machine);
    if (!peer) {
      return { ok: false, output: null, error: "peer not connected" };
    }

    try {
      const env = await peer.request("pull", { path: repoPath });
      if (!env.ok) {
        return {
          ok: false,
          output: null,
          error: env.error ?? "pull failed",
        };
      }
      return env.payload as PullPushResult;
    } catch (err: any) {
      return { ok: false, output: null, error: err.message };
    }
  }

  async proxyPush(
    machine: string,
    repoPath: string,
  ): Promise<PullPushResult> {
    const peer = this.peers.get(machine);
    if (!peer) {
      return { ok: false, output: null, error: "peer not connected" };
    }

    try {
      const env = await peer.request("push", { path: repoPath });
      if (!env.ok) {
        return {
          ok: false,
          output: null,
          error: env.error ?? "push failed",
        };
      }
      return env.payload as PullPushResult;
    } catch (err: any) {
      return { ok: false, output: null, error: err.message };
    }
  }

  getStatuses(): MachineStatus[] {
    return this.machines.map((m) => ({
      name: m.name,
      url: m.url,
      online: m.online,
      lastSeen: m.lastSeen,
    }));
  }

  notifyReposUpdated(): void {
    for (const peer of this.peers.values()) {
      peer.write({ type: "push", event: "reposUpdated" });
    }
  }
}

// Incoming peer WebSocket handler for Bun
export function handleIncomingPeerWS(
  ws: WebSocket,
  pm: PeerManager,
): void {
  let authenticated = false;
  let peerName = "";

  ws.addEventListener("message", (ev) => {
    try {
      const env: PeerEnvelope = JSON.parse(ev.data as string);

      if (!authenticated) {
        if (env.type !== "auth") {
          ws.close(1008, "auth required");
          return;
        }
        if (!env.token || env.token !== pm.localToken) {
          ws.send(
            JSON.stringify({
              type: "auth",
              ok: false,
              error: "invalid token",
            }),
          );
          ws.close(1008, "invalid token");
          return;
        }
        authenticated = true;
        peerName = env.id ?? "";
        ws.send(JSON.stringify({ type: "auth", ok: true }));
        console.log(
          `[peer] authenticated incoming connection from ${peerName}`,
        );
        return;
      }

      if (env.type === "req") {
        handleIncomingPeerRequest(ws, env, pm);
      }
    } catch {}
  });
}

async function handleIncomingPeerRequest(
  ws: WebSocket,
  env: PeerEnvelope,
  pm: PeerManager,
): Promise<void> {
  const resp: PeerEnvelope = { type: "res", id: env.id };

  switch (env.action) {
    case "getRepos": {
      try {
        const repos = pm.cache.getAllRepos();
        const local = repos
          .filter(
            (r) => r.machine === pm.localName || r.machine === "",
          )
          .map((r) => ({ ...r, machine: pm.localName }));
        resp.ok = true;
        resp.payload = { repos: local };
      } catch (err: any) {
        resp.ok = false;
        resp.error = err.message;
      }
      break;
    }
    case "pull": {
      const pp: PeerPullPushPayload = env.payload;
      try {
        const output = await pm.git.runWithLock(
          ["pull"],
          pp.path,
          30_000,
        );
        resp.ok = true;
        resp.payload = { ok: true, output };
      } catch (err: any) {
        resp.ok = false;
        resp.error = err.message;
      }
      break;
    }
    case "push": {
      const pp: PeerPullPushPayload = env.payload;
      try {
        const output = await pm.git.runWithLock(
          ["push"],
          pp.path,
          60_000,
        );
        resp.ok = true;
        resp.payload = { ok: true, output };
      } catch (err: any) {
        resp.ok = false;
        resp.error = err.message;
      }
      break;
    }
    default:
      resp.ok = false;
      resp.error = `unknown action: ${env.action}`;
  }

  ws.send(JSON.stringify(resp));
}
