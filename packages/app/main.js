import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import fs from "fs";
import { exec } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VITE_DEV_PORT = 5173;
const VITE_DEV_URL = `http://localhost:${VITE_DEV_PORT}`;

let mainWindow = null;
let useDevServer = false;

const cachePath = path.join(app.getPath("userData"), "repo-cache.json");
const dirStorePath = path.join(app.getPath("userData"), "saved-dir.txt");
const configPath = path.join(app.getPath("userData"), "config.json");
const isWindows = process.platform === "win32";
const nullRedirect = isWindows ? "2>nul" : "2>/dev/null";

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
  } catch {
    return { repos: {}, version: 1 };
  }
}

function saveCache(cache) {
  const dir = path.dirname(cachePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = JSON.stringify(cache);
  fs.promises.writeFile(cachePath, data).catch(() => {});
}

function loadSavedDir() {
  try {
    return fs.readFileSync(dirStorePath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function saveSavedDir(dir) {
  const dir2 = path.dirname(dirStorePath);
  if (!fs.existsSync(dir2)) fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(dirStorePath, dir, "utf-8");
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return { opencodeModel: "CrofAI/deepseek-v4-flash" };
  }
}

function saveConfig(config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
}

async function isViteDevRunning() {
  for (let i = 0; i < 10; i++) {
    try {
      await fetch(VITE_DEV_URL, { method: "HEAD", signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

function findGitRepos(rootDir) {
  const repos = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.some(e => e.name === ".git" && e.isDirectory())) {
        repos.push(dir);
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
          walk(path.join(dir, entry.name));
        }
      }
    } catch {}
  }
  walk(rootDir);
  return repos;
}

function execGitSafe(cmd, cwd, timeout) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? "" : stdout.toString().trim());
    });
  });
}

function execAsync(cmd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = exec(cmd, options, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: stderr?.toString() }));
      else resolve(stdout?.toString().trim() ?? "");
    });
    if (options.stdin != null) {
      child.stdin.write(options.stdin);
      child.stdin.end();
    }
  });
}

async function getGitStatusAsync(repoPath) {
  try {
    const [rawStatus, branch, remote] = await Promise.all([
      execGitSafe("git status --porcelain", repoPath, 10000),
      execGitSafe("git rev-parse --abbrev-ref HEAD", repoPath, 5000),
      execGitSafe(`git rev-parse --abbrev-ref --symbolic-full-name @{upstream} ${nullRedirect}`, repoPath, 5000),
    ]);

    let ahead = 0, behind = 0;
    if (remote) {
      const revList = await execGitSafe("git rev-list --left-right --count HEAD...@{upstream}", repoPath, 10000);
      if (revList) {
        const parts = revList.split(/\s+/);
        ahead = parseInt(parts[0]) || 0;
        behind = parseInt(parts[1]) || 0;
      }
    }

    const lines = rawStatus ? rawStatus.split("\n") : [];
    const staged = lines.filter(l => l[0] !== " " && l[0] !== "?").length;
    const unstaged = lines.filter(l => l[1] !== " " && l[1] !== "?").length;
    const untracked = lines.filter(l => l.startsWith("??")).length;
    const hasChanges = staged > 0 || unstaged > 0 || untracked > 0;

    let lastCommitTime = null;
    const lastCommitRaw = await execGitSafe("git log -1 --format=%ct", repoPath, 5000);
    if (lastCommitRaw) lastCommitTime = parseInt(lastCommitRaw) * 1000;

    let weekCommits = 0;
    if (lastCommitTime && Date.now() - lastCommitTime < 7 * 24 * 60 * 60 * 1000) {
      const raw = await execGitSafe(`git rev-list --count --since="1 week ago" HEAD`, repoPath, 10000);
      if (raw) weekCommits = parseInt(raw) || 0;
    }

    return {
      branch, remote: remote || null, hasChanges,
      staged, unstaged, untracked, ahead, behind,
      lastCommitTime, weekCommits,
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

ipcMain.handle("select-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

ipcMain.handle("get-cache", () => loadCache());

ipcMain.handle("get-saved-dir", () => loadSavedDir());

ipcMain.handle("save-dir", (_, dir) => {
  saveSavedDir(dir);
});

ipcMain.handle("get-config", () => loadConfig());

ipcMain.handle("set-config", (_, config) => {
  saveConfig(config);
});

let cancelScan = false;
let cancelCommit = false;
let cancelFetch = false;

ipcMain.handle("update-repo-settings", (_, repoPath, settings) => {
  const cache = loadCache();
  if (!cache.repos[repoPath]) return false;
  if (settings.skipUntracked !== undefined) cache.repos[repoPath].skipUntracked = settings.skipUntracked;
  if (settings.skipPullCheck !== undefined) cache.repos[repoPath].skipPullCheck = settings.skipPullCheck;
  if (settings.hidden !== undefined) cache.repos[repoPath].hidden = settings.hidden;
  saveCache(cache);
  return true;
});

// ── Pull / Push ───────────────────────────────────────────────────

ipcMain.handle("pull-repo", async (_, repoPath) => {
  let output;
  try {
    output = await execAsync("git pull", { cwd: repoPath, timeout: 30000 });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  // Rescan repo after successful pull and update cache
  const status = await getGitStatusAsync(repoPath);
  const cache = loadCache();
  const existing = cache.repos[repoPath] || {};
  cache.repos[repoPath] = {
    name: path.basename(repoPath),
    branch: status.branch || null,
    hasChanges: !!status.hasChanges,
    staged: status.staged ?? 0,
    unstaged: status.unstaged ?? 0,
    untracked: status.untracked ?? 0,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    remote: status.remote || null,
    lastCommitTime: status.lastCommitTime,
    weekCommits: status.weekCommits ?? 0,
    lastScanTime: Date.now(),
    error: status.error || null,
    hidden: existing.hidden === true,
  };
  saveCache(cache);

  return { ok: true, output };
});

ipcMain.handle("push-repo", async (_, repoPath) => {
  let output;
  try {
    output = await execAsync("git push", { cwd: repoPath, timeout: 30000 });
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  // Rescan repo after successful push and update cache
  const status = await getGitStatusAsync(repoPath);
  const cache = loadCache();
  const existing = cache.repos[repoPath] || {};
  cache.repos[repoPath] = {
    name: path.basename(repoPath),
    branch: status.branch || null,
    hasChanges: !!status.hasChanges,
    staged: status.staged ?? 0,
    unstaged: status.unstaged ?? 0,
    untracked: status.untracked ?? 0,
    ahead: status.ahead ?? 0,
    behind: status.behind ?? 0,
    remote: status.remote || null,
    lastCommitTime: status.lastCommitTime,
    weekCommits: status.weekCommits ?? 0,
    lastScanTime: Date.now(),
    error: status.error || null,
    hidden: existing.hidden === true,
  };
  saveCache(cache);

  return { ok: true, output };
});

// ── Commit & Push ────────────────────────────────────────────────

function buildCommitMessagePrompt(branch, stagedSummary, stagedPatch) {
  const truncate = (str, max) => str.length > max ? str.slice(0, max) + "\n... [truncated]" : str;
  return [
    "You write concise git commit messages.",
    'Return a JSON object with keys: subject, body.',
    "Rules:",
    "- subject must be imperative, <= 72 chars, and no trailing period",
    "- body can be empty string or short bullet points",
    "- capture the primary user-visible or developer-visible change",
    "",
    `Branch: ${branch ?? "(detached)"}`,
    "",
    "Staged files:",
    truncate(stagedSummary, 6000),
    "",
    "Staged patch:",
    truncate(stagedPatch, 40000),
  ].join("\n");
}

ipcMain.on("commit-and-push", async (event, repoPath) => {
  cancelCommit = false;
  const send = (phase, data = {}) => {
    if (!cancelCommit) event.sender.send("commit-progress", { phase, ...data });
  };

  try {
    send("staging");
    await execAsync("git add .", { cwd: repoPath, timeout: 15000 });
    if (cancelCommit) return;

    const branch = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, timeout: 5000 });

    const stagedSummary = await execAsync("git diff --cached --stat", { cwd: repoPath, timeout: 10000 });
    const stagedPatch = await execAsync("git diff --cached", { cwd: repoPath, timeout: 10000, maxBuffer: 50 * 1024 * 1024 });

    if (!stagedPatch) {
      send("error", { error: "No changes to commit. Stage some changes first." });
      return;
    }

    if (cancelCommit) return;

    send("generating");
    const prompt = buildCommitMessagePrompt(branch, stagedSummary, stagedPatch);
    const config = loadConfig();
    const model = config.opencodeModel || "CrofAI/deepseek-v4-flash";
    const opencodeOutput = await execAsync(
      `opencode run --format json -m "${model}" --dir "${repoPath}"`,
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024, stdin: prompt },
    );

    if (cancelCommit) return;

    let rawText = "";
    for (const line of opencodeOutput.split("\n").filter(l => l.trim())) {
      try {
        const ev = JSON.parse(line);
        if (ev.type === "text" && typeof ev.part?.text === "string") {
          rawText += ev.part.text;
        }
      } catch {}
    }

    if (!rawText) {
      send("error", { error: "Failed to generate commit message from opencode." });
      return;
    }

    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      send("error", { error: "Could not parse commit message JSON from opencode response." });
      return;
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const subject = parsed.subject?.trim();
    const body = parsed.body?.trim() ?? "";

    if (!subject) {
      send("error", { error: "Generated commit message has no subject." });
      return;
    }

    if (cancelCommit) return;

    send("committing");
    const msgFile = path.join(app.getPath("userData"), "commit-msg.txt");
    const fullMessage = body ? `${subject}\n\n${body}` : subject;
    fs.writeFileSync(msgFile, fullMessage, "utf-8");
    await execAsync(`git commit -F "${msgFile}"`, { cwd: repoPath, timeout: 15000 });
    fs.unlinkSync(msgFile);

    if (cancelCommit) return;

    send("pushing");
    await execAsync("git push", { cwd: repoPath, timeout: 60000 });

    if (cancelCommit) return;

    const status = await getGitStatusAsync(repoPath);
    const cache = loadCache();
    const existing = cache.repos[repoPath] || {};
    cache.repos[repoPath] = {
      name: path.basename(repoPath),
      branch: status.branch || null,
      hasChanges: !!status.hasChanges,
      staged: status.staged ?? 0,
      unstaged: status.unstaged ?? 0,
      untracked: status.untracked ?? 0,
      ahead: status.ahead ?? 0,
      behind: status.behind ?? 0,
      remote: status.remote || null,
      lastCommitTime: status.lastCommitTime,
      weekCommits: status.weekCommits ?? 0,
    lastScanTime: Date.now(),
    error: status.error || null,
    hidden: existing.hidden === true,
  };

    saveCache(cache);

    send("done", { subject, body, repoPath });
  } catch (err) {
    send("error", { error: err.stderr?.trim() || err.message || String(err) });
  }
});

ipcMain.on("cancel-commit", () => {
  cancelCommit = true;
});

ipcMain.on("cancel-scan", () => {
  cancelScan = true;
});

ipcMain.on("cancel-background-fetch", () => {
  cancelFetch = true;
});

ipcMain.on("background-fetch", async (event, repoPaths) => {
  cancelFetch = false;
  const cache = loadCache();
  const filtered = repoPaths.filter(p => cache.repos[p] && !cache.repos[p].skipPullCheck && !cache.repos[p].hidden);
  let completed = 0;
  const total = filtered.length;

  for (const repoPath of filtered) {
    if (cancelFetch) return;

    const repoName = path.basename(repoPath);
    event.sender.send("fetch-progress", {
      phase: "fetching", repoPath, repoName,
      current: completed, total,
    });

    try {
      await execAsync("git fetch origin", { cwd: repoPath, timeout: 30000 });
      if (cancelFetch) return;

      const branch = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoPath, timeout: 5000 });
      const remote = await execAsync(
        `git rev-parse --abbrev-ref --symbolic-full-name @{upstream} ${nullRedirect}`,
        { cwd: repoPath, timeout: 5000 },
      );
      let ahead = 0, behind = 0;
      if (remote) {
        const revList = await execAsync("git rev-list --left-right --count HEAD...@{upstream}", { cwd: repoPath, timeout: 10000 });
        if (revList) {
          const parts = revList.split(/\s+/);
          ahead = parseInt(parts[0]) || 0;
          behind = parseInt(parts[1]) || 0;
        }
      }

      if (cache.repos[repoPath]) {
        cache.repos[repoPath].ahead = ahead;
        cache.repos[repoPath].behind = behind;
        cache.repos[repoPath].branch = branch || cache.repos[repoPath].branch;
      }

      completed++;
      event.sender.send("fetch-progress", {
        phase: "repo", repoPath, ahead, behind, branch,
        current: completed, total,
      });
    } catch (err) {
      completed++;
      event.sender.send("fetch-progress", {
        phase: "repo", repoPath,
        error: err.stderr?.trim() || err.message || String(err),
        current: completed, total,
      });
    }
  }

  saveCache(cache);
  event.sender.send("fetch-progress", { phase: "done" });
});

ipcMain.on("start-scan", async (event, dirPath) => {
  cancelScan = false;
  const repos = findGitRepos(dirPath);
  const cache = loadCache();
  const total = repos.length;

  const sorted = repos.sort((a, b) => {
    const aTime = cache.repos[a]?.lastCommitTime ?? 0;
    const bTime = cache.repos[b]?.lastCommitTime ?? 0;
    return bTime - aTime;
  });

  event.sender.send("scan-progress", { phase: "discovering", total });

  const concurrency = Math.min(6, sorted.length || 1);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < sorted.length && !cancelScan) {
      const idx = nextIndex++;
      const repoPath = sorted[idx];
      const existingEntry = cache.repos[repoPath] || {};

      if (existingEntry.hidden) continue;

      const name = path.basename(repoPath);
      const skipUntracked = existingEntry.skipUntracked === true;
      const skipPullCheck = existingEntry.skipPullCheck === true;

      const status = await getGitStatusAsync(repoPath);
      const untracked = skipUntracked ? 0 : (status.untracked ?? 0);
      const repoInfo = { path: repoPath, name, status, skipUntracked, skipPullCheck };
      const hasChanges = (status.staged ?? 0) > 0 || (status.unstaged ?? 0) > 0 || untracked > 0;

      cache.repos[repoPath] = {
        name,
        branch: status.branch || null,
        skipUntracked,
        skipPullCheck,
        hasChanges,
        staged: status.staged ?? 0,
        unstaged: status.unstaged ?? 0,
        untracked,
        ahead: status.ahead ?? 0,
        behind: status.behind ?? 0,
        remote: status.remote || null,
        lastCommitTime: status.lastCommitTime,
        weekCommits: status.weekCommits ?? 0,
        lastScanTime: Date.now(),
        error: status.error || null,
      };

      completed++;
      event.sender.send("scan-progress", {
        phase: "repo", repo: repoInfo, current: completed, total,
      });
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const scannedPaths = new Set(sorted);
  for (const p of Object.keys(cache.repos)) {
    if (!scannedPaths.has(p) && !cache.repos[p]?.hidden) delete cache.repos[p];
  }

  saveCache(cache);
  event.sender.send("scan-progress", { phase: "done" });
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: "Git Explorer",
    width: 1100,
    height: 780,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (useDevServer) {
    mainWindow.loadURL(VITE_DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer-dist", "index.html"));
  }

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  if (await isViteDevRunning()) {
    useDevServer = true;
    console.log(`[electron] Using Vite dev server at ${VITE_DEV_URL}`);
  }
  createMainWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
