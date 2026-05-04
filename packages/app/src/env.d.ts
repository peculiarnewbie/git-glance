interface ElectronAPI {
  selectDirectory: () => Promise<string | null>;
  getCache: () => Promise<{ repos: Record<string, any> }>;
  getSavedDir: () => Promise<string | null>;
  saveDir: (dir: string) => Promise<void>;
  startScan: (dirPath: string) => void;
  cancelScan: () => void;
  onScanProgress: (callback: (data: any) => void) => () => void;
}

interface Window {
  electronAPI: ElectronAPI;
}
