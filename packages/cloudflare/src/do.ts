import { DurableObject } from "cloudflare:workers";
import type { AuthEnv } from "./auth";
import type { AgentState, MachineInfo } from "./types";

const AGENT_TAG = "agent";
const BROWSER_TAG = "browser";

export interface Env extends AuthEnv {
  GIT_GLANCE_DO: DurableObjectNamespace<GitGlanceDO>;
  GLANCE_SECRET?: string;
  ASSETS: Fetcher;
}

export class GitGlanceDO extends DurableObject<Env> {
  private agents = new Map<string, AgentState>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const all = await ctx.storage.kv.list<AgentState>({ prefix: "agent:" });
      for (const [key, state] of all) {
        if (state.agentId) {
          state.online = false;
          this.agents.set(state.agentId, state);
        }
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    console.log("[do] fetch", request.url);
    const [client, server] = Object.values(new WebSocketPair());
    const url = new URL(request.url);
    const isAgent = url.searchParams.has("token");

    server.serializeAttachment({ isAgent });

    try {
      this.ctx.acceptWebSocket(server, isAgent ? [AGENT_TAG] : [BROWSER_TAG]);
    } catch (e) {
      console.log("[do] acceptWebSocket error", e);
      return new Response("Internal error", { status: 500 });
    }

    if (!isAgent) {
      const machines: MachineInfo[] = [];
      const allRepos: any[] = [];
      for (const [agentId, state] of this.agents) {
        machines.push({ name: agentId, online: state.online, lastSeen: state.lastSeen });
        if (state.online) allRepos.push(...state.repos);
      }
      server.send(JSON.stringify({
        type: "init",
        repos: allRepos,
        machines,
      }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const msg = JSON.parse(message as string);
    const { isAgent } = ws.deserializeAttachment() as { isAgent: boolean };

    if (isAgent) {
      await this.handleAgentMessage(ws, msg);
    } else {
      await this.handleBrowserMessage(ws, msg);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as { isAgent: boolean; agentId?: string };
    if (att.isAgent && att.agentId) {
      const agentId = att.agentId;
      const state = this.agents.get(agentId);
      if (state) {
        state.online = false;
        state.lastSeen = Date.now();
        await this.ctx.storage.kv.put("agent:" + agentId, state);
      }
      this.agents.delete(agentId);
      this.broadcastAgentStatus();
    }
  }

  private async handleAgentMessage(ws: WebSocket, msg: any) {
    const att = ws.deserializeAttachment() as { isAgent: boolean; agentId?: string };

    switch (msg.type) {
      case "register": {
        const agentId = att?.agentId || msg.agentId || "default";
        ws.serializeAttachment({ isAgent: true, agentId });

        const state: AgentState = {
          agentId,
          online: true,
          lastSeen: Date.now(),
          repos: msg.repos || [],
          config: msg.config || { rootDir: null, opencodeModel: "CrofAI/deepseek-v4-flash" },
        };
        this.agents.set(agentId, state);
        await this.ctx.storage.kv.put("agent:" + agentId, state);
        ws.send(JSON.stringify({ type: "registered", agentId }));
        this.broadcastAgentStatus();
        break;
      }
      case "register_repos": {
        const agentId = att?.agentId;
        if (!agentId) break;
        const state = this.agents.get(agentId);
        if (state) {
          state.repos = msg.repos || state.repos;
          await this.ctx.storage.kv.put("agent:" + agentId, state);
        }
        this.broadcastToBrowsers({ type: "repos_update", agentId, repos: msg.repos || [] });
        break;
      }
      case "result":
      case "error":
      case "progress":
      case "done": {
        const agentId = att?.agentId;
        this.broadcastToBrowsers({ ...msg, agentId });
        break;
      }
    }
  }

  private async handleBrowserMessage(ws: WebSocket, msg: any) {
    if (msg.action === "getRepos") {
      const allRepos: any[] = [];
      const machines: MachineInfo[] = [];
      for (const [agentId, state] of this.agents) {
        if (state.online) allRepos.push(...state.repos);
        machines.push({ name: agentId, online: state.online, lastSeen: state.lastSeen });
      }
      ws.send(JSON.stringify({
        id: msg.id, type: "result",
        data: { repos: allRepos, machines, scannedAt: 0, scannedDirs: [] },
      }));
      return;
    }

    if (msg.action === "getConfig") {
      const machines: { name: string; online: boolean }[] = [];
      let rootDir: string | null = null;
      let offlineRoot: string | null = null;
      for (const [agentId, state] of this.agents) {
        machines.push({ name: agentId, online: state.online });
        if (state.online && state.config?.rootDir) {
          if (!rootDir) rootDir = state.config.rootDir;
        } else if (!state.online && state.config?.rootDir) {
          if (!offlineRoot) offlineRoot = state.config.rootDir;
        }
      }
      if (!rootDir) rootDir = offlineRoot;
      ws.send(JSON.stringify({
        id: msg.id, type: "result",
        data: { opencodeModel: "CrofAI/deepseek-v4-flash", machines, rootDir },
      }));
      return;
    }

    if (msg.action === "setConfig") {
      const firstAgent = this.agents.keys().next().value;
      if (firstAgent) {
        this.forwardToAgent(firstAgent, { type: "execute", id: msg.id, action: msg.action, params: msg.params });
      }
      return;
    }

    const machine = msg.params?.machine || msg.params?.agentId;
    console.log("[do] route", { action: msg.action, id: msg.id, machine, agentsSize: this.agents.size, agentIds: [...this.agents.keys()] });
    if (machine && this.agents.has(machine)) {
      this.forwardToAgent(machine, { type: "execute", id: msg.id, action: msg.action, params: msg.params });
    } else if (this.agents.size === 1) {
      const singleId = this.agents.keys().next().value!;
      console.log("[do] forwarding to single agent", singleId);
      this.forwardToAgent(singleId, { type: "execute", id: msg.id, action: msg.action, params: msg.params });
    } else {
      console.log("[do] no agent to route to", { machine, agentsSize: this.agents.size });
      ws.send(JSON.stringify({ id: msg.id, type: "error", error: "No online agent for machine: " + (machine || "unknown") }));
    }
  }

  private forwardToAgent(agentId: string, msg: { type: string; id: string; action: string; params?: any }) {
    const agents = this.ctx.getWebSockets(AGENT_TAG);
    console.log("[do] forwardToAgent", { agentId, action: msg.action, agentWsCount: agents.length, agentIds: agents.map(w => w.deserializeAttachment()) });
    for (const ws of agents) {
      const att = ws.deserializeAttachment() as { isAgent: boolean; agentId?: string };
      if (att.agentId === agentId) {
        ws.send(JSON.stringify(msg));
        return;
      }
    }
    for (const browser of this.ctx.getWebSockets(BROWSER_TAG)) {
      browser.send(JSON.stringify({ id: msg.id, type: "error", error: "Agent '" + agentId + "' is offline" }));
    }
  }

  private broadcastAgentStatus() {
    const machines: { name: string; online: boolean; lastSeen: number | null }[] = [];
    for (const [agentId, state] of this.agents) {
      machines.push({ name: agentId, online: state.online, lastSeen: state.lastSeen });
    }
    this.broadcastToBrowsers({ type: "machines", machines });
  }

  private broadcastToBrowsers(msg: any) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(BROWSER_TAG)) {
      ws.send(data);
    }
  }
}
