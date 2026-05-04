const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  selectDirectory: () => ipcRenderer.invoke("select-directory"),
  getCache: () => ipcRenderer.invoke("get-cache"),
  getSavedDir: () => ipcRenderer.invoke("get-saved-dir"),
  saveDir: (dir) => ipcRenderer.invoke("save-dir", dir),
  startScan: (dirPath) => ipcRenderer.send("start-scan", dirPath),
  cancelScan: () => ipcRenderer.send("cancel-scan"),
  onScanProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on("scan-progress", handler);
    return () => ipcRenderer.removeListener("scan-progress", handler);
  },
});
