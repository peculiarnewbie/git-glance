import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { GitRepo, PersistedConfig } from "./types";

const snakeToCamel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function normalizeRepo(raw: Record<string, unknown>): GitRepo {
  const r: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    r[snakeToCamel(key)] = raw[key];
  }
  if (r.settings && typeof r.settings === "object" && !Array.isArray(r.settings)) {
    const s: Record<string, unknown> = {};
    for (const key of Object.keys(r.settings as Record<string, unknown>)) {
      s[snakeToCamel(key)] = (r.settings as Record<string, unknown>)[key];
    }
    r.settings = s;
  }
  // Normalize nested arrays of objects (e.g. stagedFiles, unstagedFiles, untrackedFiles)
  for (const arrKey of ["stagedFiles", "unstagedFiles", "untrackedFiles"]) {
    if (Array.isArray(r[arrKey])) {
      (r[arrKey] as Record<string, unknown>[]) = (r[arrKey] as Record<string, unknown>[]).map(
        (item) => {
          const n: Record<string, unknown> = {};
          for (const k of Object.keys(item)) n[snakeToCamel(k)] = item[k];
          return n;
        },
      );
    }
  }
  return r as unknown as GitRepo;
}

export class CacheService {
  private cachePath: string;
  private configPath: string;
  private cacheDir: string;
  private configDir: string;
  private remoteRepos = new Map<string, GitRepo[]>();
  private scannedDirs: string[] = [];

  constructor(cachePath: string, configPath: string) {
    this.cachePath = cachePath;
    this.configPath = configPath;
    this.cacheDir = dirname(cachePath);
    this.configDir = dirname(configPath);
  }

  load(): GitRepo[] {
    try {
      if (!existsSync(this.cachePath)) return [];
      const raw = readFileSync(this.cachePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>[];
      return parsed.map(normalizeRepo);
    } catch {
      return [];
    }
  }

  save(repos: GitRepo[]): void {
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(repos));
  }

  loadConfig(): PersistedConfig {
    try {
      if (!existsSync(this.configPath)) return {};
      const raw = readFileSync(this.configPath, "utf-8");
      return JSON.parse(raw) as PersistedConfig;
    } catch {
      return {};
    }
  }

  saveConfig(cfg: PersistedConfig): void {
    mkdirSync(this.configDir, { recursive: true });
    writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
  }

  getScannedDirs(): string[] {
    return [...this.scannedDirs];
  }

  addScannedDir(dir: string): void {
    if (!this.scannedDirs.includes(dir)) {
      this.scannedDirs.push(dir);
    }
  }

  setRemoteRepos(machine: string, repos: GitRepo[]): void {
    this.remoteRepos.set(machine, repos);
  }

  clearRemoteRepos(machine: string): void {
    this.remoteRepos.delete(machine);
  }

  getAllRepos(): GitRepo[] {
    const local = this.load();
    const all = [...local];
    for (const repos of this.remoteRepos.values()) {
      all.push(...repos);
    }
    return all;
  }
}
