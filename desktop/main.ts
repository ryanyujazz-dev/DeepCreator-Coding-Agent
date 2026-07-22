import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import dotenv from "dotenv";
import { DesktopSettingsInput } from "../shared/contracts/desktop";
import { RuntimeHost } from "./runtime-host";
import { DesktopStore } from "./store";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
console.log("[desktop] main started");

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeHost;
let store: DesktopStore;
let gracefulQuit = false;

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Untrusted desktop IPC sender.");
}

function registerIpc(): void {
  ipcMain.handle("runtime:connection", (event) => { trusted(event); return runtime.connection(); });
  ipcMain.handle("runtime:retry", (event) => { trusted(event); return runtime.restart(); });
  ipcMain.handle("desktop:recent-projects", (event) => { trusted(event); return store.recentProjects(); });
  ipcMain.handle("desktop:activate-project", (event, projectPath: string) => {
    trusted(event);
    const resolved = path.resolve(projectPath);
    if (!store.recentProjects().some((project) => project.path === resolved)) throw new Error("只能激活最近项目列表中的目录。");
    store.addProject(resolved);
    return store.recentProjects();
  });
  ipcMain.handle("desktop:pin-project", (event, projectPath: string, pinned: boolean) => {
    trusted(event);
    return store.pinProject(projectPath, Boolean(pinned));
  });
  ipcMain.handle("desktop:rename-project", (event, projectPath: string, name: string) => {
    trusted(event);
    return store.renameProject(projectPath, name);
  });
  ipcMain.handle("desktop:remove-project", (event, projectPath: string) => {
    trusted(event);
    return store.removeProject(projectPath);
  });
  ipcMain.handle("desktop:open-project", async (event, projectPath: string) => {
    trusted(event);
    const resolved = path.resolve(projectPath);
    if (!store.recentProjects().some((project) => project.path === resolved)) throw new Error("只能打开最近项目列表中的目录。");
    const error = await shell.openPath(resolved);
    if (error) throw new Error(error);
  });
  ipcMain.handle("desktop:pick-project", async (event) => {
    trusted(event);
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"], title: "选择项目文件夹" });
    return result.canceled || !result.filePaths[0] ? null : store.addProject(result.filePaths[0]);
  });
  ipcMain.handle("desktop:settings:read", (event) => { trusted(event); return store.settings(); });
  ipcMain.handle("desktop:settings:save", async (event, input: DesktopSettingsInput) => {
    trusted(event);
    const settings = store.saveSettings(input);
    await runtime.restart();
    return settings;
  });
  ipcMain.handle("desktop:reveal", (event, filePath: string) => {
    trusted(event);
    const resolved = path.resolve(filePath);
    if (!store.recentProjects().some((project) => resolved === project.path || resolved.startsWith(`${project.path}${path.sep}`))) {
      throw new Error("只能显示最近项目中的文件。");
    }
    shell.showItemInFolder(resolved);
  });
  ipcMain.handle("desktop:open-external", (event, rawUrl: string) => {
    trusted(event);
    const url = new URL(rawUrl);
    if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("只允许打开 HTTP 或 HTTPS 链接。");
    return shell.openExternal(url.toString());
  });
}

function createWindow(): BrowserWindow {
  const bounds = store.windowBounds();
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: "#f2f4f5",
    height: bounds?.height ?? 900,
    minHeight: 620,
    minWidth: 940,
    show: false,
    title: "DeepSeeker",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {
          titleBarOverlay: { color: "#f2f4f5", height: 42, symbolColor: "#5f6a70" },
          titleBarStyle: "hidden" as const
        }),
    width: bounds?.width ?? 1440,
    x: bounds?.x,
    y: bounds?.y,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true
    }
  });
  if (process.platform !== "darwin") window.removeMenu();
  window.once("ready-to-show", () => window.show());
  window.on("close", () => store.saveWindowBounds(window.getBounds()));
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL ? url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL) : url.startsWith("file://");
    if (!allowed) event.preventDefault();
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) void window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else void window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  return window;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    console.log("[desktop] app ready");
    store = new DesktopStore();
    runtime = new RuntimeHost(store, MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "file://");
    registerIpc();
    mainWindow = createWindow();
    runtime.onState((state) => mainWindow?.webContents.send("runtime:state", state));
    await runtime.start().catch(() => undefined);
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (gracefulQuit || !runtime) return;
    event.preventDefault();
    gracefulQuit = true;
    void runtime.stop().finally(() => app.quit());
  });
}
