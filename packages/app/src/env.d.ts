interface ElectronAPI {
  selectDirectory: () => Promise<string | null>;
  getCache: () => Promise<{ repos: Record<string, any> }>;
  getSavedDir: () => Promise<string | null>;
  saveDir: (dir: string) => Promise<void>;
  startScan: (dirPath: string) => void;
  cancelScan: () => void;
  pullRepo: (repoPath: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
  pushRepo: (repoPath: string) => Promise<{ ok: boolean; output?: string; error?: string }>;
  onScanProgress: (callback: (data: any) => void) => () => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
