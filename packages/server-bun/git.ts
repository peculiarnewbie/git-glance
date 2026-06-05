import type { FileStatus, GitStatusResult } from "./types";

export class GitCommandError extends Error {
  constructor(
    public command: string,
    public repoPath: string,
    public cause: string,
  ) {
    super(`git ${command} in ${repoPath}: ${cause}`);
    this.name = "GitCommandError";
  }
}

export class GitService {
  private locks = new Map<string, Promise<void>>();

  private async withRepoLock(repoPath: string): Promise<() => void> {
    const prev = this.locks.get(repoPath) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(repoPath, prev.then(() => next));
    await prev;
    return release!;
  }

  private async execGit(
    args: string[],
    repoPath: string,
    timeout = 10_000,
  ): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timer);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new GitCommandError(
        `git ${args.join(" ")}`,
        repoPath,
        (stderr || stdout).trim(),
      );
    }
    return stdout.trim();
  }

  private async execGitRaw(
    args: string[],
    repoPath: string,
    timeout = 10_000,
  ): Promise<string> {
    const proc = Bun.spawn(["git", ...args], {
      cwd: repoPath,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const timer = setTimeout(() => proc.kill(), timeout);
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    clearTimeout(timer);

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new GitCommandError(
        `git ${args.join(" ")}`,
        repoPath,
        (stderr || stdout).trim(),
      );
    }
    return stdout.replace(/\r?\n$/, "");
  }

  private async safeExec(
    args: string[],
    repoPath: string,
    timeout?: number,
  ): Promise<string | null> {
    try {
      return await this.execGit(args, repoPath, timeout);
    } catch {
      return null;
    }
  }

  async run(
    args: string[],
    repoPath: string,
    timeout?: number,
  ): Promise<string> {
    return this.execGit(args, repoPath, timeout);
  }

  async runWithLock(
    args: string[],
    repoPath: string,
    timeout?: number,
  ): Promise<string> {
    const release = await this.withRepoLock(repoPath);
    try {
      return await this.execGit(args, repoPath, timeout);
    } finally {
      release();
    }
  }

  async runArgsWithLock(
    args: string[],
    repoPath: string,
    timeout = 10_000,
  ): Promise<string> {
    const release = await this.withRepoLock(repoPath);
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd: repoPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeout);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      clearTimeout(timer);

      const exitCode = await proc.exited;
      const trimmed = (stdout + stderr).trim();
      if (exitCode !== 0) {
        throw new GitCommandError(`git ${args.join(" ")}`, repoPath, trimmed);
      }
      return trimmed;
    } finally {
      release();
    }
  }

  async runWithStdinAndLock(
    args: string[],
    stdin: string,
    repoPath: string,
    timeout = 10_000,
  ): Promise<string> {
    const release = await this.withRepoLock(repoPath);
    try {
      const proc = Bun.spawn(["git", ...args], {
        cwd: repoPath,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        stdin: new Response(stdin),
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeout);
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      clearTimeout(timer);

      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        throw new GitCommandError(
          `git ${args.join(" ")}`,
          repoPath,
          (stderr || stdout).trim(),
        );
      }
      return stdout.trim();
    } finally {
      release();
    }
  }

  async getStatus(repoPath: string): Promise<GitStatusResult> {
    const rawStatus = await this.execGitRaw(
      ["status", "--porcelain", "--untracked-files=all"],
      repoPath,
    );
    const branch = await this.execGit(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      repoPath,
      5000,
    );
    const remoteOption = await this.safeExec(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      repoPath,
      5000,
    );

    let ahead = 0;
    let behind = 0;
    if (remoteOption) {
      const revList = await this.safeExec(
        ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        repoPath,
        10_000,
      );
      if (revList) {
        const parts = revList.split(/\s+/);
        if (parts.length >= 2) {
          ahead = parseInt(parts[0], 10) || 0;
          behind = parseInt(parts[1], 10) || 0;
        }
      }
    }

    const lines = rawStatus.split("\n");
    let staged = 0;
    let unstaged = 0;
    let untracked = 0;
    const stagedFiles: FileStatus[] = [];
    const unstagedFiles: FileStatus[] = [];
    const untrackedFiles: FileStatus[] = [];

    for (const l of lines) {
      if (!l) continue;
      const filePath = parsePorcelainPath(l);
      if (l.startsWith("??")) {
        untracked++;
        if (filePath) {
          untrackedFiles.push({ path: filePath, status: "??" });
        }
      } else {
        if (l[0] !== " ") {
          staged++;
          if (filePath) {
            stagedFiles.push({ path: filePath, status: l[0] + " " });
          }
        }
        if (l.length > 1 && l[1] !== " ") {
          unstaged++;
          if (filePath) {
            unstagedFiles.push({ path: filePath, status: " " + l[1] });
          }
        }
      }
    }
    const hasChanges = staged > 0 || unstaged > 0 || untracked > 0;

    let lastCommitTime: number | null = null;
    const lct = await this.safeExec(
      ["log", "-1", "--format=%ct"],
      repoPath,
      5000,
    );
    if (lct) {
      const t = parseInt(lct, 10);
      if (!isNaN(t)) lastCommitTime = t;
    }

    let weekCommits = 0;
    if (lastCommitTime && Date.now() / 1000 - lastCommitTime < 7 * 24 * 3600) {
      const raw = await this.safeExec(
        ["rev-list", "--count", "--since=1 week ago", "HEAD"],
        repoPath,
        10_000,
      );
      if (raw) weekCommits = parseInt(raw, 10) || 0;
    }

    return {
      branch,
      remote: remoteOption,
      hasChanges,
      staged,
      stagedFiles,
      unstaged,
      unstagedFiles,
      untracked,
      untrackedFiles,
      ahead,
      behind,
      lastCommitTime,
      weekCommits,
    };
  }

  async getStatusWithLock(repoPath: string): Promise<GitStatusResult> {
    const release = await this.withRepoLock(repoPath);
    try {
      return await this.getStatus(repoPath);
    } finally {
      release();
    }
  }
}

function parsePorcelainPath(line: string): string {
  if (line.length <= 2) return "";
  let start = 2;
  if (line.length > 2 && line[2] === " ") start = 3;
  let path = line.slice(start).trim();
  const idx = path.lastIndexOf(" -> ");
  if (idx >= 0) path = path.slice(idx + 4);
  return path;
}
