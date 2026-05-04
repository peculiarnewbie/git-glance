import { createSignal, For, Show, createMemo, onMount, onCleanup } from "solid-js";

type SortKey = "last-commit" | "week-activity" | "name";

interface GitStatus {
  branch: string;
  remote: string | null;
  hasChanges: boolean;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
  lastCommitTime: number | null;
  weekCommits: number;
  error?: string;
}

interface RepoInfo {
  path: string;
  name: string;
  cached: boolean;
  status: GitStatus;
}

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
  const [collapsed, setCollapsed] = createSignal<Set<string>>(new Set());
  const [loading, setLoading] = createSignal(true);

  let removeScanListener: (() => void) | null = null;
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
    const savedDir = await window.electronAPI.getSavedDir();
    if (savedDir) {
      setDir(savedDir);
      const cache = await window.electronAPI.getCache();
      const cached = Object.entries(cache.repos || {}).map(([p, d]: [string, any]) => ({
        path: p,
        name: d.name,
        cached: true,
        status: {
          branch: d.branch || "",
          remote: d.remote || null,
          hasChanges: !!d.hasChanges,
          staged: d.staged ?? 0,
          unstaged: d.unstaged ?? 0,
          untracked: d.untracked ?? 0,
          ahead: d.ahead ?? 0,
          behind: d.behind ?? 0,
          lastCommitTime: d.lastCommitTime ?? null,
          weekCommits: d.weekCommits ?? 0,
          error: d.error || undefined,
        },
      }));
      setRepos(cached);
    }
    setLoading(false);
  });

  onCleanup(() => {
    if (removeScanListener) removeScanListener();
    if (flushTimer !== null) clearTimeout(flushTimer);
  });

  async function handleSelect() {
    const result = await window.electronAPI.selectDirectory();
    if (result) {
      setDir(result);
      setRepos([]);
      await window.electronAPI.saveDir(result);
    }
  }

  function startScan() {
    if (removeScanListener) removeScanListener();
    repoBuffer = [];
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    setScanning(true);
    setProgress({ current: 0, total: 0 });

    const cleanup = window.electronAPI.onScanProgress((data) => {
      if (data.phase === "discovering") {
        setProgress({ current: 0, total: data.total });
      } else if (data.phase === "repo") {
        setProgress({ current: data.current, total: data.total });
        repoBuffer.push({ ...data.repo, cached: false });
        if (flushTimer === null) {
          flushTimer = setTimeout(() => {
            flushTimer = null;
            flushRepoBuffer();
          }, 80);
        }
      } else if (data.phase === "done") {
        if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
        flushRepoBuffer();
        setScanning(false);
      }
    });
    removeScanListener = cleanup;

    const d = dir();
    if (d) window.electronAPI.startScan(d);
  }

  function cancelScan() {
    window.electronAPI.cancelScan();
    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
    flushRepoBuffer();
    setScanning(false);
  }

  const hasCached = () => repos().some(r => r.cached);

  const listData = createMemo(() => {
    const all = repos();
    const key = sortKey();
    const isGrouped = grouped();

    const cmp = key === "last-commit"
      ? (a: RepoInfo, b: RepoInfo) => (b.status.lastCommitTime ?? 0) - (a.status.lastCommitTime ?? 0)
      : key === "week-activity"
        ? (a: RepoInfo, b: RepoInfo) => b.status.weekCommits - a.status.weekCommits
        : (a: RepoInfo, b: RepoInfo) => a.name.localeCompare(b.name);

    const errored: RepoInfo[] = [];
    const stale: RepoInfo[] = [];
    const dirty: RepoInfo[] = [];
    const clean: RepoInfo[] = [];

    for (const r of all) {
      if (r.status.error) errored.push(r);
      else if (r.status.behind > 0) stale.push(r);
      else if (r.status.hasChanges) dirty.push(r);
      else clean.push(r);
    }

    errored.sort(cmp);
    stale.sort(cmp);
    dirty.sort(cmp);
    clean.sort(cmp);

    return {
      groups: isGrouped
        ? { errored, stale, dirty, clean }
        : { errored: [], stale: [], dirty: [], clean: [...all].sort(cmp) },
      counts: {
        total: all.length,
        stale: stale.length,
        dirty: dirty.length,
        clean: clean.length,
        errored: errored.length,
      },
    };
  });

  function PullButton(props: { repoPath: string; repoName: string; behind: number }) {
    const [busy, setBusy] = createSignal(false);
    const [msg, setMsg] = createSignal<string | null>(null);
    async function pull() {
      if (busy()) return;
      setBusy(true);
      setMsg(null);
      const result = await window.electronAPI.pullRepo(props.repoPath);
      setMsg(result.ok ? `Pulled` : `Failed: ${result.error ?? "unknown"}`);
      setBusy(false);
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

  function PushButton(props: { repoPath: string; repoName: string; ahead: number }) {
    const [busy, setBusy] = createSignal(false);
    const [msg, setMsg] = createSignal<string | null>(null);
    async function push() {
      if (busy()) return;
      setBusy(true);
      setMsg(null);
      const result = await window.electronAPI.pushRepo(props.repoPath);
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

  function RepoCard(props: { repo: RepoInfo }) {
    const repo = () => props.repo;
    const isSelected = () => selectedRepo() === repo().path;
    return (
      <div
        class="border rounded-lg overflow-hidden transition-all duration-150"
        classList={{
          "bg-zinc-900/60 border-zinc-800/60 hover:border-zinc-700/60": !isSelected(),
          "bg-zinc-900 border-red-500/30 ring-1 ring-red-500/10": isSelected() && !!repo().status.error,
          "bg-zinc-900 border-orange-500/30 ring-1 ring-orange-500/10": isSelected() && !repo().status.error && repo().status.behind > 0,
          "bg-zinc-900 border-amber-500/30 ring-1 ring-amber-500/10": isSelected() && !repo().status.error && repo().status.behind === 0 && repo().status.hasChanges,
          "bg-zinc-900 border-emerald-500/30 ring-1 ring-emerald-500/10": isSelected() && !repo().status.error && repo().status.behind === 0 && !repo().status.hasChanges,
          "opacity-60": repo().cached && !isSelected(),
        }}
      >
        <button
          onClick={() => setSelectedRepo(isSelected() ? null : repo().path)}
          class="w-full flex items-center justify-between px-3 py-2 hover:bg-white/[0.015] transition-colors text-left"
        >
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
              <div class="text-[13px] font-medium truncate leading-tight"
                classList={{ "text-zinc-200": !repo().cached, "text-zinc-400": repo().cached }}
              >{repo().name}</div>
              <div class="text-[11px] text-zinc-600 truncate leading-tight mt-px">{repo().path}</div>
            </div>
          </div>
          <div class="flex items-center gap-2.5 shrink-0 ml-4">
            <Show when={repo().cached}>
              <span class="text-[10px] text-zinc-700 uppercase tracking-wider">cached</span>
            </Show>
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
            <svg
              class="w-3 h-3 text-zinc-700 transition-transform duration-150"
              classList={{ "rotate-180": isSelected() }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        </button>

        <Show when={isSelected()}>
          <div class="border-t border-zinc-800/40 px-3 py-2">
            <Show when={repo().status.error}>
              <div class="text-red-400/80 text-[11px]">Error: {repo().status.error}</div>
            </Show>
            <Show when={!repo().status.error}>
              <div class="flex items-center gap-4 text-[11px]">
                <div class="flex items-center gap-1.5">
                  <span class="tabular-nums" classList={{
                    "text-amber-400/80": repo().status.staged > 0,
                    "text-zinc-600": repo().status.staged === 0,
                  }}>{repo().status.staged}</span>
                  <span class="text-zinc-600">staged</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="tabular-nums" classList={{
                    "text-amber-400/80": repo().status.unstaged > 0,
                    "text-zinc-600": repo().status.unstaged === 0,
                  }}>{repo().status.unstaged}</span>
                  <span class="text-zinc-600">unstaged</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <span class="tabular-nums" classList={{
                    "text-amber-400/80": repo().status.untracked > 0,
                    "text-zinc-600": repo().status.untracked === 0,
                  }}>{repo().status.untracked}</span>
                  <span class="text-zinc-600">untracked</span>
                </div>
                <Show when={repo().status.remote}>
                  <span class="text-zinc-600">·</span>
                  <span class="text-zinc-600 text-[10px]">{repo().status.remote}</span>
                </Show>
              </div>
            </Show>
            <Show when={repo().status.ahead > 0 || repo().status.behind > 0}>
              <div class="flex items-center gap-2 mt-2 pt-2 border-t border-zinc-800/30">
                <Show when={repo().status.behind > 0}>
                  <PullButton repoPath={repo().path} repoName={repo().name} behind={repo().status.behind} />
                </Show>
                <Show when={repo().status.ahead > 0}>
                  <PushButton repoPath={repo().path} repoName={repo().name} ahead={repo().status.ahead} />
                </Show>
              </div>
            </Show>
          </div>
        </Show>
      </div>
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
          <div class="space-y-1">
            <For each={props.repos}>{(repo) => <RepoCard repo={repo} />}</For>
          </div>
        </Show>
      </div>
    );
  }

  return (
    <div class="min-h-screen bg-[#09090b] text-zinc-300">
      <div class="max-w-3xl mx-auto px-5 py-6">
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
          </div>
        </div>

        <Show when={dir()}>
          <div class="text-[11px] text-zinc-700 mb-3 truncate flex items-center gap-2">
            <span class="truncate">{dir()}</span>
            <Show when={!loading() && hasCached() && !scanning()}>
              <span class="text-zinc-700 shrink-0">· cached</span>
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
                style={{ width: `${(progress().current / progress().total) * 100}%` }}
              />
            </div>
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
              <div class="space-y-1">
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
          </Show>
        </Show>

        <Show when={!loading() && dir() && !scanning() && repos().length === 0}>
          <div class="text-center py-20 text-zinc-700">
            <p class="text-sm">No git repositories found</p>
            <p class="text-[11px] mt-1">Try selecting a different directory</p>
          </div>
        </Show>
      </div>
    </div>
  );
}
