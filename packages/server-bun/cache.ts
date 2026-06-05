import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import type { GitRepo, PersistedConfig } from "./types";

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
      return JSON.parse(raw) as GitRepo[];
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
