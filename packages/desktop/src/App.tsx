import { createSignal, For, Show, createMemo, onMount, onCleanup } from "solid-js";
import { api, repoDataToInfo } from "./api";
import type { RepoInfo } from "./api";

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
  const [config, setConfig] = createSignal<{ opencodeModel: string; machines?: { name: string; url: string }[] }>({ opencodeModel: "CrofAI/deepseek-v4-flash" });
  const [showSettings, setShowSettings] = createSignal(false);
  const [sidebarCloseForce, setSidebarCloseForce] = createSignal(0);
  const [modelDraft, setModelDraft] = createSignal("");
  const [commitBusy, setCommitBusy] = createSignal<string | null>(null);
  const [commitPhase, setCommitPhase] = createSignal<string>("");
  const [commitError, setCommitError] = createSignal<string | null>(null);
  const [fetching, setFetching] = createSignal(false);
  const [fetchProgress, setFetchProgress] = createSignal<{ current: number; total: number }>({ current: 0, total: 0 });
  const [fetchCurrentRepo, setFetchCurrentRepo] = createSignal<string>("");
  const [machineFilter, setMachineFilter] = createSignal<string | null>(null);
  const [machines, setMachines] = createSignal<{ name: string; url: string; online: boolean }[]>([]);
  const [machineNameDraft, setMachineNameDraft] = createSignal("");
  const [machineUrlDraft, setMachineUrlDraft] = createSignal("");
  const [showDirModal, setShowDirModal] = createSignal(false);
  const [dirInputValue, setDirInputValue] = createSignal("");
  const [dirInputError, setDirInputError] = createSignal<string | null>(null);

  let scanController: AbortController | null = null;
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
    const cfg = await api.getConfig();
    if (cfg) {
      setConfig({ opencodeModel: cfg.opencodeModel, machines: cfg.machines?.map(m => ({ name: m.name, url: m.url })) });
      setMachines((cfg.machines || []).map(m => ({ name: m.name, url: m.url, online: m.online })));
      if (cfg.rootDir) setDir(cfg.rootDir);
    }

    const data = await api.getRepos();
    setRepos(data.repos.map(repoDataToInfo));
    setMachines(data.machines.map(m => ({ name: m.name, url: m.url, online: m.online })));
    setLoading(false);
  });

  onCleanup(() => {
    scanController?.abort();
    commitController?.abort();
    fetchController?.abort();
    if (flushTimer !== null) clearTimeout(flushTimer);
  });

  async function handleSelect() {
    let result: string | null = null;
    try {
      const { Electroview } = await import("electrobun/view");
      const ev = new Electroview({});
      result = (await ev.rpc.request.selectDirectory()) as string | null;
    } catch {
      // Fallback: running in browser (Vite dev) — show modal
    }
    if (!result) {
      setDirInputValue(dir() || "");
      setDirInputError(null);
      setShowDirModal(true);
      return;
    }
    if (result) {
      setDir(result);
      setRepos([]);
      await api.setConfig({ rootDir: result });
    }
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
    await api.setConfig({ rootDir: path });
  }

  function startScan() {
    scanController?.abort();
    repoBuffer = [];
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    setScanning(true);
    setProgress({ current: 0, total: 0 });

    const d = dir();
    if (!d) return;

    scanController = api.subscribeScan(d, (data) => {
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
        setScanning(false);
        setFetching(true);
        setFetchProgress({ current: 0, total: 0 });
        fetchController?.abort();
        fetchController = api.subscribeFetch((ev) => {
          if (ev.phase === "fetching") {
            setFetchCurrentRepo(ev.repoName || ev.repoPath || "");
            setFetchProgress({ current: ev.current, total: ev.total });
          } else if (ev.phase === "repo") {
            console.log("[debug] Fetch SSE repo event", { path: ev.repoPath, ahead: ev.ahead, behind: ev.behind, current: ev.current, total: ev.total });
            setRepos(prev => {
              const next = prev.slice();
              const idx = next.findIndex(r => r.path === ev.repoPath);
              if (idx >= 0) {
                next[idx] = { ...next[idx], cached: false, status: { ...next[idx].status, ahead: ev.ahead ?? next[idx].status.ahead, behind: ev.behind ?? next[idx].status.behind, branch: ev.branch || next[idx].status.branch, error: ev.error || next[idx].status.error } };
              }
              return next;
            });
            setFetchProgress({ current: ev.current, total: ev.total });
          } else if (ev.phase === "done") {
            setFetching(false);
            setFetchCurrentRepo("");
          }
        });
      }
    }, () => {
      setScanning(false);
      if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
      flushRepoBuffer();
    });
  }

  function cancelScan() {
    api.cancelScan();
    scanController?.abort();
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    flushRepoBuffer();
    setScanning(false);
  }

  async function updateRepoSettings(repoPath: string, settings: { skipUntracked?: boolean; skipPullCheck?: boolean; hidden?: boolean }) {
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
    setSidebarCloseForce(t => t + 1);
  }

  const selectedRepoData = () => {
    sidebarCloseForce();
    const sel = selectedRepo();
    const result = repos().find(r => r.path === sel);
    console.log("[debug] selectedRepoData re-eval", { selectedRepo: sel, found: result?.path ?? "undefined", reposLen: repos().length });
    return result;
  };
  const hasCached = () => repos().some(r => r.cached);

  const listData = createMemo(() => {
    const all = machineFilter() ? repos().filter(r => r.machine === machineFilter()) : repos();
    const key = sortKey();
    const isGrouped = grouped();

    const cmp = key === "last-commit"
      ? (a: RepoInfo, b: RepoInfo) => (b.status.lastCommitTime ?? 0) - (a.status.lastCommitTime ?? 0)
      : key === "week-activity"
        ? (a: RepoInfo, b: RepoInfo) => b.status.weekCommits - a.status.weekCommits
        : key === "pull-count"
          ? (a: RepoInfo, b: RepoInfo) => (b.status.behind ?? 0) - (a.status.behind ?? 0)
          : (a: RepoInfo, b: RepoInfo) => a.name.localeCompare(b.name);

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

  function PullButton(props: { repoPath: string; repoName: string; behind: number; machine?: string }) {
    const [busy, setBusy] = createSignal(false);
    const [msg, setMsg] = createSignal<string | null>(null);
    async function pull() {
      if (busy()) return;
      setBusy(true);
      setMsg(null);
      const result = await api.pullRepo(props.repoPath, props.machine);
      console.log("[debug] PullButton pull result", result);
      if (result.ok) {
        const data = await api.getRepos();
        console.log("[debug] PullButton gotRepos", { count: data.repos.length, paths: data.repos.map(r => r.path) });
        const updated = data.repos.map(repoDataToInfo).find(r => r.path === props.repoPath);
        console.log("[debug] PullButton updated found", !!updated);
        if (updated) {
          setRepos(prev => {
            const next = prev.slice();
            const idx = next.findIndex(r => r.path === props.repoPath);
            if (idx >= 0) next[idx] = updated;
            return next;
          });
        }
      }
      console.log("[debug] PullButton setMsg/busy before");
      setMsg(result.ok ? `Pulled` : `Failed: ${result.error ?? "unknown"}`);
      setBusy(false);
      console.log("[debug] PullButton setMsg/busy done");
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

  function PushButton(props: { repoPath: string; repoName: string; ahead: number; machine?: string }) {
    const [busy, setBusy] = createSignal(false);
    const [msg, setMsg] = createSignal<string | null>(null);
    async function push() {
      if (busy()) return;
      setBusy(true);
      setMsg(null);
      const result = await api.pushRepo(props.repoPath, props.machine);
      if (result.ok) {
        const data = await api.getRepos();
        const updated = data.repos.map(repoDataToInfo).find(r => r.path === props.repoPath);
        if (updated) {
          setRepos(prev => {
            const next = prev.slice();
            const idx = next.findIndex(r => r.path === props.repoPath);
            if (idx >= 0) next[idx] = updated;
            return next;
          });
        }
      }
      setMsg(result.ok ? `Pushed` : `Failed: ${result.error ?? "unknown"}`);
      setBusy(false);
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

  function CommitButton(props: { repoPath: string }) {
    const isBusy = () => commitBusy() === props.repoPath;
    const phaseLabel = () => {
      const labels: Record<string, string> = {
        staging: "Staging...",
        generating: "Generating message...",
        committing: "Committing...",
        pushing: "Pushing...",
      };
      return labels[commitPhase()] || "";
    };
    function start() {
      if (commitBusy()) return;
      setCommitBusy(props.repoPath);
      setCommitPhase("staging");
      setCommitError(null);
      commitController?.abort();
      commitController = api.subscribeCommitPush(props.repoPath, (data) => {
        if (data.phase === "error") {
          setCommitError(data.error || "Unknown error");
          setCommitBusy(null);
          setCommitPhase("");
        } else if (data.phase === "done") {
          api.getRepos().then(d => {
            const updated = d.repos.map(repoDataToInfo).find(r => r.path === props.repoPath);
            if (updated) {
              setRepos(prev => {
                const next = prev.slice();
                const idx = next.findIndex(r => r.path === props.repoPath);
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
    function cancel() {
      api.cancelCommit();
      commitController?.abort();
      setCommitBusy(null);
      setCommitPhase("");
    }
    return (
      <div class="flex-1">
        <Show when={!isBusy() && !commitError()}>
          <button
            onClick={start}
            class="flex items-center gap-1 px-2 py-1 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/20 rounded text-[11px] text-sky-400/80 transition-colors"
          >
            ⇡ Commit & Push
          </button>
        </Show>
        <Show when={isBusy()}>
          <div class="flex items-center gap-2">
            <div class="h-1 bg-zinc-800 rounded-full overflow-hidden flex-1 min-w-[60px]">
              <div
                class="h-full bg-sky-500/60 rounded-full transition-all duration-300 ease-out animate-pulse"
                style={{ width: "100%" }}
              />
            </div>
            <span class="text-[10px] text-zinc-500 tabular-nums">{phaseLabel()}</span>
            <button
              onClick={cancel}
              class="text-[10px] text-zinc-600 hover:text-zinc-400 transition-colors"
            >
              cancel
            </button>
          </div>
        </Show>
        <Show when={!isBusy() && commitError() && commitBusy() === null}>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-red-400/80 truncate max-w-[200px]">{commitError()}</span>
            <button
              onClick={start}
              class="text-[10px] text-sky-400/80 hover:text-sky-300 transition-colors shrink-0"
            >
              retry
            </button>
          </div>
        </Show>
      </div>
    );
  }

  function RepoCard(props: { repo: RepoInfo }) {
    const repo = () => props.repo;
    const isSelected = () => selectedRepo() === repo().path;
    const isRemote = () => repo().machine !== "local";
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
        onClick={() => setSelectedRepo(isSelected() ? null : repo().path)}
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

  function Sidebar(props: { repo: RepoInfo }) {
    const repo = () => props.repo;
    const currentPath = repo().path;
    onMount(() => console.log("[debug] Sidebar mounted", currentPath));
    onCleanup(() => console.log("[debug] Sidebar cleanup", currentPath));
    return (
      <>
        <div class="fixed inset-0 z-30" onClick={() => { console.log("[debug] Sidebar backdrop click"); closeSidebar(); }} />
        <div class="fixed top-0 right-0 z-40 h-full w-80 bg-[#09090b] border-l border-zinc-800/50 shadow-2xl p-5 overflow-y-auto">
        <div class="flex items-center justify-between mb-4">
          <h2 class="text-sm font-semibold text-zinc-100 truncate">{repo().name}</h2>
          <button
            onClick={() => { console.log("[debug] Sidebar X click"); closeSidebar(); }}
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

          <Show when={repo().machine !== "local"}>
            <div class="mb-3 px-2 py-1 rounded text-[11px] bg-indigo-500/10 text-indigo-400/70 border border-indigo-500/20">
              Machine: {repo().machine}
            </div>
          </Show>

          <div class="flex flex-wrap items-center gap-2 mb-4">
            <Show when={repo().status.behind > 0}>
              <PullButton repoPath={repo().path} repoName={repo().name} behind={repo().status.behind} machine={repo().machine !== "local" ? repo().machine : undefined} />
            </Show>
            <Show when={repo().status.ahead > 0}>
              <PushButton repoPath={repo().path} repoName={repo().name} ahead={repo().status.ahead} machine={repo().machine !== "local" ? repo().machine : undefined} />
            </Show>
            <Show when={repo().status.staged > 0 || repo().status.unstaged > 0 || repo().status.untracked > 0}>
              <CommitButton repoPath={repo().path} />
            </Show>
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
        </div>

        <div class="border-t border-zinc-800/40 pt-3">
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
    return (
      <div class="mb-4 last:mb-0">
        <button
          onClick={() => toggleCollapsed(props.title)}
          class="flex items-center gap-2 w-full text-left mb-1.5 group"
        >
          <svg
            class="w-2.5 h-2.5 text-zinc-700 transition-transform duration-150 group-hover:text-zinc-500"
            classList={{ "rotate-90": !isCollapsed() }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7" />
          </svg>
          <span class="text-[11px] font-medium text-zinc-500 uppercase tracking-[0.1em]">{props.icon} {props.title}</span>
          <span class="text-[11px] text-zinc-700">{props.repos.length}</span>
        </button>
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
        <div class="flex items-center justify-between mb-5">
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
              <Show when={!scanning()} fallback={
                <button
                  onClick={cancelScan}
                  class="px-3 py-1.5 bg-red-600/80 hover:bg-red-500 rounded-lg text-[11px] font-medium transition-colors"
                >
                  Cancel
                </button>
              }>
                <button
                  onClick={startScan}
                  class="px-3 py-1.5 bg-amber-600/90 hover:bg-amber-500 rounded-lg text-[11px] font-medium transition-colors"
                >
                  Scan
                </button>
              </Show>
            </Show>
            <div class="relative">
              <button
                onClick={() => { setShowSettings(!showSettings()); if (!showSettings()) setModelDraft(config().opencodeModel); }}
                class="px-2 py-1.5 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 rounded-lg text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
              <Show when={showSettings()}>
                <>
                  <div class="fixed inset-0 z-10" onClick={() => setShowSettings(false)} />
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
                          const newConfig = { opencodeModel: modelDraft() || "CrofAI/deepseek-v4-flash", machines: config().machines };
                          await api.setConfig(newConfig);
                          setConfig(newConfig);
                          setShowSettings(false);
                        }}
                        class="px-2.5 py-1 bg-sky-600/80 hover:bg-sky-500 rounded text-[11px] font-medium transition-colors"
                      >
                        Save
                      </button>
                    </div>

                    <div class="border-t border-zinc-800 pt-3 mb-2">
                      <div class="text-[11px] font-medium text-zinc-400 mb-2 uppercase tracking-wider">Remote Machines</div>
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
                              const newConfig = { opencodeModel: config().opencodeModel, machines: updated }
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
                          placeholder="http://host:3456"
                          class="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-[11px] text-zinc-300 focus:outline-none focus:border-zinc-500 min-w-0"
                        />
                        <button
                          onClick={async () => {
                            const name = machineNameDraft().trim()
                            const url = machineUrlDraft().trim()
                            if (!name || !url) return
                            const updated = [...(config().machines ?? []), { name, url }]
                            const newConfig = { opencodeModel: config().opencodeModel, machines: updated }
                            await api.setConfig(newConfig)
                            setConfig(newConfig)
                            setMachines(updated.map(x => ({ ...x, online: machines().find(m2 => m2.name === x.name)?.online ?? false })))
                            setMachineNameDraft("")
                            setMachineUrlDraft("")
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

        <Show when={machines().length > 0}>
          <div class="flex items-center gap-1 mb-3">
            <button onClick={() => setMachineFilter(null)}
              class="text-[11px] px-2 py-1 rounded transition-colors"
              classList={{ "bg-zinc-800 text-zinc-300": machineFilter() === null, "text-zinc-600 hover:text-zinc-400": machineFilter() !== null }}
            >All</button>
            <span class="text-zinc-800">·</span>
            <Show when={repos().some(r => r.machine === "local")}>
              <button onClick={() => setMachineFilter("local")}
                class="text-[11px] px-2 py-1 rounded transition-colors"
                classList={{ "bg-zinc-800 text-zinc-300": machineFilter() === "local", "text-zinc-600 hover:text-zinc-400": machineFilter() !== "local" }}
              >Local</button>
            </Show>
            <For each={machines()}>{(m) =>
              <button onClick={() => setMachineFilter(m.name)}
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
        </Show>

        <Show when={!loading() && dir() && !scanning() && repos().length === 0}>
          <div class="text-center py-20 text-zinc-700">
            <p class="text-sm">No git repositories found</p>
            <p class="text-[11px] mt-1">Try selecting a different directory</p>
          </div>
        </Show>
      </div>

      <Show when={selectedRepoData()}>
        <Sidebar repo={selectedRepoData()!} />
      </Show>

      <Show when={showDirModal()}>
        <div class="fixed inset-0 z-50 flex items-center justify-center p-6">
          <div class="fixed inset-0 bg-black/60" onClick={() => setShowDirModal(false)} />
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
                onClick={() => setShowDirModal(false)}
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
    </div>
  );
}
