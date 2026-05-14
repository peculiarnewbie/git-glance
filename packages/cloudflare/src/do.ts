import { DurableObject } from "cloudflare:workers";
import type { AuthEnv } from "./auth";
import type { AgentState, AgentConfig } from "./types";

const AGENT_TAG = "agent";
const BROWSER_TAG = "browser";

export interface Env extends AuthEnv {
  GIT_GLANCE_DO: DurableObjectNamespace<GitGlanceDO>;
  GLANCE_SECRET?: string;
  ASSETS: Fetcher;
}

export class GitGlanceDO extends DurableObject<Env> {
  private agentState: AgentState = {
    agentId: "", online: false, lastSeen: null, repos: [], config: { rootDir: null, opencodeModel: "CrofAI/deepseek-v4-flash", machines: [] },
  };

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

    if (isAgent) {
      try {
        const state = this.ctx.storage.kv.get<AgentState>("agent");
        if (state) {
          this.agentState = state;
        }
      } catch (e) {
        console.log("[do] storage.kv.get error", e);
      }
      server.send(JSON.stringify({ type: "registered", state: this.agentState }));
    } else {
      server.send(JSON.stringify({
        type: "init",
        agentOnline: this.agentState.online,
        repos: this.agentState.repos,
        config: this.agentState.config,
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
    const { isAgent } = ws.deserializeAttachment() as { isAgent: boolean };
    if (isAgent) {
      this.agentState.online = false;
      this.agentState.lastSeen = Date.now();
      await this.ctx.storage.kv.put("agent", this.agentState);
      this.broadcastToBrowsers({ type: "agent_status", online: false });
    }
  }

  private async handleAgentMessage(ws: WebSocket, msg: any) {
    switch (msg.type) {
      case "register": {
        this.agentState = {
          agentId: msg.agentId || "default",
          online: true,
          lastSeen: Date.now(),
          repos: msg.repos || [],
          config: msg.config || this.agentState.config,
        };
        await this.ctx.storage.kv.put("agent", this.agentState);
        this.broadcastToBrowsers({ type: "agent_status", online: true });
        break;
      }
      case "register_repos": {
        this.agentState.repos = msg.repos || this.agentState.repos;
        await this.ctx.storage.kv.put("agent", this.agentState);
        break;
      }
      case "result":
      case "error":
      case "progress":
      case "done": {
        this.broadcastToBrowsers(msg);
        break;
      }
    }
  }

  private async handleBrowserMessage(ws: WebSocket, msg: any) {
    if (msg.action === "getRepos") {
      ws.send(JSON.stringify({
        id: msg.id, type: "result",
        data: { repos: this.agentState.repos, machines: [], scannedAt: 0, scannedDirs: [] },
      }));
      return;
    }

    if (msg.action === "getConfig") {
      ws.send(JSON.stringify({
        id: msg.id, type: "result",
        data: this.agentState.config,
      }));
      return;
    }

    if (msg.action === "setConfig") {
      this.agentState.config = { ...this.agentState.config, ...msg.params };
      await this.ctx.storage.kv.put("agent", this.agentState);
      this.forwardToAgent({ type: "execute", id: msg.id, action: msg.action, params: msg.params });
      return;
    }

    this.forwardToAgent({ type: "execute", id: msg.id, action: msg.action, params: msg.params });
  }

  private forwardToAgent(msg: { type: string; id: string; action: string; params?: any }) {
    const agents = this.ctx.getWebSockets(AGENT_TAG);
    if (agents.length === 0) {
      for (const browser of this.ctx.getWebSockets(BROWSER_TAG)) {
        browser.send(JSON.stringify({ id: msg.id, type: "error", error: "Agent is offline" }));
      }
      return;
    }
    agents[0].send(JSON.stringify(msg));
  }

  private broadcastToBrowsers(msg: any) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets(BROWSER_TAG)) {
      ws.send(data);
    }
  }
}
