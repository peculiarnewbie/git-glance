import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VITE_PORT = 5173;
const SERVER_PORT = 3456;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;

let mainWindow = null;

async function checkUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

ipcMain.handle("select-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
  if (result.canceled) return null;
  return result.filePaths[0];
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: "Git Explorer",
    width: 1100,
    height: 780,
    backgroundColor: "#09090b",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  checkUrl(VITE_URL).then((viteOk) => {
    if (viteOk) {
      mainWindow.loadURL(VITE_URL);
    } else {
      checkUrl(SERVER_URL).then((serverOk) => {
        if (serverOk) {
          mainWindow.loadURL(SERVER_URL);
        } else {
          mainWindow.loadFile(path.join(__dirname, "renderer-dist", "index.html"));
        }
      });
    }
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

app.whenReady().then(createMainWindow);

app.on("window-all-closed", () => {
  app.quit();
});
