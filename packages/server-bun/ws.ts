import { basename, join } from "path";
import { readFileSync } from "fs";
import type {
  CommitProgress,
  FetchProgress,
  GitRepo,
  MachineStatus,
  PullPushResult,
  ReposResponse,
  RescanResult,
  WSRequest,
  WSResponse,
} from "./types";
import type { GitService } from "./git";
import type { CacheService } from "./cache";
import type { PeerManager } from "./peer";
import { generateCommitMessage } from "./opencode";
import { scanAll, scanOnly, cancelScan, resetCancel } from "./scanner";

export interface ServerDeps {
  git: GitService;
  cache: CacheService;
  peers: PeerManager;
  localName: string;
}

export interface WSServer {
  send(id: string, msg: WSResponse): void;
}

export function handleWSOpen(
  id: string,
  ws: { send(data: string): void; close(): void },
  deps: ServerDeps,
): void {
  console.log("WS client connected");
}

export function handleWSMessage(
  id: string,
  data: string,
  ws: { send(data: string): void; close(): void },
  deps: ServerDeps,
): void {
  let req: WSRequest;
  try {
    req = JSON.parse(data);
  } catch {
    return;
  }
  handleAction(ws, req, deps);
}

export function handleWSClose(id: string): void {
  console.log("WS client disconnected");
}

function sendMsg(
  ws: { send(data: string): void },
  msg: WSResponse,
): void {
  ws.send(JSON.stringify(msg));
}

function sendResult(
  ws: { send(data: string): void },
  id: string,
  data: any,
): void {
  sendMsg(ws, { id, type: "result", data });
}

function sendError(
  ws: { send(data: string): void },
  id: string,
  error: string,
): void {
  sendMsg(ws, { id, type: "error", error });
}

function sendProgress(
  ws: { send(data: string): void },
  id: string,
  data: any,
): void {
  sendMsg(ws, { id, type: "progress", data });
}

function sendDone(
  ws: { send(data: string): void },
  id: string,
): void {
  sendMsg(ws, { id, type: "done" });
}

async function handleAction(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  switch (req.action) {
    case "getRepos":
      handleGetRepos(ws, req, deps);
      break;
    case "getConfig":
      handleGetConfig(ws, req, deps);
      break;
    case "setConfig":
      handleSetConfig(ws, req, deps);
      break;
    case "pull":
      await handlePull(ws, req, deps);
      break;
    case "push":
      await handlePush(ws, req, deps);
      break;
    case "rescanRepo":
      await handleRescanRepo(ws, req, deps);
      break;
    case "checkPull":
      await handleCheckPull(ws, req, deps);
      break;
    case "updateRepoSettings":
      handleUpdateRepoSettings(ws, req, deps);
      break;
    case "cancelScan":
      cancelScan();
      sendResult(ws, req.id, { ok: true });
      break;
    case "cancelCommit":
      sendResult(ws, req.id, { ok: true });
      break;
    case "cancelFetch":
      sendResult(ws, req.id, { ok: true });
      break;
    case "cancel":
      sendResult(ws, req.id, { ok: true });
      break;
    case "scan":
      await handleScan(ws, req, deps);
      break;
    case "scanOnly":
      await handleScanOnly(ws, req, deps);
      break;
    case "commitPush":
      await handleCommitPush(ws, req, deps);
      break;
    case "fetchAll":
      await handleFetchAll(ws, req, deps);
      break;
    case "getDiff":
      await handleGetDiff(ws, req, deps);
      break;
    default:
      sendError(ws, req.id, `unknown action: ${req.action}`);
  }
}

function handleGetRepos(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): void {
  const allRepos = deps.cache.getAllRepos();
  for (const r of allRepos) {
    if (!r.machine) r.machine = deps.localName;
  }
  const statuses = deps.peers.getStatuses();
  const scannedDirs = deps.cache.getScannedDirs();

  const now = Date.now();
  const localMachine: MachineStatus = {
    name: deps.localName,
    url: "",
    online: true,
    lastSeen: now,
  };
  const machines = [localMachine, ...statuses];

  sendResult(ws, req.id, {
    repos: allRepos,
    scannedAt: now,
    scannedDirs,
    machines,
  } satisfies ReposResponse);
}

function handleGetConfig(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): void {
  const cfg = deps.cache.loadConfig();
  const statuses = deps.peers.getStatuses();

  const rootDir = cfg.rootDir ?? null;
  const model = cfg.opencodeModel || "deepseek/deepseek-v4-flash";

  const now = Date.now();
  const machinesWithOnline: MachineStatus[] = [
    { name: deps.localName, url: "", online: true, lastSeen: now },
  ];

  for (const m of cfg.machines ?? []) {
    let online = false;
    for (const s of statuses) {
      if (s.name === m.name) {
        online = s.online;
        break;
      }
    }
    if (m.name !== deps.localName) {
      machinesWithOnline.push({
        name: m.name,
        url: m.url,
        online,
        lastSeen: null,
      });
    }
  }

  sendResult(ws, req.id, {
    rootDir,
    opencodeModel: model,
    token: cfg.token,
    machines: machinesWithOnline,
  });
}

function handleSetConfig(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): void {
  const params = req.params ?? {};
  const existing = deps.cache.loadConfig();

  if (typeof params.rootDir === "string") {
    existing.rootDir = params.rootDir;
    deps.cache.addScannedDir(params.rootDir);
  }
  if (typeof params.opencodeModel === "string") {
    existing.opencodeModel = params.opencodeModel;
  }
  if (Array.isArray(params.machines)) {
    const cfgMachines = params.machines
      .filter(
        (m: any) =>
          typeof m === "object" &&
          typeof m.name === "string" &&
          typeof m.url === "string" &&
          m.name &&
          m.url,
      )
      .map((m: any) => ({
        name: m.name as string,
        url: m.url as string,
        token: (m.token as string) ?? "",
      }));
    existing.machines = cfgMachines;
    deps.peers.updateConfig(existing);
  }

  deps.cache.saveConfig(existing);
  sendResult(ws, req.id, { ok: true });
}

async function handlePull(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const params = req.params ?? {};
  const repo = params.repo as string;
  let machine = (params.machine as string) || "";

  if (!repo) {
    sendError(ws, req.id, 'Missing "repo" parameter');
    return;
  }
  if (!machine || machine === deps.localName) {
    machine = deps.localName;
  }

  if (machine !== deps.localName) {
    const result = await deps.peers.proxyPull(machine, repo);
    if (!result.ok) {
      sendError(ws, req.id, result.error ?? "pull failed");
    } else {
      sendResult(ws, req.id, result);
    }
    return;
  }

  try {
    const output = await deps.git.runWithLock(["pull"], repo, 30_000);
    await updateRepoInCache(deps, repo);
    sendResult(ws, req.id, { ok: true, output } satisfies PullPushResult);
  } catch (err: any) {
    sendResult(ws, req.id, { ok: false, output: null, error: err.message } satisfies PullPushResult);
  }
}

async function handlePush(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const params = req.params ?? {};
  const repo = params.repo as string;
  let machine = (params.machine as string) || "";

  if (!repo) {
    sendError(ws, req.id, 'Missing "repo" parameter');
    return;
  }
  if (!machine || machine === deps.localName) {
    machine = deps.localName;
  }

  if (machine !== deps.localName) {
    const result = await deps.peers.proxyPush(machine, repo);
    if (!result.ok) {
      sendError(ws, req.id, result.error ?? "push failed");
    } else {
      sendResult(ws, req.id, result);
    }
    return;
  }

  try {
    const output = await deps.git.runWithLock(["push"], repo, 60_000);
    await updateRepoInCache(deps, repo);
    sendResult(ws, req.id, { ok: true, output } satisfies PullPushResult);
  } catch (err: any) {
    sendResult(ws, req.id, { ok: false, output: null, error: err.message } satisfies PullPushResult);
  }
}

async function handleRescanRepo(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const repo = req.params?.repo as string;
  if (!repo) {
    sendError(ws, req.id, 'Missing "repo" parameter');
    return;
  }

  const updated = await updateRepoInCache(deps, repo);
  if (!updated) {
    sendResult(ws, req.id, { ok: false, repo: null, error: "Failed to rescan repo" } satisfies RescanResult);
    return;
  }
  sendResult(ws, req.id, { ok: true, repo: updated, error: null } satisfies RescanResult);
}

async function handleCheckPull(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const repo = req.params?.repo as string;
  if (!repo) {
    sendError(ws, req.id, 'Missing "repo" parameter');
    return;
  }

  await deps.git.runWithLock(["fetch", "origin"], repo, 30_000).catch(() => {});
  const updated = await updateRepoInCache(deps, repo);
  if (!updated) {
    sendResult(ws, req.id, { ok: false, repo: null, error: "Failed to rescan repo after fetch" } satisfies RescanResult);
    return;
  }
  sendResult(ws, req.id, { ok: true, repo: updated, error: null } satisfies RescanResult);
}

function handleUpdateRepoSettings(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): void {
  const params = req.params ?? {};
  const repo = params.repo as string;
  if (!repo) {
    sendError(ws, req.id, 'Missing "repo" parameter');
    return;
  }

  const repos = deps.cache.load();
  const updated = repos.map((r) => {
    if (r.path !== repo) return r;
    const settings = r.settings ?? { skipUntracked: false, skipPullCheck: false, hidden: false };
    if (typeof params.skipUntracked === "boolean") settings.skipUntracked = params.skipUntracked;
    if (typeof params.skipPullCheck === "boolean") settings.skipPullCheck = params.skipPullCheck;
    if (typeof params.hidden === "boolean") settings.hidden = params.hidden;
    return { ...r, settings };
  });

  deps.cache.save(updated);
  sendResult(ws, req.id, { ok: true });
}

async function handleScan(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const rootDir = req.params?.rootDir as string;
  if (!rootDir) {
    sendError(ws, req.id, 'Missing "rootDir" parameter');
    return;
  }

  resetCancel();
  deps.cache.addScannedDir(rootDir);

  await scanAll(deps.git, deps.cache, rootDir, deps.localName, (p) => {
    sendProgress(ws, req.id, p);
  });

  deps.peers.notifyReposUpdated();
  sendDone(ws, req.id);
}

async function handleScanOnly(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const rootDir = req.params?.rootDir as string;
  if (!rootDir) {
    sendError(ws, req.id, 'Missing "rootDir" parameter');
    return;
  }

  resetCancel();
  deps.cache.addScannedDir(rootDir);

  await scanOnly(deps.git, deps.cache, rootDir, deps.localName, (p) => {
    sendProgress(ws, req.id, p);
  });

  deps.peers.notifyReposUpdated();
  sendDone(ws, req.id);
}

async function handleCommitPush(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const repo = req.params?.repo as string;
  if (!repo) {
    sendError(ws, req.id, 'Missing "repo" parameter');
    return;
  }

  const sendCP = (phase: string, data?: { error?: string; subject?: string; body?: string }) => {
    const cp: CommitProgress = {
      phase,
      repoPath: repo,
      error: data?.error ?? null,
      subject: data?.subject ?? null,
      body: data?.body ?? null,
    };
    sendProgress(ws, req.id, cp);
  };

  sendCP("staging");
  try {
    await deps.git.runWithLock(["add", "."], repo, 15_000);
  } catch (err: any) {
    sendCP("error", { error: err.message });
    sendDone(ws, req.id);
    return;
  }

  let branch: string;
  try {
    branch = await deps.git.runWithLock(["rev-parse", "--abbrev-ref", "HEAD"], repo, 5000);
  } catch (err: any) {
    sendCP("error", { error: err.message });
    sendDone(ws, req.id);
    return;
  }

  const stagedSummary = await deps.git.run(["diff", "--cached", "--stat"], repo, 10_000).catch(() => "");
  const stagedPatch = await deps.git.run(["diff", "--cached"], repo, 10_000).catch(() => "");

  if (!stagedPatch) {
    sendCP("error", { error: "No changes to commit" });
    sendDone(ws, req.id);
    return;
  }

  sendCP("generating");
  const cfg = deps.cache.loadConfig();
  const model = cfg.opencodeModel || "deepseek/deepseek-v4-flash";

  console.log(`[commitPush] repo=${repo} model=${model}`);
  let commitMsg;
  try {
    commitMsg = await generateCommitMessage(repo, branch, stagedSummary, stagedPatch, model);
  } catch (err: any) {
    sendCP("error", { error: err.message });
    sendDone(ws, req.id);
    return;
  }

  sendCP("committing");
  const fullMessage = commitMsg.body
    ? `${commitMsg.subject}\n\n${commitMsg.body}`
    : commitMsg.subject;
  try {
    await deps.git.runWithStdinAndLock(["commit", "-F", "-"], fullMessage, repo, 15_000);
  } catch (err: any) {
    sendCP("error", { error: err.message });
    sendDone(ws, req.id);
    return;
  }

  sendCP("pushing");
  try {
    await deps.git.runWithLock(["push"], repo, 60_000);
  } catch (err: any) {
    sendCP("error", { error: err.message });
    sendDone(ws, req.id);
    return;
  }

  await updateRepoInCache(deps, repo);
  sendCP("done", { subject: commitMsg.subject, body: commitMsg.body });
  sendDone(ws, req.id);
}

async function handleFetchAll(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  resetCancel();

  const sendFP = (
    phase: string,
    current: number,
    total: number,
    opts?: {
      repoPath?: string;
      repoName?: string;
      ahead?: number;
      behind?: number;
      branch?: string;
      error?: string;
    },
  ) => {
    const fp: FetchProgress = {
      phase,
      current,
      total,
      repoPath: opts?.repoPath ?? null,
      repoName: opts?.repoName ?? null,
      ahead: opts?.ahead ?? null,
      behind: opts?.behind ?? null,
      branch: opts?.branch ?? null,
      error: opts?.error ?? null,
    };
    sendProgress(ws, req.id, fp);
  };

  const allRepos = deps.cache.getAllRepos();
  const localRepos = allRepos.filter(
    (r) => !r.settings?.hidden && !r.settings?.skipPullCheck,
  );

  const total = localRepos.length;
  if (total === 0) {
    sendFP("done", 0, 0);
    sendDone(ws, req.id);
    return;
  }

  sendFP("fetching", 0, total);

  for (let i = 0; i < localRepos.length; i++) {
    const repo = localRepos[i];
    sendFP("repo", i, total, { repoPath: repo.path, repoName: repo.name });

    await deps.git.runWithLock(["fetch", "origin"], repo.path, 30_000).catch(() => {});
    const status = await deps.git.getStatusWithLock(repo.path).catch(() => null);

    if (status) {
      await updateRepoInCache(deps, repo.path);
      sendFP("repo", i + 1, total, {
        repoPath: repo.path,
        repoName: repo.name,
        ahead: status.ahead,
        behind: status.behind,
        branch: repo.branch ?? undefined,
      });
    } else {
      sendFP("repo", i + 1, total, {
        repoPath: repo.path,
        repoName: repo.name,
        branch: repo.branch ?? undefined,
      });
    }
  }

  sendFP("done", total, total);
  sendDone(ws, req.id);
}

async function handleGetDiff(
  ws: { send(data: string): void },
  req: WSRequest,
  deps: ServerDeps,
): Promise<void> {
  const repo = req.params?.repo as string;
  const file = req.params?.file as string;
  const statusType = req.params?.status as string;

  if (!repo || !file) {
    sendError(ws, req.id, 'Missing "repo" or "file" parameter');
    return;
  }
  console.log(`[diff] request repo=${repo} file=${file} status=${statusType}`);

  let diff: string;

  switch (statusType) {
    case "staged":
      diff = await deps.git.runArgsWithLock(["diff", "--cached", "--", file], repo, 15_000);
      break;
    case "unstaged":
      diff = await deps.git.runArgsWithLock(["diff", "--", file], repo, 15_000);
      break;
    case "untracked": {
      let content: string;
      try {
        content = readFileSync(join(repo, file), "utf-8");
      } catch (err: any) {
        sendError(ws, req.id, `Cannot read untracked file: ${err.message}`);
        return;
      }
      const lines = content.split("\n");
      const filteredLines = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
      diff = `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${filteredLines.length} @@\n`;
      for (const line of filteredLines) {
        diff += "+" + line + "\n";
      }
      break;
    }
    default:
      sendError(ws, req.id, 'Invalid "status" parameter (must be staged, unstaged, or untracked)');
      return;
  }

  if (!diff && statusType !== "untracked") {
    console.log(`[diff] empty repo=${repo} file=${file} status=${statusType}`);
    sendError(ws, req.id, `No ${statusType} diff for ${file}. The repo status is probably stale.`);
    return;
  }
  console.log(`[diff] response repo=${repo} file=${file} status=${statusType} bytes=${diff.length}`);

  sendResult(ws, req.id, { file, diff });
}

async function updateRepoInCache(
  deps: ServerDeps,
  repoPath: string,
): Promise<GitRepo | null> {
  let status;
  try {
    status = await deps.git.getStatus(repoPath);
  } catch {
    return null;
  }

  const repos = deps.cache.load();
  const name = basename(repoPath);
  const now = Date.now();
  const commitTimeMs = status.lastCommitTime ? status.lastCommitTime * 1000 : 0;

  const updated: GitRepo = {
    name,
    path: repoPath,
    branch: status.branch,
    hasChanges: status.hasChanges,
    staged: status.staged,
    stagedFiles: status.stagedFiles,
    unstaged: status.unstaged,
    unstagedFiles: status.unstagedFiles,
    untracked: status.untracked,
    untrackedFiles: status.untrackedFiles,
    ahead: status.ahead,
    behind: status.behind,
    remote: status.remote,
    lastCommitTime: commitTimeMs,
    weekCommits: status.weekCommits,
    lastScanTime: now,
    machine: deps.localName,
    settings: null,
  };

  let found = false;
  for (let i = 0; i < repos.length; i++) {
    if (repos[i].path === repoPath) {
      updated.settings = repos[i].settings;
      repos[i] = updated;
      found = true;
      break;
    }
  }
  if (!found) {
    repos.push(updated);
  }

  deps.cache.save(repos);
  deps.peers.notifyReposUpdated();
  return updated;
}
