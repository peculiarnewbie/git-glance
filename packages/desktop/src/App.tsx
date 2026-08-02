import { createSignal, For, Show, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import { api, repoDataToInfo, runUiEffect, checkSession, login, logout } from "./api";
import type { RepoInfo, AuthState, FileStatus } from "./api";

// Derive types from schema of truth
type RepoNameType = import("./api").RepoName;
type RepoPathType = import("./api").RepoPath;
type RepoBranchType = import("./api").RepoBranch;
type RepoRemoteType = import("./api").RepoRemote;
type RepoErrorType = import("./api").RepoError;
type CommitErrorType = import("./api").CommitEvent['error'];

type SortKey = "last-commit" | "week-activity" | "name" | "pull-count";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  return new Date(ts).toLocaleDateString();
}

function fileStatusColor(fs: FileStatus): string {
  const code = fs.status.replace(/\s/g, "");
  switch (code) {
    case "M": return "bg-blue-500/15";
    case "A": return "bg-emerald-500/15";
    case "D": return "bg-red-500/15";
    case "R": return "bg-purple-500/15";
    case "C": return "bg-cyan-500/15";
    case "?": return "bg-zinc-500/10";
    default:  return "";
  }
}

function PullButton(props: { repoPath: RepoPathType; repoName: RepoNameType; behind: number; machine?: string; onRefresh: (repoPath: string) => Promise<void>; }) {
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  function pull() {
    if (busy()) return;
    setBusy(true);
    setMsg(null);
    runUiEffect(api.pullRepoEffect(props.repoPath, props.machine), {
      onSuccess: async (result) => {
        if (result.ok) await props.onRefresh(props.repoPath);
        setMsg(result.ok ? "Pulled" : `Failed: ${result.error ?? "unknown"}`);
      },
      onFailure: (error) => setMsg(`Failed: ${error.message}`),
      onFinally: () => setBusy(false),
    });
  }
  return (
    <button
      onClick={pull}
      disabled={busy()}
      class="flex items-center gap-1 px-2 py-1 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/20 rounded text-[11px] text-orange-400/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span>{busy() ? "..." : "⇣ Pull"}</span>
      <span class="text-orange-500/50">{props.behind}</span>
      <Show when={msg()}>
        <span class="text-zinc-500">· {msg()}</span>
      </Show>
    </button>
  );
}

function PushButton(props: { repoPath: RepoPathType; repoName: RepoNameType; ahead: number; machine?: string; onRefresh: (repoPath: string) => Promise<void>; }) {
  const [busy, setBusy] = createSignal(false);
  const [msg, setMsg] = createSignal<string | null>(null);
  function push() {
    if (busy()) return;
    setBusy(true);
    setMsg(null);
    runUiEffect(api.pushRepoEffect(props.repoPath, props.machine), {
      onSuccess: async (result) => {
        if (result.ok) await props.onRefresh(props.repoPath);
        setMsg(result.ok ? "Pushed" : `Failed: ${result.error ?? "unknown"}`);
      },
      onFailure: (error) => setMsg(`Failed: ${error.message}`),
      onFinally: () => setBusy(false),
    });
  }
  return (
    <button
      onClick={push}
      disabled={busy()}
      class="flex items-center gap-1 px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/20 rounded text-[11px] text-emerald-400/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <span>{busy() ? "..." : "⇡ Push"}</span>
      <span class="text-emerald-500/50">{props.ahead}</span>
      <Show when={msg()}>
        <span class="text-zinc-500">· {msg()}</span>
      </Show>
    </button>
  );
}

function CommitButton(props: { repoPath: RepoPathType; commitBusy: () => string | null; commitPhase: () => string; commitError: () => { repoPath: string; error: NonNullable<CommitErrorType> } | null; onCommit: () => void; onCancel: () => void; onDismissError: () => void; }) {
  const isBusy = () => props.commitBusy() === props.repoPath;
  const error = () => {
    const err = props.commitError();
    return err?.repoPath === props.repoPath ? err.error : null;
  };
  const phaseLabel = () => {
    const labels: Record<string, string> = { staging: "Staging...", generating: "Generating message...", committing: "Committing...", pushing: "Pushing..." };
    return labels[props.commitPhase()] || "";
  };
  return (
    <div class="flex-1">
      <Show when={!isBusy() && !error()}>
        <button onClick={() => props.onCommit()} class="flex items-center gap-1 px-2 py-1 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 rounded text-[11px] text-sky-400/80 transition-colors">
          ⇡ Commit & Push
        </button>
      </Show>
      <Show when={isBusy()}>
        <div class="flex items-center gap-2">
          <div class="h-1 bg-zinc-800 rounded-full overflow-hidden flex-1 min-w-[60px]">
            <div class="h-full bg-sky-500/60 rounded-full transition-all duration-300 ease-out animate-pulse" style={{ width: "100%" }} />
          </div>
          <span class="text-[10px] text-zinc-500 tabular-nums">{phaseLabel()}</span>
          <button onClick={() => props.onCancel()} class="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors">cancel</button>
        </div>
      </Show>
      <Show when={!isBusy() && !!error()}>
        <div class="rounded border border-red-500/20 bg-red-500/5 p-2 space-y-1">
          <div class="flex items-center gap-2">
            <span class="text-[10px] uppercase tracking-[0.18em] text-red-400/70 shrink-0">commit failed</span>
            <button onClick={() => props.onCommit()} class="text-[10px] text-sky-400/80 hover:text-sky-300 transition-colors shrink-0">retry</button>
            <button onClick={() => props.onDismissError()} class="text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors shrink-0">dismiss</button>
          </div>
          <pre class="text-[10px] leading-relaxed text-red-200/80 whitespace-pre-wrap break-words max-h-28 overflow-auto">{error()}</pre>
        </div>
      </Show>
    </div>
  );
}

export default function App() {
  const [dir, setDir] = createSignal<string | null>(null);
  const [repos, setRepos] = createSignal<RepoInfo[]>([]);
  const [scanning, setScanning] = createSignal(false);
  const [progress, setProgress] = createSignal<{ current: number; total: number }>({ current: 0, total: 0 });
  const [selectedRepo, setSelectedRepo] = createSignal<string | null>(null);
  const [sortKey, setSortKey] = createSignal<SortKey>("last-commit");
  const [grouped, setGrouped] = createSignal(true);
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set(["Hidden"]));

  const [loading, setLoading] = createSignal(true);
  const [config, setConfig] = createSignal<{ opencodeModel: string; token?: string; excludedDirs?: string[]; machines?: { name: string; url: string; token?: string }[] }>({ opencodeModel: "CrofAI/deepseek-v4-flash" });
  const [showSettings, setShowSettings] = createSignal(false);
  const [modelDraft, setModelDraft] = createSignal("");
  const [excludeDraft, setExcludeDraft] = createSignal("");
  const [commitBusy, setCommitBusy] = createSignal<string | null>(null);
  const [commitPhase, setCommitPhase] = createSignal<string>("");
  const [commitError, setCommitError] = createSignal<{ repoPath: string; error: string } | null>(null);
  const [scanError, setScanError] = createSignal<string | null>(null);
  const [fetching, setFetching] = createSignal(false);
  const [fetchProgress, setFetchProgress] = createSignal<{ current: number; total: number }>({ current: 0, total: 0 });
  const [fetchCurrentRepo, setFetchCurrentRepo] = createSignal<string>("");

  // Derive types from schema of truth
  type FetchPhaseType = import("./api").FetchEvent['phase'];
  type FetchErrorType = import("./api").FetchEvent['error'];
  const [machineFilter, setMachineFilter] = createSignal<string | null>(null);
  const [search, setSearch] = createSignal("");
  const [machines, setMachines] = createSignal<{ name: string; url: string; online: boolean }[]>([]);
  const [machineNameDraft, setMachineNameDraft] = createSignal("");
  const [machineUrlDraft, setMachineUrlDraft] = createSignal("");
  const [machineTokenDraft, setMachineTokenDraft] = createSignal("");
  const [showDirModal, setShowDirModal] = createSignal(false);
  const [dirInputValue, setDirInputValue] = createSignal("");
  const [dirInputError, setDirInputError] = createSignal<string | null>(null);
  const [authState, setAuthState] = createSignal<AuthState>("loading");
  const [userEmail, setUserEmail] = createSignal<string | null>(null);

  const [diffFile, setDiffFile] = createSignal<{ repo: string; file: string; status: string } | null>(null);
  const [diffContent, setDiffContent] = createSignal<string | null>(null);

  let workerPoolPromise: Promise<any> | null = null;
  let workerPoolInstance: any = null;

  function getWorkerPool() {
    if (workerPoolInstance) return Promise.resolve(workerPoolInstance);
    if (workerPoolPromise) return workerPoolPromise;
    workerPoolPromise = (async () => {
      const { WorkerPoolManager } = await import("@pierre/diffs/worker");
      const { default: ShikiWorkerUrl } = await import("@pierre/diffs/worker/worker.js?worker&url");
      const pool = new WorkerPoolManager(
        { workerFactory: () => new Worker(ShikiWorkerUrl, { type: "module" }), poolSize: 2 },
        { theme: "pierre-dark", lineDiffType: "none", preferredHighlighter: "shiki-wasm" },
      );
      await pool.initialize();
      workerPoolInstance = pool;
      return pool;
    })();
    return workerPoolPromise;
  }

  let scanController: AbortController | null = null;
  let settingsRef: HTMLDivElement | undefined;
  let searchInput: HTMLInputElement | undefined;

  createEffect(() => {
    if (!showSettings()) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef && !settingsRef.contains(e.target as Node)) setShowSettings(false);
    };
    document.addEventListener("mousedown", handler);
    onCleanup(() => document.removeEventListener("mousedown", handler));
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      searchInput?.focus();
    };
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
  let commitController: AbortController | null = null;
  let fetchController: AbortController | null = null;
  let repoBuffer: RepoInfo[] = [];
  let flushTimer: number | null = null;

  function flushRepoBuffer() {
    if (repoBuffer.length === 0) return;
    const batch = repoBuffer;
    repoBuffer = [];
    setRepos(prev => {
      const next = prev.slice();
      for (const r of batch) {
        const idx = next.findIndex(x => x.path === r.path);
        if (idx >= 0) next[idx] = r;
        else next.push(r);
      }
      return next;
    });
  }

  function toggleCollapsed(section: string) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  onMount(async () => {
    getWorkerPool();
    const session = await checkSession();
    if (session.state === "unauthenticated") {
      setAuthState("unauthenticated");
      return;
    }
    if (session.state === "authenticated") {
      setAuthState("authenticated");
      setUserEmail(session.email);
    } else {
      setAuthState("authenticated");
    }

    const cfg = await api.getConfig();
    if (cfg) {
      setConfig({ opencodeModel: cfg.opencodeModel, token: (cfg as any).token, excludedDirs: cfg.excludedDirs ?? [], machines: cfg.machines?.map(m => ({ name: m.name, url: m.url, token: m.token })) });
      setMachines((cfg.machines || []).map(m => ({ name: m.name, url: m.url, online: m.online })));
      if (cfg.rootDir) setDir(cfg.rootDir);
    }

    const data = await api.getRepos();
    setRepos(data.repos.map(repoDataToInfo));
    if (data.machines.length > 0) setMachines(data.machines.map(m => ({ name: m.name, url: m.url, online: m.online })));
    setLoading(false);
  });

  onCleanup(() => {
    scanController?.abort();
    commitController?.abort();
    fetchController?.abort();
    if (flushTimer !== null) clearTimeout(flushTimer);
  });

  async function pickDirectory(): Promise<string | null> {
    try {
      const { Electroview } = await import("electrobun/view");
      const ev = new Electroview({});
      return (await ev.rpc.request.selectDirectory()) as string | null;
    } catch {
      // Running in browser (Vite dev) — no native picker available
      return null;
    }
  }

  async function handleSelect() {
    const result = await pickDirectory();
    if (!result) {
      setDirInputValue(dir() || "");
      setDirInputError(null);
      setShowDirModal(true);
      return;
    }
    setDir(result);
    setRepos([]);
    setCommitError(null);
    await api.setConfig({ rootDir: result });
  }

  async function submitDirInput() {
    const path = dirInputValue().trim();
    if (!path) {
      setDirInputError("Directory path cannot be empty.");
      return;
    }
    setShowDirModal(false);
    setDir(path);
    setRepos([]);
    setCommitError(null);
    await api.setConfig({ rootDir: path });
  }

  function startScanOnly() {
    scanController?.abort();
    repoBuffer = [];
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    const d = dir();
    if (!d) {
      setScanError("Select a directory before scanning.");
      return;
    }

    setScanError(null);
    setScanning(true);
    setProgress({ current: 0, total: 0 });

    scanController = api.subscribeScanOnly(d, (data) => {
      if (data.phase === "discovering") {
        setProgress({ current: 0, total: data.total });
      } else if (data.phase === "scanning") {
        setProgress({ current: data.current, total: data.total });
        if (data.repo) {
          repoBuffer.push({ ...repoDataToInfo(data.repo), cached: false });
          if (flushTimer === null) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              flushRepoBuffer();
            }, 80);
          }
        }
      } else if (data.phase === "done") {
        if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
        flushRepoBuffer();
        // Progress events are incremental and are merged into the current list.
        // Reconcile with the server's complete snapshot so repos removed from
        // disk during the scan are removed from the UI as well.
        void api.getRepos()
          .then((latest) => setRepos(latest.repos.map(repoDataToInfo)))
          .catch((error: unknown) => {
            setScanError(error instanceof Error ? error.message : "Failed to refresh repositories after scan.");
          })
          .finally(() => setScanning(false));
      }
    }, (error) => {
      setScanError(error?.message || "Scan failed before reaching the agent.");
      setScanning(false);
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      flushRepoBuffer();
    });
  }

  function startFetchAll() {
    fetchController?.abort();
    setFetching(true);
    setFetchProgress({ current: 0, total: 0 });
    setFetchCurrentRepo("");

    fetchController = api.subscribeFetch((data) => {
      if (data.phase === "fetching") {
        setFetchProgress({ current: data.current, total: data.total });
      } else if (data.phase === "repo") {
        setFetchProgress({ current: data.current, total: data.total });
        if (data.repoName) {
          setFetchCurrentRepo(data.repoName);
        }
        if (data.repoPath) {
          api.getRepos().then(d => {
            const updated = d.repos.map(repoDataToInfo).find(r => r.path === data.repoPath);
            if (updated) {
              setRepos(prev => {
                const next = prev.slice();
                const idx = next.findIndex(r => r.path === data.repoPath);
                if (idx >= 0) next[idx] = updated;
                return next;
              });
            }
          });
        }
      } else if (data.phase === "done") {
        setFetching(false);
        setFetchProgress({ current: 0, total: 0 });
        setFetchCurrentRepo("");
      }
    });
  }

  function cancelScan() {
    scanController?.abort();
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    flushRepoBuffer();
    setScanning(false);
  }

  function cancelFetchAll() {
    fetchController?.abort();
    setFetching(false);
    setFetchProgress({ current: 0, total: 0 });
    setFetchCurrentRepo("");
  }

  async function updateRepoSettings(repoPath: string, settings: { skipUntracked?: boolean; skipPullCheck?: boolean; autoPullIfClean?: boolean; hidden?: boolean; pinned?: boolean }) {
    await api.updateRepoSettings(repoPath, settings);
    setRepos(prev => {
      const next = prev.slice();
      const idx = next.findIndex(r => r.path === repoPath);
      if (idx >= 0) {
        next[idx] = { ...next[idx], ...settings };
      }
      return next;
    });
  }

  function closeSidebar() {
    setSelectedRepo(null);
    closeDiff();
  }

  async function handleFileClick(repoPath: string, file: string, status: string) {
    setDiffFile({ repo: repoPath, file, status });
    setDiffContent(null);
    try {
      const result = await api.getDiff(repoPath, file, status as "staged" | "unstaged" | "untracked");
      setDiffContent(result.diff);
    } catch (e) {
      void refreshRepoStatus(repoPath);
      setDiffContent(`Error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function closeDiff() {
    setDiffFile(null);
    setDiffContent(null);
  }

  async function handleRefreshRepo(repoPath: string) {
    const data = await api.getRepos();
    const updated = data.repos.map(repoDataToInfo).find(r => r.path === repoPath);
    if (updated) {
      setRepos(prev => {
        const next = prev.slice();
        const idx = next.findIndex(r => r.path === repoPath);
        if (idx >= 0) next[idx] = updated;
        return next;
      });
    }
  }

  async function refreshRepoStatus(repoPath: string) {
    const result = await api.rescanRepo(repoPath);
    if (result.ok && result.repo) {
      const info = repoDataToInfo(result.repo);
      setRepos(prev => {
        const next = prev.slice();
        const idx = next.findIndex(r => r.path === repoPath);
        if (idx >= 0) next[idx] = info;
        return next;
      });
    }
  }

  function handleStartCommit(repoPath: string) {
    if (commitBusy()) return;
    setCommitBusy(repoPath);
    setCommitPhase("staging");
    setCommitError(null);
    commitController?.abort();
    commitController = api.subscribeCommitPush(repoPath, (data) => {
      if (data.phase === "error") {
        setCommitError({ repoPath, error: data.error || "Unknown error" });
        setCommitBusy(null);
        setCommitPhase("");
      } else if (data.phase === "done") {
        api.getRepos().then(d => {
          const updated = d.repos.map(repoDataToInfo).find(r => r.path === repoPath);
          if (updated) {
            setRepos(prev => {
              const next = prev.slice();
              const idx = next.findIndex(r => r.path === repoPath);
              if (idx >= 0) next[idx] = updated;
              return next;
            });
          }
        });
        setCommitBusy(null);
        setCommitPhase("");
        setCommitError(null);
      } else {
        setCommitPhase(data.phase);
        setCommitError(null);
      }
    });
  }

  function handleCancelCommit() {
    commitController?.abort();
    setCommitBusy(null);
    setCommitPhase("");
  }

  function handleDismissCommitError(repoPath: string) {
    setCommitError(prev => prev?.repoPath === repoPath ? null : prev);
  }

  const [repoActionBusy, setRepoActionBusy] = createSignal<Set<string>>(new Set());
  const [repoActionMsg, setRepoActionMsg] = createSignal<Map<string, string>>(new Map());
  const [bulkPullBusy, setBulkPullBusy] = createSignal(false);
  const [bulkPullMsg, setBulkPullMsg] = createSignal<string | null>(null);

  function setRepoBusy(repoPath: string, busy: boolean) {
    setRepoActionBusy(prev => {
      const next = new Set(prev);
      if (busy) next.add(repoPath);
      else next.delete(repoPath);
      return next;
    });
  }

  function setRepoMsg(repoPath: string, msg: string | null) {
    setRepoActionMsg(prev => {
      const next = new Map(prev);
      if (msg) next.set(repoPath, msg);
      else next.delete(repoPath);
      return next;
    });
  }

  async function handleRescanRepo(repoPath: string) {
    if (repoActionBusy().has(repoPath)) return;
    setRepoBusy(repoPath, true);
    setRepoMsg(repoPath, "Scanning...");
    const result = await api.rescanRepo(repoPath);
    if (result.ok && result.repo) {
      const info = repoDataToInfo(result.repo);
      setRepos(prev => {
        const next = prev.slice();
        const idx = next.findIndex(r => r.path === repoPath);
        if (idx >= 0) next[idx] = info;
        return next;
      });
      setRepoMsg(repoPath, "Scanned");
    } else {
      setRepoMsg(repoPath, result.error || "Failed");
    }
    setRepoBusy(repoPath, false);
    setTimeout(() => setRepoMsg(repoPath, null), 2000);
  }

  async function handleCheckPull(repoPath: string) {
    if (repoActionBusy().has(repoPath)) return;
    setRepoBusy(repoPath, true);
    setRepoMsg(repoPath, "Checking...");
    const result = await api.checkPull(repoPath);
    if (result.ok && result.repo) {
      const info = repoDataToInfo(result.repo);
      setRepos(prev => {
        const next = prev.slice();
        const idx = next.findIndex(r => r.path === repoPath);
        if (idx >= 0) next[idx] = info;
        return next;
      });
      if (result.repo.behind > 0) {
        setRepoMsg(repoPath, `⇣${result.repo.behind} behind`);
      } else {
        setRepoMsg(repoPath, "Up to date");
      }
    } else {
      setRepoMsg(repoPath, result.error || "Failed");
    }
    setRepoBusy(repoPath, false);
    setTimeout(() => setRepoMsg(repoPath, null), 2000);
  }

  function canSafePull(repo: RepoInfo) {
    return repo.status.behind > 0
      && repo.status.ahead === 0
      && !repo.status.hasChanges
      && repo.status.staged === 0
      && repo.status.unstaged === 0
      && repo.status.untracked === 0;
  }

  async function handlePullCleanBehind(reposToPull: RepoInfo[]) {
    if (bulkPullBusy()) return;
    const safeRepos = reposToPull.filter(canSafePull);
    if (safeRepos.length === 0) {
      setBulkPullMsg("No clean repos");
      setTimeout(() => setBulkPullMsg(null), 2000);
      return;
    }

    setBulkPullBusy(true);
    setBulkPullMsg(`0/${safeRepos.length}`);
    let pulled = 0;
    let failed = 0;

    for (const repo of safeRepos) {
      setRepoBusy(repo.path, true);
      setRepoMsg(repo.path, "Pulling...");
      const result = await api.pullRepo(repo.path, repo.machine !== "local" ? repo.machine : undefined);
      if (result.ok) {
        pulled += 1;
        setRepoMsg(repo.path, "Pulled");
        await handleRefreshRepo(repo.path);
      } else {
        failed += 1;
        setRepoMsg(repo.path, result.error || "Failed");
      }
      setRepoBusy(repo.path, false);
      setBulkPullMsg(`${pulled + failed}/${safeRepos.length}`);
      setTimeout(() => setRepoMsg(repo.path, null), 2000);
    }

    setBulkPullBusy(false);
    setBulkPullMsg(failed > 0 ? `${pulled} pulled, ${failed} failed` : `${pulled} pulled`);
    setTimeout(() => setBulkPullMsg(null), 2500);
  }

  const selectedRepoData = createMemo(() => {
    const sel = selectedRepo();
    return sel ? repos().find(r => r.path === sel) : undefined;
  });
  const hasCached = () => repos().some(r => r.cached);

  const listData = createMemo(() => {
    let all = machineFilter() ? repos().filter(r => r.machine === machineFilter()) : repos();
    const q = search().trim().toLowerCase();
    if (q) {
      all = all.filter(r =>
        r.name.toLowerCase().includes(q) ||
        r.path.toLowerCase().includes(q) ||
        (r.status.branch ?? "").toLowerCase().includes(q)
      );
    }
    const key = sortKey();
    const isGrouped = grouped();

    const baseCmp = key === "last-commit"
      ? (a: RepoInfo, b: RepoInfo) => (b.status.lastCommitTime ?? 0) - (a.status.lastCommitTime ?? 0)
      : key === "week-activity"
        ? (a: RepoInfo, b: RepoInfo) => b.status.weekCommits - a.status.weekCommits
        : key === "pull-count"
          ? (a: RepoInfo, b: RepoInfo) => (b.status.behind ?? 0) - (a.status.behind ?? 0)
          : (a: RepoInfo, b: RepoInfo) => a.name.localeCompare(b.name);
    const cmp = (a: RepoInfo, b: RepoInfo) => Number(!!b.pinned) - Number(!!a.pinned) || baseCmp(a, b);

    const hidden: RepoInfo[] = [];
    const errored: RepoInfo[] = [];
    const stale: RepoInfo[] = [];
    const dirty: RepoInfo[] = [];
    const clean: RepoInfo[] = [];

    for (const r of all) {
      if (r.hidden) hidden.push(r);
      else if (r.status.error) errored.push(r);
      else if (r.status.behind > 0) stale.push(r);
      else if (r.status.hasChanges) dirty.push(r);
      else clean.push(r);
    }

    hidden.sort(cmp);
    errored.sort(cmp);
    stale.sort(cmp);
    dirty.sort(cmp);
    clean.sort(cmp);

    return {
      groups: isGrouped
        ? { hidden, errored, stale, dirty, clean }
        : { hidden, errored: [], stale: [], dirty: [], clean: [...all.filter(r => !r.hidden)].sort(cmp) },
      counts: {
        total: all.length,
        hidden: hidden.length,
        stale: stale.length,
        dirty: dirty.length,
        clean: clean.length,
        errored: errored.length,
      },
    };
  });

  function RepoCard(props: { repo: RepoInfo }) {
    const repo = () => props.repo;
    const isSelected = () => selectedRepo() === repo().path;
    const isRemote = () => repo().machine !== "local";
    function selectRepo() {
      if (isSelected()) {
        setSelectedRepo(null);
        return;
      }
      setSelectedRepo(repo().path);
      void refreshRepoStatus(repo().path);
    }
    return (
      <div
        class="border rounded-lg overflow-hidden transition-all duration-150 cursor-pointer"
        classList={{
          "bg-zinc-900/60 border-zinc-800/60 hover:border-zinc-700/60": !isSelected(),
          "bg-zinc-900 border-red-500/30 ring-1 ring-red-500/10": isSelected() && !!repo().status.error,
          "bg-zinc-900 border-orange-500/30 ring-1 ring-orange-500/10": isSelected() && !repo().status.error && repo().status.behind > 0,
          "bg-zinc-900 border-amber-500/30 ring-1 ring-amber-500/10": isSelected() && !repo().status.error && repo().status.behind === 0 && repo().status.hasChanges,
          "bg-zinc-900 border-emerald-500/30 ring-1 ring-emerald-500/10": isSelected() && !repo().status.error && repo().status.behind === 0 && !repo().status.hasChanges,
          "opacity-60": repo().cached && !isSelected(),
        }}
        onMouseDown={selectRepo}
      >
        <div class="flex items-center justify-between px-3 py-2">
          <div class="flex items-center gap-2.5 min-w-0">
            <div
              class="w-2 h-2 rounded-full shrink-0 shadow-sm"
              classList={{
                "bg-emerald-400 shadow-emerald-400/20": !repo().status.error && !repo().status.hasChanges && repo().status.behind === 0,
                "bg-amber-400 shadow-amber-400/20": !repo().status.error && repo().status.hasChanges && repo().status.behind === 0,
                "bg-orange-400 shadow-orange-400/20": !repo().status.error && repo().status.behind > 0,
                "bg-red-400 shadow-red-400/20": !!repo().status.error,
              }}
            />
            <div class="min-w-0">
              <div class="flex items-center gap-1.5">
                <div class="text-[13px] font-medium truncate leading-tight"
                  classList={{ "text-zinc-200": !repo().cached, "text-zinc-400": repo().cached }}
                >{repo().name}</div>
                <Show when={repo().pinned}>
                  <span class="text-[10px] text-sky-400/80" title="Pinned">◆</span>
                </Show>
                <Show when={isRemote()}>
                  <span class="text-[10px] px-1 py-0.5 rounded bg-indigo-500/10 text-indigo-400/70 border border-indigo-500/20 leading-none">{repo().machine}</span>
                </Show>
              </div>
              <div class="text-[11px] text-zinc-600 truncate leading-tight mt-px">{repo().path}</div>
            </div>
          </div>
          <div class="flex items-center gap-2.5 shrink-0 ml-4">
            <Show when={!repo().status.error}>
              <Show when={repo().status.lastCommitTime}>
                <span class="text-[11px] text-zinc-600">{timeAgo(repo().status.lastCommitTime!)}</span>
              </Show>
              <Show when={repo().status.weekCommits > 0}>
                <span class="text-[11px] text-blue-400/70">{repo().status.weekCommits}wk</span>
              </Show>
              <span class="text-[11px] text-zinc-500">{repo().status.branch}</span>
              <Show when={repo().status.ahead > 0 || repo().status.behind > 0}>
                <span class="text-[11px] tabular-nums">
                  <Show when={repo().status.ahead > 0}>
                    <span class="text-emerald-400/80">⇡{repo().status.ahead}</span>
                  </Show>
                  <Show when={repo().status.ahead > 0 && repo().status.behind > 0}>
                    <span class="text-zinc-700"> </span>
                  </Show>
                  <Show when={repo().status.behind > 0}>
                    <span class="text-orange-400/80">⇣{repo().status.behind}</span>
                  </Show>
                </span>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    );
  }

  function DiffPanel() {
    const info = diffFile();
    if (!info) return null;

    let panelRef: HTMLDivElement | undefined;
    let containerRef: HTMLDivElement | undefined;
    let fileDiffInstance: any = null;

    function onDocMouseDown(e: MouseEvent) {
      if (!(e.target instanceof Element)) return;
      const target = e.target;
      if (target.closest("[data-sidebar-panel]")) return;
      if (panelRef && !panelRef.contains(target)) closeDiff();
    }
    onMount(() => document.addEventListener("mousedown", onDocMouseDown));
    onCleanup(() => document.removeEventListener("mousedown", onDocMouseDown));

    function waitForHighlight(container: HTMLDivElement): Promise<void> {
      return new Promise((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };

        const tryCheck = () => {
          if (resolved) return;
          const host = container.querySelector("diffs-container");
          const root = host?.shadowRoot;
          if (!root) { requestAnimationFrame(tryCheck); return; }
          if (root.querySelector("span[style*='--diffs-token-dark']")) {
            requestAnimationFrame(done);
            return;
          }
          requestAnimationFrame(tryCheck);
        };
        tryCheck();
        setTimeout(done, 100);
      });
    }

    async function renderDiffs(container: HTMLDivElement, raw: string) {
      if (!raw) return;

      const { processPatch, FileDiff } = await import("@pierre/diffs");
      const pool = await getWorkerPool();

      const parsed = processPatch(raw);
      const file = parsed.files[0];
      if (!file) return;

      const staging = document.createElement("div");

      const newInstance = new FileDiff({
        theme: "pierre-dark",
        themeType: "dark",
        diffStyle: "unified",
        diffIndicators: "bars",
        overflow: "scroll",
        hunkSeparators: "line-info",
        disableBackground: false,
        disableFileHeader: false,
        lineDiffType: "none",
      }, pool);

      newInstance.render({
        fileDiff: file,
        containerWrapper: staging,
        forceRender: true,
      });

      await waitForHighlight(staging);

      if (fileDiffInstance) fileDiffInstance.cleanUp();
      fileDiffInstance = newInstance;
      container.innerHTML = "";
      container.appendChild(staging);
    }

    createEffect(() => {
      const content = diffContent();
      const el = containerRef;
      if (el && content !== undefined) {
        if (content === null) return;
        renderDiffs(el, content);
      }
    });

    onCleanup(() => {
      if (fileDiffInstance) {
        fileDiffInstance.cleanUp();
        fileDiffInstance = null;
      }
    });

    return (
      <>
        <div ref={panelRef} data-diff-panel class="fixed top-0 right-80 z-40 h-full w-[60vw] max-w-[900px] bg-[#0a0a0c] border-l border-zinc-800/50 shadow-2xl flex flex-col pointer-events-auto">
          <div class="flex items-center justify-between px-4 py-3 border-b border-zinc-800/50 shrink-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-[11px] px-1.5 py-0.5 rounded font-mono"
                classList={{
                  "bg-amber-500/10 text-amber-400/80 border border-amber-500/20": info.status === "staged",
                  "bg-orange-500/10 text-orange-400/80 border border-orange-500/20": info.status === "unstaged",
                  "bg-zinc-700/30 text-zinc-400 border border-zinc-600/30": info.status === "untracked",
                }}
              >{info.status}</span>
              <span class="text-[12px] text-zinc-300 font-mono truncate">{info.file}</span>
            </div>
            <button
              onMouseDown={closeDiff}
              class="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0 p-1.5"
            >
              <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="flex-1 overflow-auto bg-[#0a0a0c]">
            <div ref={containerRef} class="min-h-full" />
          </div>
        </div>
      </>
    );
  }

  function Sidebar(props: { repo: RepoInfo }) {
    const repo = () => props.repo;
    let panelRef: HTMLDivElement | undefined;

    function onDocMouseDown(e: MouseEvent) {
      if (!(e.target instanceof Element)) return;
      const target = e.target;
      if (target.closest("[data-diff-panel]")) return;
      if (panelRef && !panelRef.contains(target)) closeSidebar();
    }
    onMount(() => document.addEventListener("mousedown", onDocMouseDown));
    onCleanup(() => document.removeEventListener("mousedown", onDocMouseDown));

    return (
      <>
        <div ref={panelRef} data-sidebar-panel class="fixed top-0 right-0 z-40 h-full w-80 bg-[#09090b] border-l border-zinc-800/50 shadow-2xl p-5 overflow-y-auto pointer-events-auto">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold text-zinc-100 truncate">{repo().name}</h2>
          <button
            onMouseDown={closeSidebar}
            class="text-zinc-600 hover:text-zinc-400 transition-colors shrink-0 ml-2 p-1.5"
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div class="text-[11px] text-zinc-600 truncate mb-4">{repo().path}</div>

        <Show when={repo().status.error}>
          <div class="text-red-400/80 text-[11px] mb-3 p-2 bg-red-500/5 rounded border border-red-500/10">{repo().status.error}</div>
        </Show>

        <Show when={!repo().status.error}>
          <div class="space-y-2.5 mb-4">
            <div class="flex items-center justify-between text-[11px]">
              <span class="text-zinc-600">Branch</span>
              <span class="text-zinc-300 font-medium">{repo().status.branch}</span>
            </div>
            <Show when={repo().status.remote}>
              <div class="flex items-center justify-between text-[11px]">
                <span class="text-zinc-600">Remote</span>
                <span class="text-zinc-400 truncate ml-4 text-right">{repo().status.remote}</span>
              </div>
            </Show>
            <Show when={repo().status.lastCommitTime}>
              <div class="flex items-center justify-between text-[11px]">
                <span class="text-zinc-600">Last commit</span>
                <span class="text-zinc-400">{timeAgo(repo().status.lastCommitTime!)}</span>
              </div>
            </Show>
            <Show when={repo().status.weekCommits > 0}>
              <div class="flex items-center justify-between text-[11px]">
                <span class="text-zinc-600">This week</span>
                <span class="text-blue-400/70">{repo().status.weekCommits} commits</span>
              </div>
            </Show>
          </div>

          <div class="border-t border-zinc-800/40 pt-3 mb-4">
            <div class="grid grid-cols-3 gap-3 text-center">
              <div class="bg-zinc-900/60 rounded-lg p-2.5">
                <div class="text-[13px] tabular-nums font-medium" classList={{
                  "text-amber-400/80": repo().status.staged > 0,
                  "text-zinc-500": repo().status.staged === 0,
                }}>{repo().status.staged}</div>
                <div class="text-[10px] text-zinc-600 mt-0.5">staged</div>
              </div>
              <div class="bg-zinc-900/60 rounded-lg p-2.5">
                <div class="text-[13px] tabular-nums font-medium" classList={{
                  "text-amber-400/80": repo().status.unstaged > 0,
                  "text-zinc-500": repo().status.unstaged === 0,
                }}>{repo().status.unstaged}</div>
                <div class="text-[10px] text-zinc-600 mt-0.5">unstaged</div>
              </div>
              <div class="bg-zinc-900/60 rounded-lg p-2.5">
                <div class="text-[13px] tabular-nums font-medium" classList={{
                  "text-amber-400/80": repo().status.untracked > 0,
                  "text-zinc-500": repo().status.untracked === 0,
                }}>{repo().status.untracked}</div>
                <div class="text-[10px] text-zinc-600 mt-0.5">untracked</div>
              </div>
            </div>
            <div class="flex items-center justify-center gap-3 mt-2 text-[11px]">
              <span classList={{
                "text-emerald-400/80": repo().status.ahead > 0,
                "text-zinc-600": repo().status.ahead === 0,
              }}>⇡{repo().status.ahead} ahead</span>
              <span classList={{
                "text-orange-400/80": repo().status.behind > 0,
                "text-zinc-600": repo().status.behind === 0,
              }}>⇣{repo().status.behind} behind</span>
            </div>
          </div>

          <Show when={repo().status.stagedFiles?.length > 0 || repo().status.unstagedFiles?.length > 0 || repo().status.untrackedFiles?.length > 0}>
            <div class="border-t border-zinc-800/40 pt-3 mb-4">
              <div class="text-[11px] font-medium text-zinc-500 uppercase tracking-[0.1em] mb-2">Changed Files</div>
              <div class="max-h-48 overflow-y-auto text-[11px] font-mono space-y-px">
                <Show when={repo().status.stagedFiles?.length > 0}>
                  <div class="mb-1.5">
                    <div class="text-amber-400/70 mb-0.5">Staged:</div>
                    <For each={repo().status.stagedFiles}>{(f) =>
                      <button
                        onMouseDown={(e) => { e.stopPropagation(); handleFileClick(repo().path, f.path, "staged"); }}
                        class={`w-full text-left text-zinc-400 pl-2 truncate hover:bg-zinc-800/60 hover:text-zinc-200 rounded px-1 py-0.5 transition-colors ${fileStatusColor(f)}`}
                        title={f.path}
                      >{f.path}</button>
                    }</For>
                  </div>
                </Show>
                <Show when={repo().status.unstagedFiles?.length > 0}>
                  <div class="mb-1.5">
                    <div class="text-orange-400/70 mb-0.5">Unstaged:</div>
                    <For each={repo().status.unstagedFiles}>{(f) =>
                      <button
                        onMouseDown={(e) => { e.stopPropagation(); handleFileClick(repo().path, f.path, "unstaged"); }}
                        class={`w-full text-left text-zinc-400 pl-2 truncate hover:bg-zinc-800/60 hover:text-zinc-200 rounded px-1 py-0.5 transition-colors ${fileStatusColor(f)}`}
                        title={f.path}
                      >{f.path}</button>
                    }</For>
                  </div>
                </Show>
                <Show when={repo().status.untrackedFiles?.length > 0}>
                  <div class="mb-1.5">
                    <div class="text-zinc-500 mb-0.5">Untracked:</div>
                    <For each={repo().status.untrackedFiles}>{(f) =>
                      <button
                        onMouseDown={(e) => { e.stopPropagation(); handleFileClick(repo().path, f.path, "untracked"); }}
                        class={`w-full text-left text-zinc-500 pl-2 truncate hover:bg-zinc-800/60 hover:text-zinc-300 rounded px-1 py-0.5 transition-colors ${fileStatusColor(f)}`}
                        title={f.path}
                      >{f.path}</button>
                    }</For>
                  </div>
                </Show>
              </div>
            </div>
          </Show>

          <Show when={repo().machine !== "local"}>
            <div class="mb-3 px-2 py-1 rounded text-[11px] bg-indigo-500/10 text-indigo-400/70 border border-indigo-500/20">
              Machine: {repo().machine}
            </div>
          </Show>

          <div class="flex flex-wrap items-center gap-2 mb-4">
            <Show when={repo().status.behind > 0}>
              <PullButton repoPath={repo().path} repoName={repo().name} behind={repo().status.behind} machine={repo().machine !== "local" ? repo().machine : undefined} onRefresh={handleRefreshRepo} />
            </Show>
            <Show when={repo().status.ahead > 0}>
              <PushButton repoPath={repo().path} repoName={repo().name} ahead={repo().status.ahead} machine={repo().machine !== "local" ? repo().machine : undefined} onRefresh={handleRefreshRepo} />
            </Show>
            <Show when={repo().status.staged > 0 || repo().status.unstaged > 0 || repo().status.untracked > 0}>
              <CommitButton repoPath={repo().path} commitBusy={commitBusy} commitPhase={commitPhase} commitError={commitError} onCommit={() => handleStartCommit(repo().path)} onCancel={handleCancelCommit} onDismissError={() => handleDismissCommitError(repo().path)} />
            </Show>
          </div>

          <div class="border-t border-zinc-800/40 pt-3 mb-4">
            <div class="text-[11px] font-medium text-zinc-500 uppercase tracking-[0.1em] mb-2">Repo Actions</div>
            <div class="flex flex-wrap items-center gap-2">
              <button
                onClick={() => handleRescanRepo(repo().path)}
                disabled={repoActionBusy().has(repo().path) || scanning() || fetching()}
                class="flex items-center gap-1 px-2 py-1 bg-zinc-800/50 hover:bg-zinc-700/50 border border-zinc-700/50 rounded text-[11px] text-zinc-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span>{repoActionBusy().has(repo().path) && repoActionMsg().get(repo().path)?.startsWith("Scan") ? "..." : "↻"} Scan</span>
                <Show when={repoActionMsg().get(repo().path) && repoActionMsg().get(repo().path)!.startsWith("Scan")}>
                  <span class="text-zinc-500">· {repoActionMsg().get(repo().path)}</span>
                </Show>
              </button>
              <button
                onClick={() => handleCheckPull(repo().path)}
                disabled={repoActionBusy().has(repo().path) || scanning() || fetching()}
                class="flex items-center gap-1 px-2 py-1 bg-zinc-800/50 hover:bg-zinc-700/50 border border-zinc-700/50 rounded text-[11px] text-zinc-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <span>{repoActionBusy().has(repo().path) && repoActionMsg().get(repo().path)?.includes("Check") ? "..." : "⇣"} Check Pull</span>
                <Show when={repoActionMsg().get(repo().path) && (repoActionMsg().get(repo().path)!.includes("behind") || repoActionMsg().get(repo().path) === "Up to date" || repoActionMsg().get(repo().path) === "Checking..." || repoActionMsg().get(repo().path)?.includes("Failed"))}>
                  <span class="text-zinc-500">· {repoActionMsg().get(repo().path)}</span>
                </Show>
              </button>
            </div>
          </div>
        </Show>

        <div class="border-t border-zinc-800/40 pt-3 mb-4">
          <div class="text-[11px] font-medium text-zinc-500 uppercase tracking-[0.1em] mb-2">Scan Settings</div>
          <label class="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer select-none hover:text-zinc-300 transition-colors mb-1.5">
            <input
              type="checkbox"
              checked={repo().skipUntracked === true}
              onChange={async (e) => {
                await updateRepoSettings(repo().path, { skipUntracked: e.currentTarget.checked });
              }}
              class="w-3 h-3 appearance-none bg-zinc-900 border border-zinc-700 rounded cursor-pointer"
              classList={{ "bg-amber-500/20 border-amber-500/60": repo().skipUntracked }}
            />
            Skip untracked files
          </label>
          <label class="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer select-none hover:text-zinc-300 transition-colors">
            <input
              type="checkbox"
              checked={repo().skipPullCheck === true}
              onChange={async (e) => {
                await updateRepoSettings(repo().path, { skipPullCheck: e.currentTarget.checked });
              }}
              class="w-3 h-3 appearance-none bg-zinc-900 border border-zinc-700 rounded cursor-pointer"
              classList={{ "bg-amber-500/20 border-amber-500/60": repo().skipPullCheck }}
            />
            Skip pull check
          </label>
          <label class="flex items-center gap-2 text-[11px] text-zinc-400 cursor-pointer select-none hover:text-zinc-300 transition-colors mt-1.5">
            <input
              type="checkbox"
              checked={repo().autoPullIfClean === true}
              onChange={async (e) => {
                await updateRepoSettings(repo().path, { autoPullIfClean: e.currentTarget.checked });
              }}
              class="w-3 h-3 appearance-none bg-zinc-900 border border-zinc-700 rounded cursor-pointer"
              classList={{ "bg-amber-500/20 border-amber-500/60": repo().autoPullIfClean }}
            />
            Auto-pull when clean
          </label>
        </div>

        <div class="border-t border-zinc-800/40 pt-3">
          <button
            onClick={async () => {
              await updateRepoSettings(repo().path, { pinned: !repo().pinned });
            }}
            class="w-full text-left text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors mb-1.5"
          >
            {repo().pinned ? "◆ Unpin repo" : "◆ Pin repo"}
          </button>
          <button
            onClick={async () => {
              await updateRepoSettings(repo().path, { hidden: !repo().hidden });
            }}
            class="w-full text-left text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            {repo().hidden ? "⊘ Unhide repo" : "⊘ Hide repo"}
          </button>
        </div>
        </div>
      </>
    );
  }

  function Section(props: { title: string; icon: string; repos: RepoInfo[] }) {
    const isCollapsed = () => collapsed().has(props.title);
    const isBehindSection = () => props.title === "Behind Remote";
    const safePullCount = () => props.repos.filter(canSafePull).length;
    return (
      <div class="mb-4 last:mb-0">
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <button
            onMouseDown={() => toggleCollapsed(props.title)}
            class="flex items-center gap-2 min-w-0 text-left group px-1.5 py-0.5 rounded hover:bg-zinc-800/40 transition-colors"
          >
            <svg
              class="w-2.5 h-2.5 text-zinc-700 transition-transform duration-150 group-hover:text-zinc-500"
              classList={{ "rotate-90": !isCollapsed() }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" />
            </svg>
            <span class="text-[11px] font-medium text-zinc-500 uppercase tracking-[0.1em] truncate">{props.icon} {props.title}</span>
            <span class="text-[11px] text-zinc-700">{props.repos.length}</span>
          </button>
          <Show when={isBehindSection()}>
            <button
              onMouseDown={(e) => { e.stopPropagation(); void handlePullCleanBehind(props.repos); }}
              disabled={bulkPullBusy() || safePullCount() === 0}
              title={safePullCount() === props.repos.length ? "Pull all behind repos" : `Pull ${safePullCount()} clean behind repos; dirty or ahead repos are skipped`}
              class="shrink-0 flex items-center gap-1 px-2 py-0.5 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/20 rounded text-[10px] text-orange-400/80 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <span>{bulkPullBusy() ? "Pulling" : "Pull clean"}</span>
              <span class="text-orange-500/50">{safePullCount()}</span>
              <Show when={bulkPullMsg()}>
                <span class="text-zinc-500">· {bulkPullMsg()}</span>
              </Show>
            </button>
          </Show>
        </div>
        <Show when={!isCollapsed()}>
          <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            <For each={props.repos}>{(repo) => <RepoCard repo={repo} />}</For>
          </div>
      </Show>
    </div>
  );
}

  return (
    <div class="min-h-screen bg-[#09090b] text-zinc-300">
      <div class="w-full px-6 py-6">
        <div class="mb-5">
          <div class="flex items-center justify-between">
            <div>
              <h1 class="text-sm font-semibold text-zinc-100 tracking-tight">Git Explorer</h1>
              <p class="text-[11px] text-zinc-600 mt-0.5">Scan directories for git repositories</p>
            </div>
          <div class="flex items-center gap-2">
            <button
              onClick={handleSelect}
              class="px-3 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-[11px] font-medium transition-colors"
            >
              {dir() ? "Change" : "Select Directory"}
            </button>
            <Show when={dir()}>
              <Show when={!scanning() && !fetching()} fallback={
                <>
                  <Show when={scanning()}>
                    <button
                      onClick={cancelScan}
                      class="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 rounded-lg text-[11px] font-medium transition-colors"
                    >
                      Cancel Scan
                    </button>
                  </Show>
                  <Show when={fetching()}>
                    <button
                      onClick={cancelFetchAll}
                      class="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 rounded-lg text-[11px] font-medium transition-colors"
                    >
                      Cancel Fetch
                    </button>
                  </Show>
                </>
              }>
                <button
                  onClick={startScanOnly}
                  disabled={fetching()}
                  class="px-3 py-1.5 bg-amber-600/90 hover:bg-amber-500 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Scan
                </button>
                <button
                  onClick={startFetchAll}
                  disabled={scanning()}
                  class="flex items-center gap-1 px-3 py-1.5 bg-sky-600/80 hover:bg-sky-500 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>⇣ Check Pull</span>
                </button>
              </Show>
            </Show>
            <Show when={authState() === "authenticated" && userEmail()}>
              <div class="flex items-center gap-2 mr-1">
                <span class="text-[11px] text-zinc-500 truncate max-w-[140px]">{userEmail()}</span>
                <button
                  onClick={() => logout()}
                  class="px-2 py-1 text-[11px] text-zinc-600 hover:text-zinc-400 hover:bg-zinc-900 rounded transition-colors"
                >
                  Sign out
                </button>
              </div>
            </Show>
            <div class="relative" ref={settingsRef}>
              <button
                onMouseDown={() => { setShowSettings(!showSettings()); if (!showSettings()) setModelDraft(config().opencodeModel); }}
                class="px-2 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <Show when={showSettings()}>
                <>
                  <div class="absolute right-0 top-full mt-1 z-20 w-80 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl p-3 max-h-[80vh] overflow-y-auto">
                    <div class="text-[11px] font-medium text-zinc-400 mb-2 uppercase tracking-wider">OpenCode Model</div>
                    <input
                      value={modelDraft()}
                      onInput={(e) => setModelDraft(e.currentTarget.value)}
                      placeholder="provider/model"
                      class="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[12px] text-zinc-300 focus:outline-none focus:border-zinc-500 mb-2"
                    />
                    <div class="flex items-center justify-between mb-4">
                      <span class="text-[10px] text-zinc-600">e.g. CrofAI/deepseek-v4-flash</span>
                       <button
                         onClick={async () => {
                           const newConfig = { opencodeModel: modelDraft() || "CrofAI/deepseek-v4-flash", excludedDirs: config().excludedDirs, machines: config().machines };
                           await api.setConfig(newConfig);
                           setConfig(newConfig);
                           setShowSettings(false);
                         }}
                        class="px-2.5 py-1 bg-sky-600/80 hover:bg-sky-500 rounded text-[11px] font-medium transition-colors"
                      >
                        Save
                      </button>
                    </div>

                    <div class="border-t border-zinc-800 pt-3 mb-4">
                      <div class="text-[11px] font-medium text-zinc-400 mb-2 uppercase tracking-wider">Excluded Folders</div>
                      <div class="text-[10px] text-zinc-600 mb-2">Folders here and everything under them are skipped when scanning.</div>
                      <For each={config().excludedDirs ?? []}>{(d) =>
                        <div class="flex items-center justify-between py-1.5 px-2 bg-zinc-800/50 rounded mb-1">
                          <span class="text-[11px] text-zinc-300 truncate font-mono" title={d}>{d}</span>
                          <button
                            onClick={async () => {
                              const updated = (config().excludedDirs ?? []).filter(x => x !== d)
                              const newConfig = { opencodeModel: config().opencodeModel, excludedDirs: updated, machines: config().machines }
                              await api.setConfig(newConfig)
                              setConfig(newConfig)
                            }}
                            class="text-zinc-600 hover:text-red-400 text-[14px] leading-none ml-2 shrink-0"
                          >×</button>
                        </div>
                      }</For>
                      <Show when={(config().excludedDirs ?? []).length === 0}>
                        <div class="text-[10px] text-zinc-600 italic mb-1">No folders excluded.</div>
                      </Show>
                      <div class="flex items-center gap-1 mt-2">
                        <input
                          value={excludeDraft()}
                          onInput={(e) => setExcludeDraft(e.currentTarget.value)}
                          placeholder="C:\Projects\archive"
                          class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-500 min-w-0"
                        />
                        <button
                          onMouseDown={async (e) => {
                            e.preventDefault();
                            const picked = await pickDirectory();
                            if (picked) setExcludeDraft(picked);
                          }}
                          class="px-2 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[11px] font-medium transition-colors shrink-0"
                        >Browse</button>
                        <button
                          onClick={async () => {
                            const p = excludeDraft().trim();
                            if (!p) return;
                            const current = config().excludedDirs ?? [];
                            if (current.some(x => x.toLowerCase() === p.toLowerCase())) {
                              setExcludeDraft("");
                              return;
                            }
                            const updated = [...current, p];
                            const newConfig = { opencodeModel: config().opencodeModel, excludedDirs: updated, machines: config().machines }
                            await api.setConfig(newConfig)
                            setConfig(newConfig)
                            setExcludeDraft("")
                          }}
                          class="px-2 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[11px] font-medium transition-colors shrink-0"
                        >+</button>
                      </div>
                    </div>

                    <div class="border-t border-zinc-800 pt-3 mb-2">
                      <div class="text-[11px] font-medium text-zinc-400 mb-2 uppercase tracking-wider">Remote Machines</div>
                      <div class="flex items-center gap-2 px-2 py-1.5 bg-zinc-800/30 rounded mb-2">
                        <span class="text-[10px] text-zinc-500">Your token:</span>
                        <code class="text-[10px] text-zinc-400 font-mono bg-zinc-800 px-1.5 py-0.5 rounded select-all">{config().token || "loading..."}</code>
                        <button
                          onMouseDown={() => navigator.clipboard.writeText(config().token || "")}
                          class="text-[10px] text-zinc-500 hover:text-zinc-300 ml-auto shrink-0"
                        >copy</button>
                      </div>
                      <For each={config().machines ?? []}>{(m) =>
                        <div class="flex items-center justify-between py-1.5 px-2 bg-zinc-800/50 rounded mb-1">
                          <div class="flex items-center gap-2 min-w-0">
                            <span class="text-[10px] text-emerald-400/60 shrink-0">●</span>
                            <span class="text-[12px] text-zinc-300 truncate">{m.name}</span>
                            <span class="text-[10px] text-zinc-600 truncate hidden sm:block">{m.url}</span>
                          </div>
                          <button
                            onClick={async () => {
                              const updated = (config().machines ?? []).filter(x => x.name !== m.name)
                              const newConfig = { opencodeModel: config().opencodeModel, excludedDirs: config().excludedDirs, machines: updated }
                              await api.setConfig(newConfig)
                              setConfig(newConfig)
                              setMachines(updated.map(x => ({ ...x, online: machines().find(m2 => m2.name === x.name)?.online ?? false })))
                            }}
                            class="text-zinc-600 hover:text-red-400 text-[14px] leading-none ml-2 shrink-0"
                          >×</button>
                        </div>
                      }</For>

                      <div class="flex items-center gap-1 mt-2">
                        <input
                          value={machineNameDraft()}
                          onInput={(e) => setMachineNameDraft(e.currentTarget.value)}
                          placeholder="name"
                          class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-300 focus:outline-none focus:border-zinc-500 min-w-0"
                        />
                        <input
                          value={machineUrlDraft()}
                          onInput={(e) => setMachineUrlDraft(e.currentTarget.value)}
                          placeholder="http://git-glance.local:3451"
                          class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-300 focus:outline-none focus:border-zinc-500 min-w-0"
                        />
                        <input
                          value={machineTokenDraft()}
                          onInput={(e) => setMachineTokenDraft(e.currentTarget.value)}
                          placeholder="token"
                          class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-300 font-mono focus:outline-none focus:border-zinc-500 min-w-0"
                        />
                        <button
                          onClick={async () => {
                            const name = machineNameDraft().trim()
                            const url = machineUrlDraft().trim()
                            const token = machineTokenDraft().trim()
                            if (!name || !url || !token) return
                            const updated = [...(config().machines ?? []), { name, url, token }]
                            const newConfig = { opencodeModel: config().opencodeModel, excludedDirs: config().excludedDirs, machines: updated }
                            await api.setConfig(newConfig)
                            setConfig(newConfig)
                            setMachines(updated.map(x => ({ ...x, online: machines().find(m2 => m2.name === x.name)?.online ?? false })))
                            setMachineNameDraft("")
                            setMachineUrlDraft("")
                            setMachineTokenDraft("")
                          }}
                          class="px-2 py-1.5 bg-zinc-700 hover:bg-zinc-600 rounded text-[11px] font-medium transition-colors shrink-0"
                        >+</button>
                      </div>
                    </div>
                  </div>
                </>
              </Show>
            </div>
          </div>
          </div>
          <Show when={scanError()}>
            <div class="mt-3 text-[11px] text-red-400/80 bg-red-950/20 border border-red-900/40 rounded-lg px-3 py-2">
              {scanError()}
            </div>
          </Show>
        </div>

        <Show when={machines().length > 0}>
          <div class="flex items-center gap-1 mb-3">
            <button onMouseDown={() => setMachineFilter(null)}
              class="text-[11px] px-2 py-1 rounded transition-colors"
              classList={{ "bg-zinc-800 text-zinc-300": machineFilter() === null, "text-zinc-600 hover:text-zinc-400": machineFilter() !== null }}
            >All</button>
            <span class="text-zinc-800">·</span>
            <Show when={repos().some(r => r.machine === "local")}>
              <button onMouseDown={() => setMachineFilter("local")}
                class="text-[11px] px-2 py-1 rounded transition-colors"
                classList={{ "bg-zinc-800 text-zinc-300": machineFilter() === "local", "text-zinc-600 hover:text-zinc-400": machineFilter() !== "local" }}
              >Local</button>
            </Show>
            <For each={machines()}>{(m) =>
              <button onMouseDown={() => setMachineFilter(m.name)}
                class="text-[11px] px-2 py-1 rounded transition-colors flex items-center gap-1"
                classList={{ "bg-zinc-800 text-zinc-300": machineFilter() === m.name, "text-zinc-600 hover:text-zinc-400": machineFilter() !== m.name }}
              >
                <span classList={{ "text-emerald-400/60": m.online, "text-red-400/60": !m.online }}>●</span>
                {m.name}
              </button>
            }</For>
          </div>
        </Show>

        <Show when={dir()}>
          <div class="text-[11px] text-zinc-700 mb-3 truncate flex items-center gap-2">
            <span class="truncate">{dir()}</span>
            <Show when={!loading() && !scanning()}>
              <span class="text-zinc-700 shrink-0">· {repos().length} repos</span>
            </Show>
          </div>
        </Show>

        <Show when={scanning() && progress().total > 0}>
          <div class="mb-4">
            <div class="flex items-center justify-between text-[11px] mb-1.5">
              <span class="text-zinc-500">Scanning repositories...</span>
              <span class="text-zinc-600 tabular-nums">{progress().current}/{progress().total}</span>
            </div>
            <div class="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-amber-500/60 rounded-full transition-all duration-300 ease-out"
                style={{ width: ((progress().current / progress().total) * 100) + "%" }}
              />
            </div>
          </div>
        </Show>

        <Show when={fetching() && fetchProgress().total > 0}>
          <div class="mb-4">
            <div class="flex items-center justify-between text-[11px] mb-1.5">
              <div class="flex items-center gap-2">
                <div class="w-1.5 h-1.5 bg-sky-500/60 rounded-full animate-pulse" />
                <span class="text-zinc-500">Checking for pull updates...</span>
              </div>
              <span class="text-zinc-600 tabular-nums">{fetchProgress().current}/{fetchProgress().total}</span>
            </div>
            <div class="h-1 bg-zinc-800 rounded-full overflow-hidden">
              <div
                class="h-full bg-sky-500/60 rounded-full transition-all duration-300 ease-out"
                style={{ width: ((fetchProgress().current / fetchProgress().total) * 100) + "%" }}
              />
            </div>
            <Show when={fetchCurrentRepo()}>
              <div class="text-[10px] text-zinc-600 mt-1 truncate">{fetchCurrentRepo()}</div>
            </Show>
          </div>
        </Show>

        <Show when={loading()}>
          <div class="text-center py-20 text-zinc-700">
            <p class="text-sm">Loading...</p>
          </div>
        </Show>

        <Show when={!loading() && repos().length > 0}>
          <div class="flex items-center gap-4 mb-5 pb-4 border-b border-zinc-800/50">
            <div class="flex items-center gap-1.5 text-[11px]">
              <span class="text-zinc-400 tabular-nums">{listData().counts.total}</span>
              <span class="text-zinc-600">repos</span>
            </div>
            <span class="text-zinc-800">·</span>
            <div class="flex items-center gap-1.5 text-[11px]">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-400/60" />
              <span class="text-zinc-400 tabular-nums">{listData().counts.dirty}</span>
              <span class="text-zinc-600">dirty</span>
            </div>
            <div class="flex items-center gap-1.5 text-[11px]">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-orange-400/60" />
              <span class="text-zinc-400 tabular-nums">{listData().counts.stale}</span>
              <span class="text-zinc-600">stale</span>
            </div>
            <Show when={listData().counts.errored > 0}>
              <div class="flex items-center gap-1.5 text-[11px]">
                <span class="inline-block w-1.5 h-1.5 rounded-full bg-red-400/60" />
                <span class="text-zinc-400 tabular-nums">{listData().counts.errored}</span>
                <span class="text-zinc-600">errors</span>
              </div>
            </Show>
            <div class="flex items-center gap-1.5 text-[11px]">
              <span class="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400/60" />
              <span class="text-zinc-400 tabular-nums">{listData().counts.clean}</span>
              <span class="text-zinc-600">clean</span>
            </div>
            <Show when={listData().counts.hidden > 0}>
              <div class="flex items-center gap-1.5 text-[11px]">
                <span class="text-zinc-700">⊘</span>
                <span class="text-zinc-600 tabular-nums">{listData().counts.hidden}</span>
                <span class="text-zinc-700">hidden</span>
              </div>
            </Show>
            <div class="ml-auto flex items-center gap-3">
              <div class="relative">
                <input
                  ref={searchInput}
                  type="text"
                  value={search()}
                  onInput={(e) => setSearch(e.currentTarget.value)}
                  placeholder="Search repos…  /"
                  class="w-44 sm:w-52 bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-300 rounded-lg pl-7 pr-2 py-1 focus:outline-none focus:border-zinc-600 placeholder:text-zinc-700"
                />
                <svg class="w-3.5 h-3.5 text-zinc-600 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <Show when={search()}>
                  <button
                    onMouseDown={() => { setSearch(""); searchInput?.focus(); }}
                    class="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-600 hover:text-zinc-400 text-[14px] leading-none px-1"
                    title="Clear"
                  >×</button>
                </Show>
              </div>
              <div class="flex items-center gap-2">
                <span class="text-[11px] text-zinc-600">sort</span>
                <select
                  value={sortKey()}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                  class="bg-zinc-900 border border-zinc-800 text-[11px] text-zinc-400 rounded-lg px-2 py-1 focus:outline-none focus:border-zinc-600 cursor-pointer"
                >
                  <option value="last-commit">last commit</option>
                  <option value="week-activity">weekly activity</option>
                  <option value="name">name</option>
                  <option value="pull-count">pull count</option>
                </select>
              </div>
              <label class="flex items-center gap-1.5 text-[11px] text-zinc-600 cursor-pointer select-none hover:text-zinc-400 transition-colors">
                <input
                  type="checkbox"
                  checked={grouped()}
                  onChange={(e) => setGrouped(e.target.checked)}
                  class="w-3 h-3 appearance-none bg-zinc-900 border border-zinc-700 rounded cursor-pointer"
                  classList={{ "bg-amber-500/20 border-amber-500/60": grouped() }}
                />
                group by status
              </label>
            </div>
          </div>

          <Show
            when={search().trim() && listData().counts.total === 0}
            fallback={
              <Show
                when={grouped()}
                fallback={
                  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                    <For each={listData().groups.clean}>{(repo) => <RepoCard repo={repo} />}</For>
                  </div>
                }
              >
                <Show when={listData().counts.errored > 0}>
                  <Section title="Errors" icon="!" repos={listData().groups.errored} />
                </Show>
                <Show when={listData().counts.stale > 0}>
                  <Section title="Behind Remote" icon="⇣" repos={listData().groups.stale} />
                </Show>
                <Show when={listData().counts.dirty > 0}>
                  <Section title="Uncommitted" icon="~" repos={listData().groups.dirty} />
                </Show>
                <Show when={listData().counts.clean > 0}>
                  <Section title="Clean" icon="·" repos={listData().groups.clean} />
                </Show>
                <Show when={listData().counts.hidden > 0}>
                  <Section title="Hidden" icon="⊘" repos={listData().groups.hidden} />
                </Show>
              </Show>
            }
          >
            <div class="text-center py-16 text-zinc-700">
              <p class="text-sm">No repos match “{search().trim()}”</p>
              <button
                onMouseDown={() => { setSearch(""); searchInput?.focus(); }}
                class="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
              >Clear search</button>
            </div>
          </Show>
        </Show>

        <Show when={!loading() && dir() && !scanning() && repos().length === 0}>
          <div class="text-center py-20 text-zinc-700">
            <p class="text-sm">No git repositories found</p>
            <p class="text-[11px] mt-1">Try selecting a different directory</p>
          </div>
        </Show>
      </div>

      <Show when={selectedRepoData()} keyed>
        {(repo) => <Sidebar repo={repo} />}
      </Show>

      <Show when={diffFile()}>
        <DiffPanel />
      </Show>

      <Show when={showDirModal()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div class="fixed inset-0 bg-black/60" onMouseDown={() => setShowDirModal(false)} />
          <div class="relative z-10 w-full max-w-md bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-5">
            <h2 class="text-sm font-semibold text-zinc-100 tracking-tight mb-1">Select Directory</h2>
            <p class="text-[11px] text-zinc-500 mb-3">Enter the full path of a directory to scan for git repositories.</p>
            <input
              ref={(el) => { setTimeout(() => el.focus(), 0); }}
              value={dirInputValue()}
              onInput={(e) => { setDirInputValue(e.currentTarget.value); setDirInputError(null); }}
              onKeyDown={(e) => { if (e.key === "Enter") submitDirInput(); }}
              placeholder="e.g. C:\Users\Ryzen\projects"
              class="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-[12px] text-zinc-300 focus:outline-none focus:border-zinc-500 placeholder:text-zinc-600"
            />
            <Show when={dirInputError()}>
              <p class="text-[11px] text-red-400/80 mt-1.5">{dirInputError()}</p>
            </Show>
            <div class="flex items-center justify-end gap-2 mt-3">
              <button
                onMouseDown={() => setShowDirModal(false)}
                class="px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-[11px] font-medium text-zinc-400 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitDirInput}
                class="px-3 py-1.5 bg-amber-600/90 hover:bg-amber-500 rounded-lg text-[11px] font-medium transition-colors"
              >
                Select
              </button>
            </div>
          </div>
        </div>
      </Show>
      <Show when={authState() === "unauthenticated"}>
        <div class="fixed inset-0 z-50 flex items-center justify-center bg-[#09090b]">
          <div class="text-center">
            <h1 class="text-lg font-semibold text-zinc-100 mb-2">Git Explorer</h1>
            <p class="text-[13px] text-zinc-500 mb-6">Sign in to continue</p>
            <button
              onClick={() => login()}
              class="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 rounded-lg text-[13px] font-medium text-zinc-300 transition-colors"
            >
              Sign in with Google
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
