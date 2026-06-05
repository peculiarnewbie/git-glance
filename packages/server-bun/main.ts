import { existsSync, statSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { CacheService } from "./cache";
import { GitService } from "./git";
import { PeerManager } from "./peer";
import {
  handleWSOpen,
  handleWSMessage,
  handleWSClose,
  type ServerDeps,
} from "./ws";
import { handleIncomingPeerWS } from "./peer";

function hostnameOrDefault(): string {
  try {
    const os = require("os");
    return os.hostname() || "local";
  } catch {
    return "local";
  }
}

// Parse CLI args
const args = process.argv.slice(2);
function getArg(name: string, defaultValue: string): string {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const envKey = name.replace(/-/g, "_").toUpperCase();
  if (process.env[envKey]) return process.env[envKey]!;
  return defaultValue;
}

const port = parseInt(getArg("port", "3456"), 10);
const staticDir = getArg("static", "");
const devURL = getArg("dev-url", "");
const machineName = getArg("name", "") || hostnameOrDefault();
const tokenArg = getArg("token", "");

const homeDir = homedir();
const configDir = process.env.CONFIG_DIR || join(homeDir, ".git-glance");
const cachePath = join(configDir, "repo-cache.json");
const configPath = join(configDir, "config.json");

const cache = new CacheService(cachePath, configPath);
const git = new GitService();

// Load or generate auth token
const cfg = cache.loadConfig();
let localToken = tokenArg;
if (!localToken) {
  if (cfg.token) {
    localToken = cfg.token;
  } else {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    localToken = Array.from(buf)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    cfg.token = localToken;
    cache.saveConfig(cfg);
    console.log(`[auth] generated new peer token: ${localToken}`);
  }
}

const peers = new PeerManager(machineName, localToken, cache, git);
peers.updateConfig(cfg);

const deps: ServerDeps = { git, cache, peers, localName: machineName };

// Scan port from env
const envPort = process.env.PORT;
const finalPort = envPort ? parseInt(envPort, 10) : port;

function isLoopback(host: string): boolean {
  const h = host.split(":")[0];
  return h === "127.0.0.1" || h === "::1" || h === "localhost";
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function getStaticDir(): string {
  if (staticDir) return staticDir;

  const candidates = [
    join(process.cwd(), "public"),
    join(process.cwd(), "..", "desktop", "renderer-dist"),
  ];

  for (const c of candidates) {
    const abs = resolve(c);
    if (fileExists(join(abs, "index.html"))) {
      console.log(`Serving static files from ${abs}`);
      return abs;
    }
  }

  console.log("No static directory found, running API-only mode");
  return "";
}

const resolvedStaticDir = getStaticDir();

// Track WS clients for /ws endpoint
let wsClientIdCounter = 0;
const wsClients = new Map<string, { send(data: string): void }>();

const server = Bun.serve({
  port: finalPort,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // WebSocket upgrade for /ws
    if (path === "/ws") {
      const id = String(++wsClientIdCounter);
      const upgraded = server.upgrade(req, {
        data: { id, type: "ws" as const },
      });
      if (upgraded) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // WebSocket upgrade for /peer
    if (path === "/peer") {
      const id = String(++wsClientIdCounter);
      const upgraded = server.upgrade(req, {
        data: { id, type: "peer" as const },
      });
      if (upgraded) return undefined as any;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    // Health endpoint
    if (path === "/health") {
      return new Response('{"status":"ok"}', {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Dev URL redirect
    if (devURL && isLoopback(req.headers.get("host") ?? "")) {
      const redirect = devURL + url.pathname + (url.search || "");
      return Response.redirect(redirect, 302);
    }

    // Static file serving
    if (resolvedStaticDir) {
      let filePath = join(resolvedStaticDir, path);

      if (path === "/" || !fileExists(filePath)) {
        filePath = join(resolvedStaticDir, "index.html");
      }

      const file = Bun.file(filePath);
      if (file.size > 0) {
        return new Response(file);
      }
    }

    // API-only fallback
    return new Response('{"status":"git-glance API server"}', {
      headers: { "Content-Type": "application/json" },
    });
  },
  websocket: {
    open(ws) {
      const data = ws.data as { id: string; type: "ws" | "peer" };
      if (data.type === "ws") {
        wsClients.set(data.id, {
          send: (d: string) => ws.send(d),
        });
        handleWSOpen(data.id, {
          send: (d: string) => ws.send(d),
          close: () => ws.close(),
        }, deps);
      }
    },
    message(ws, message) {
      const data = ws.data as { id: string; type: "ws" | "peer" };
      if (data.type === "ws") {
        const client = wsClients.get(data.id);
        if (client) {
          handleWSMessage(
            data.id,
            typeof message === "string" ? message : message.toString(),
            { send: (d: string) => ws.send(d), close: () => ws.close() },
            deps,
          );
        }
      }
      // peer messages are handled via the PeerConnection client
    },
    close(ws) {
      const data = ws.data as { id: string; type: "ws" | "peer" };
      if (data.type === "ws") {
        wsClients.delete(data.id);
        handleWSClose(data.id);
      }
    },
  },
});

console.log(`Starting server on :${finalPort}`);
