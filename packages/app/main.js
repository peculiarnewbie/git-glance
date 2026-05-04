import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import fs from "fs";
import { execSync, exec } from "child_process";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VITE_DEV_PORT = 5173;
const VITE_DEV_URL = `http://localhost:${VITE_DEV_PORT}`;

let mainWindow = null;
let useDevServer = false;

const cachePath = path.join(app.getPath("userData"), "repo-cache.json");
const dirStorePath = path.join(app.getPath("userData"), "saved-dir.txt");
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

let cancelScan = false;

ipcMain.on("cancel-scan", () => {
  cancelScan = true;
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
      const name = path.basename(repoPath);

      const status = await getGitStatusAsync(repoPath);
      const repoInfo = { path: repoPath, name, status };

      cache.repos[repoPath] = {
        name,
        branch: status.branch || null,
        hasChanges: !!status.hasChanges,
        staged: status.staged ?? 0,
        unstaged: status.unstaged ?? 0,
        untracked: status.untracked ?? 0,
        ahead: status.ahead ?? 0,
        behind: status.behind ?? 0,
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
    if (!scannedPaths.has(p)) delete cache.repos[p];
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
