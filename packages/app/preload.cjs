const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  getCache: () => ipcRenderer.invoke("get-cache"),
  getSavedDir: () => ipcRenderer.invoke("get-saved-dir"),
  saveDir: (dir) => ipcRenderer.invoke("save-dir", dir),
  startScan: (dirPath) => ipcRenderer.send("start-scan", dirPath),
  cancelScan: () => ipcRenderer.send("cancel-scan"),
  pullRepo: (repoPath) => ipcRenderer.invoke("pull-repo", repoPath),
  pushRepo: (repoPath) => ipcRenderer.invoke("push-repo", repoPath),
  getConfig: () => ipcRenderer.invoke("get-config"),
  setConfig: (config) => ipcRenderer.invoke("set-config", config),
  startCommitAndPush: (repoPath) => ipcRenderer.send("commit-and-push", repoPath),
  cancelCommit: () => ipcRenderer.send("cancel-commit"),
  onCommitProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("commit-progress", handler);
    return () => ipcRenderer.removeListener("commit-progress", handler);
  },
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("scan-progress", handler);
    return () => ipcRenderer.removeListener("scan-progress", handler);
  },
});
