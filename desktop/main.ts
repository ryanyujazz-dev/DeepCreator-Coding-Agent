import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { DesktopSettingsInput } from "../shared/contracts/desktop";
import { ThemeImportInput, ThemePack, ThemePreference, WindowChromeTheme } from "../shared/contracts/theme";
import { DEFAULT_THEME_ID, isHexColor } from "../shared/themeCatalog";
import { RuntimeHost } from "./runtime-host";
import { DesktopStore } from "./store";
import { importThemeFile } from "./themeImport";
import { ThemeStore } from "./themeStore";
import { ensureUserConfig } from "../server/infra/userConfig";

// ADR-009: 普通配置统一从 ~/.deepseeker/config.json 读取；密钥由宿主边界解析。
ensureUserConfig();
console.log("[desktop] main started");

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeHost;
let store: DesktopStore;
let themes: ThemeStore;
let gracefulQuit = false;

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Untrusted desktop IPC sender.");
}

function registerIpc(): void {
  ipcMain.handle("desktop:appearance:read", (event) => { trusted(event); return store.appearance(); });
  ipcMain.handle("desktop:appearance:save", (event, preference: ThemePreference) => {
    trusted(event);
    if (!themes.get(preference.themeId)) throw new Error("所选主题不存在。");
    if (preference.codeThemeId && !themes.get(preference.codeThemeId)) throw new Error("所选代码主题不存在。");
    return store.saveAppearance(preference);
  });
  ipcMain.handle("desktop:appearance:apply-chrome", (event, theme: WindowChromeTheme) => {
    trusted(event);
    if (!isHexColor(theme.backgroundColor) || !isHexColor(theme.symbolColor)) throw new Error("窗口主题颜色无效。");
    nativeTheme.themeSource = theme.mode;
    mainWindow?.setBackgroundColor(theme.backgroundColor);
    if (process.platform === "darwin") {
      mainWindow?.setVibrancy(theme.translucentSidebar ? "sidebar" : null);
    } else if (process.platform === "win32") {
      mainWindow?.setBackgroundMaterial(theme.translucentSidebar ? "mica" : "none");
      mainWindow?.setTitleBarOverlay({ color: theme.backgroundColor, height: 42, symbolColor: theme.symbolColor });
    }
  });
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
    const connection = await runtime.restart();
    return { connection, settings };
  });
  ipcMain.handle("desktop:themes:list", (event) => {
    trusted(event);
    return themes.all().map(({ id, name, readonly, source }) => ({ id, name, readonly, source }));
  });
  ipcMain.handle("desktop:themes:get", (event, themeId: string) => {
    trusted(event);
    return themes.get(themeId) ?? null;
  });
  ipcMain.handle("desktop:themes:save", (event, theme: ThemePack) => {
    trusted(event);
    return themes.save(theme);
  });
  ipcMain.handle("desktop:themes:remove", (event, themeId: string) => {
    trusted(event);
    themes.remove(themeId);
    const preference = store.appearance();
    if (preference.themeId === themeId || preference.codeThemeId === themeId) {
      store.saveAppearance({
        codeThemeId: preference.codeThemeId === themeId ? undefined : preference.codeThemeId,
        mode: preference.mode,
        themeId: preference.themeId === themeId ? DEFAULT_THEME_ID : preference.themeId
      });
    }
    return themes.all().map(({ id, name, readonly, source }) => ({ id, name, readonly, source }));
  });
  ipcMain.handle("desktop:themes:import", async (event, input: ThemeImportInput) => {
    trusted(event);
    const result = await dialog.showOpenDialog(mainWindow!, {
      filters: [{ extensions: ["json", "jsonc"], name: "主题文件" }],
      properties: ["openFile"],
      title: "导入主题"
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const base = themes.get(input.baseThemeId);
    if (!base) throw new Error("导入主题所需的基础主题不存在。");
    return importThemeFile(result.filePaths[0], base, input.target);
  });
  ipcMain.handle("desktop:themes:export", async (event, themeId: string) => {
    trusted(event);
    const theme = themes.get(themeId);
    if (!theme) throw new Error("主题不存在。");
    const result = await dialog.showSaveDialog(mainWindow!, {
      defaultPath: `${theme.name.replace(/[\\/:*?"<>|]/g, "-")}.deepseeker-theme.json`,
      filters: [{ extensions: ["json"], name: "DeepSeeker 主题" }],
      title: "导出主题"
    });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, `${JSON.stringify(theme, null, 2)}\n`, "utf8");
    return true;
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
  const appearance = store.appearance();
  nativeTheme.themeSource = appearance.mode;
  const startupTheme = themes.get(appearance.themeId) ?? themes.get(DEFAULT_THEME_ID)!;
  const startupVariant = startupTheme.variants[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: startupVariant.colors.sidebar,
    height: bounds?.height ?? 900,
    minHeight: 620,
    minWidth: 420,
    show: false,
    title: "DeepSeeker",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : {
          titleBarOverlay: {
            color: startupVariant.colors.sidebar,
            height: 42,
            symbolColor: startupVariant.colors.muted
          },
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
  if (process.platform === "darwin" && startupVariant.translucentSidebar) window.setVibrancy("sidebar");
  if (process.platform === "win32" && startupVariant.translucentSidebar) window.setBackgroundMaterial("mica");
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
    themes = new ThemeStore();
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
