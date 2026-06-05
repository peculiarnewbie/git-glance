import { readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { GitRepo, GitRepoSettings, ScanProgress } from "./types";
import type { GitService } from "./git";
import type { CacheService } from "./cache";

let scanCanceled = false;

export function cancelScan(): void {
  scanCanceled = true;
}

export function resetCancel(): void {
  scanCanceled = false;
}

function findGitRepos(rootDir: string): string[] {
  const repos: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      let st;
      try {
        st = statSync(fullPath);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;

      if (entry === ".git") {
        repos.push(dir);
        return;
      }
      if (entry.startsWith(".") && entry !== ".git") continue;
      if (entry === "node_modules") continue;

      walk(fullPath);
    }
  }

  walk(rootDir);
  return repos;
}

async function scanOneRepo(
  git: GitService,
  repoPath: string,
  machine: string,
): Promise<GitRepo> {
  const name = basename(repoPath);
  try {
    const status = await git.getStatusWithLock(repoPath);
    const now = Date.now();
    const commitTimeMs = status.lastCommitTime
      ? status.lastCommitTime * 1000
      : 0;
    return {
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
      machine,
      settings: null,
    };
  } catch (err: any) {
    return {
      name,
      path: repoPath,
      branch: null,
      hasChanges: false,
      staged: 0,
      stagedFiles: [],
      unstaged: 0,
      unstagedFiles: [],
      untracked: 0,
      untrackedFiles: [],
      ahead: 0,
      behind: 0,
      remote: null,
      lastCommitTime: null,
      weekCommits: 0,
      lastScanTime: null,
      error: err.message,
      machine,
      settings: null,
    };
  }
}

function mergeSettings(repo: GitRepo, existingRepos: GitRepo[]): GitRepo {
  for (const e of existingRepos) {
    if (e.path === repo.path && e.settings) {
      return { ...repo, settings: e.settings };
    }
  }
  return repo;
}

async function scanGitReposConcurrently(
  git: GitService,
  repoPaths: string[],
  machine: string,
  existingRepos: GitRepo[],
): Promise<{ results: GitRepo[]; fetchable: number[] }> {
  const results: GitRepo[] = new Array(repoPaths.length);
  const sem = new Array(8).fill(null);
  let semIdx = 0;

  const promises = repoPaths.map(async (path, i) => {
    // Simple semaphore
    while (semIdx >= 8) await new Promise((r) => setTimeout(r, 10));
    semIdx++;
    try {
      const repo = await scanOneRepo(git, path, machine);
      results[i] = mergeSettings(repo, existingRepos);
    } finally {
      semIdx--;
    }
  });

  await Promise.all(promises);

  const scannedResults: GitRepo[] = [];
  const fetchable: number[] = [];
  for (let i = 0; i < results.length; i++) {
    const repo = results[i];
    if (repo.path) {
      scannedResults.push(repo);
      if (
        !scanCanceled &&
        repo.settings &&
        !repo.settings.skipPullCheck &&
        !repo.settings.hidden
      ) {
        fetchable.push(i);
      }
    }
  }

  return { results: scannedResults, fetchable };
}

async function fetchReposConcurrently(
  git: GitService,
  scannedResults: GitRepo[],
  fetchable: number[],
  progressCh: (p: ScanProgress) => void,
): Promise<void> {
  const fetchTotal = fetchable.length;
  const fetchSem = new Array(4).fill(null);
  let fetchSemIdx = 0;

  const promises = fetchable.map(async (idx) => {
    if (scanCanceled) return;

    while (fetchSemIdx >= 4) await new Promise((r) => setTimeout(r, 10));
    fetchSemIdx++;
    try {
      const repo = scannedResults[idx];
      progressCh({
        phase: "fetching",
        total: fetchTotal,
        current: 0,
        repo,
      });

      await git.runWithLock(["fetch", "origin"], repo.path, 30_000);
      const status = await git.getStatusWithLock(repo.path).catch(() => null);

      if (status) {
        const now = Date.now();
        const commitTimeMs = status.lastCommitTime
          ? status.lastCommitTime * 1000
          : 0;
        scannedResults[idx] = {
          ...repo,
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
        };
      }

      progressCh({
        phase: "fetching",
        total: fetchTotal,
        current: idx + 1,
        repo: scannedResults[idx],
      });
    } finally {
      fetchSemIdx--;
    }
  });

  await Promise.all(promises);
}

export async function scanAll(
  git: GitService,
  cache: CacheService,
  rootDir: string,
  machine: string,
  progressCh: (p: ScanProgress) => void,
): Promise<void> {
  const repoPaths = findGitRepos(rootDir);
  const total = repoPaths.length;
  const existingRepos = cache.load();

  progressCh({ phase: "discovering", total, current: 0, repo: null });

  const { results: scannedResults, fetchable } =
    await scanGitReposConcurrently(git, repoPaths, machine, existingRepos);

  for (let i = 0; i < scannedResults.length; i++) {
    progressCh({
      phase: "scanning",
      total,
      current: i + 1,
      repo: scannedResults[i],
    });
  }

  if (!scanCanceled) {
    cache.save(scannedResults);
  }

  await fetchReposConcurrently(git, scannedResults, fetchable, progressCh);

  if (!scanCanceled) {
    cache.save(scannedResults);
  }

  for (let i = 0; i < scannedResults.length; i++) {
    progressCh({
      phase: "fetching",
      total: scannedResults.length,
      current: i + 1,
      repo: scannedResults[i],
    });
  }

  progressCh({
    phase: "done",
    total: scannedResults.length,
    current: scannedResults.length,
    repo: null,
  });
}

export async function scanOnly(
  git: GitService,
  cache: CacheService,
  rootDir: string,
  machine: string,
  progressCh: (p: ScanProgress) => void,
): Promise<void> {
  const repoPaths = findGitRepos(rootDir);
  const total = repoPaths.length;
  const existingRepos = cache.load();

  progressCh({ phase: "discovering", total, current: 0, repo: null });

  const { results: scannedResults } = await scanGitReposConcurrently(
    git,
    repoPaths,
    machine,
    existingRepos,
  );

  for (let i = 0; i < scannedResults.length; i++) {
    progressCh({
      phase: "scanning",
      total,
      current: i + 1,
      repo: scannedResults[i],
    });
  }

  if (!scanCanceled) {
    cache.save(scannedResults);
  }

  progressCh({
    phase: "done",
    total: scannedResults.length,
    current: scannedResults.length,
    repo: null,
  });
}
