import { DurableObject } from "cloudflare:workers";
import type { AuthEnv } from "./auth";
import type { AgentState, MachineInfo } from "./types";
import { Effect } from "effect";

function logInfo(msg: string, extra?: Record<string, unknown>) {
  Effect.runFork(extra ? Effect.annotateLogs(Effect.logInfo(msg), extra) : Effect.logInfo(msg))
}
function logWarn(msg: string, extra?: Record<string, unknown>) {
  Effect.runFork(extra ? Effect.annotateLogs(Effect.logWarning(msg), extra) : Effect.logWarning(msg))
}
function logError(msg: string, extra?: Record<string, unknown>) {
  Effect.runFork(extra ? Effect.annotateLogs(Effect.logError(msg), extra) : Effect.logError(msg))
}

const AGENT_TAG = "agent";
const BROWSER_TAG = "browser";

type RequestOwner = {
  browser: WebSocket;
  agentId: string;
  action: string;
};

export interface Env extends AuthEnv {
  GIT_GLANCE_DO: DurableObjectNamespace<GitGlanceDO>;
  GLANCE_SECRET?: string;
  ASSETS: Fetcher;
}

export class GitGlanceDO extends DurableObject<Env> {
  private readonly requests = new Map<string, RequestOwner>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private getOnlineAgentIds(): Set<string> {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets(AGENT_TAG)) {
      const att = ws.deserializeAttachment() as { agentId?: string };
      if (att.agentId) ids.add(att.agentId);
    }
    return ids;
  }

  private getFirstOnlineAgentId(): string | null {
    for (const ws of this.ctx.getWebSockets(AGENT_TAG)) {
      const att = ws.deserializeAttachment() as { agentId?: string };
      if (att.agentId) return att.agentId;
    }
    return null;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const isAgent = url.searchParams.has("token");
    logInfo("[do] fetch", { url: request.url, isAgent });

    const [client, server] = Object.values(new WebSocketPair());

    server.serializeAttachment({ isAgent });

    try {
      this.ctx.acceptWebSocket(server, isAgent ? [AGENT_TAG] : [BROWSER_TAG]);
    } catch (e) {
      logError("[do] acceptWebSocket error", { error: String(e) });
      return new Response("Internal error", { status: 500 });
    }

    if (!isAgent) {
      const onlineIds = this.getOnlineAgentIds();
      const machines: MachineInfo[] = [];
      const allRepos: any[] = [];
      const all = new Map(await this.ctx.storage.kv.list<AgentState>({ prefix: "agent:" }));
      for (const [, state] of all) {
        const online = onlineIds.has(state.agentId);
        machines.push({ name: state.agentId, online, lastSeen: state.lastSeen });
        if (online) allRepos.push(...state.repos);
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
    let msg: any;
    try {
      msg = JSON.parse(message as string);
    } catch (e) {
      logError("[do] invalid JSON from WS", { error: String(e) });
      return;
    }
    const { isAgent } = ws.deserializeAttachment() as { isAgent: boolean };

    if (isAgent) {
      await this.handleAgentMessage(ws, msg);
    } else {
      await this.handleBrowserMessage(ws, msg);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as { isAgent: boolean; agentId?: string };
    if (!att.isAgent) {
      for (const [id, owner] of this.requests) {
        if (owner.browser === ws) this.requests.delete(id);
      }
      return;
    }

    if (att.isAgent && att.agentId) {
      const agentId = att.agentId;
      const remaining = this.ctx.getWebSockets(AGENT_TAG).length;
      logWarn("[do] agent disconnected", { agentId, remainingAgents: remaining });
      const state = await this.ctx.storage.kv.get<AgentState>("agent:" + agentId);
      if (state) {
        state.lastSeen = Date.now();
        await this.ctx.storage.kv.put("agent:" + agentId, state);
      }
      for (const [id, owner] of this.requests) {
        if (owner.agentId === agentId) {
          owner.browser.send(JSON.stringify({ id, type: "error", error: `Agent '${agentId}' disconnected during ${owner.action}` }));
          this.requests.delete(id);
        }
      }
      this.broadcastAgentStatus();
    }
  }

  private async handleAgentMessage(ws: WebSocket, msg: any) {
    const att = ws.deserializeAttachment() as { isAgent: boolean; agentId?: string };

    switch (msg.type) {
      case "register": {
        const agentId = att?.agentId || msg.agentId || "default";
        ws.serializeAttachment({ isAgent: true, agentId });
        logInfo("[do] agent registered", { agentId, repoCount: msg.repos?.length });

        const state: AgentState = {
          agentId,
          lastSeen: Date.now(),
          repos: msg.repos || [],
          config: msg.config || { rootDir: null, opencodeModel: "CrofAI/deepseek-v4-flash" },
        };
        await this.ctx.storage.kv.put("agent:" + agentId, state);
        ws.send(JSON.stringify({ type: "registered", agentId }));
        this.broadcastAgentStatus();
        break;
      }
      case "register_repos": {
        const agentId = att?.agentId;
        if (!agentId) break;
        const state = await this.ctx.storage.kv.get<AgentState>("agent:" + agentId);
        if (state) {
          state.repos = msg.repos || state.repos;
          await this.ctx.storage.kv.put("agent:" + agentId, state);
        }
        this.broadcastToBrowsers({ type: "repos_update", agentId, repos: msg.repos || [] });
        break;
      }
      case "result":
      case "progress":
      case "done": {
        const agentId = att?.agentId;
        this.forwardAgentReply({ ...msg, agentId });
        break;
      }
      case "heartbeat": {
        const agentId = att?.agentId;
        if (!agentId) break;
        const state = await this.ctx.storage.kv.get<AgentState>("agent:" + agentId);
        if (state) {
          state.lastSeen = Date.now();
          await this.ctx.storage.kv.put("agent:" + agentId, state);
        }
        this.broadcastAgentStatus();
        break;
      }
      case "error": {
        const agentId = att?.agentId;
        logError("[do] agent error forwarded", { agentId, id: msg.id, error: msg.error, action: msg.action });
        this.forwardAgentReply({ ...msg, agentId });
        break;
      }
    }
  }

  private async handleBrowserMessage(ws: WebSocket, msg: any) {
    if (msg.action === "getRepos") {
      const onlineIds = this.getOnlineAgentIds();
      const allRepos: any[] = [];
      const machines: MachineInfo[] = [];
      const all = new Map(await this.ctx.storage.kv.list<AgentState>({ prefix: "agent:" }));
      for (const [, state] of all) {
        const online = onlineIds.has(state.agentId);
        if (online) allRepos.push(...state.repos);
        machines.push({ name: state.agentId, online, lastSeen: state.lastSeen });
      }
      ws.send(JSON.stringify({
        id: msg.id, type: "result",
        data: { repos: allRepos, machines, scannedAt: 0, scannedDirs: [] },
      }));
      return;
    }

    if (msg.action === "getConfig") {
      const onlineIds = this.getOnlineAgentIds();
      const machines: { name: string; online: boolean }[] = [];
      let rootDir: string | null = null;
      let offlineRoot: string | null = null;
      const all = new Map(await this.ctx.storage.kv.list<AgentState>({ prefix: "agent:" }));
      for (const [, state] of all) {
        const online = onlineIds.has(state.agentId);
        machines.push({ name: state.agentId, online });
        if (online && state.config?.rootDir) {
          if (!rootDir) rootDir = state.config.rootDir;
        } else if (!online && state.config?.rootDir) {
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
      const agents = this.ctx.getWebSockets(AGENT_TAG);
      if (agents.length > 0) {
        const att = agents[0].deserializeAttachment() as { agentId?: string };
        if (att.agentId) {
          this.forwardToAgent(att.agentId, { type: "execute", id: msg.id, action: msg.action, params: msg.params }, ws);
          return;
        }
      }
      ws.send(JSON.stringify({ id: msg.id, type: "error", error: "No online agent to configure" }));
      return;
    }

    if (msg.action === "cancel") {
      const targetRequestId = msg.params?.targetRequestId;
      if (typeof targetRequestId !== "string") {
        ws.send(JSON.stringify({ id: msg.id, type: "error", error: "Missing targetRequestId for cancel" }));
        return;
      }
      const owner = this.requests.get(targetRequestId);
      if (!owner) {
        ws.send(JSON.stringify({ id: msg.id, type: "result", data: { ok: true, alreadyFinished: true } }));
        return;
      }
      if (owner.browser !== ws) {
        ws.send(JSON.stringify({ id: msg.id, type: "error", error: "Cannot cancel a request owned by another browser" }));
        return;
      }
      this.forwardToAgent(owner.agentId, { type: "execute", id: msg.id, action: "cancel", params: { targetRequestId } }, ws);
      this.requests.delete(targetRequestId);
      return;
    }

    const machine = msg.params?.machine || msg.params?.agentId || this.getFirstOnlineAgentId();
    logInfo("[do] route", { action: msg.action, id: msg.id, machine });
    if (machine) {
      this.forwardToAgent(machine, { type: "execute", id: msg.id, action: msg.action, params: msg.params }, ws);
    } else {
      ws.send(JSON.stringify({ id: msg.id, type: "error", error: `No online agent for action: ${msg.action}` }));
    }
  }

  private forwardToAgent(agentId: string, msg: { type: string; id: string; action: string; params?: any }, errorTarget?: WebSocket, trackRequest = true) {
    const agents = this.ctx.getWebSockets(AGENT_TAG);
    logInfo("[do] forwardToAgent", { agentId, action: msg.action, id: msg.id, agentWsCount: agents.length });
    for (const ws of agents) {
      const att = ws.deserializeAttachment() as { isAgent: boolean; agentId?: string };
      if (att.agentId === agentId) {
        if (errorTarget && trackRequest) {
          this.requests.set(msg.id, { browser: errorTarget, agentId, action: msg.action });
          errorTarget.send(JSON.stringify({ id: msg.id, type: "ack", agentId, action: msg.action }));
        }
        ws.send(JSON.stringify(msg));
        return;
      }
    }
    const errMsg = `Agent '${agentId}' is offline (action: ${msg.action}, id: ${msg.id})`;
    logError("[do] agent not connected", { agentId, action: msg.action, id: msg.id, agentWsCount: agents.length });
    if (errorTarget) errorTarget.send(JSON.stringify({ id: msg.id, type: "error", error: errMsg }));
    else this.broadcastToBrowsers({ id: msg.id, type: "error", error: errMsg });
  }

  private forwardAgentReply(msg: any) {
    const owner = typeof msg.id === "string" ? this.requests.get(msg.id) : null;
    if (!owner) {
      logWarn("[do] dropping unowned agent reply", { id: msg.id, type: msg.type, agentId: msg.agentId });
      return;
    }
    owner.browser.send(JSON.stringify(msg));
    if (msg.type === "done" || msg.type === "error" || msg.type === "result") {
      this.requests.delete(msg.id);
    }
  }

  private async broadcastAgentStatus() {
    const onlineIds = this.getOnlineAgentIds();
    const machines: { name: string; online: boolean; lastSeen: number | null }[] = [];
    const all = new Map(await this.ctx.storage.kv.list<AgentState>({ prefix: "agent:" }));
    for (const [, state] of all) {
      machines.push({ name: state.agentId, online: onlineIds.has(state.agentId), lastSeen: state.lastSeen });
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
