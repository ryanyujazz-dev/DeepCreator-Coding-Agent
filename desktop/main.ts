import { app, autoUpdater, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import electronSquirrelStartup from "electron-squirrel-startup";
import { realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { updateElectronApp, UpdateSourceType } from "update-electron-app";
import { AuthDeleteInput, LocalProfileInput } from "../shared/contracts/auth";
import { DesktopSettingsInput, WindowControlsState } from "../shared/contracts/desktop";
import { SkillInstallInput, SkillTargetInput } from "../shared/contracts/skill";
import { ThemeImportInput, ThemePack, ThemePreference, WindowChromeTheme } from "../shared/contracts/theme";
import { DEFAULT_THEME_ID, isHexColor } from "../shared/themeCatalog";
import { migratePreviousDesktopData } from "./brandMigration";
import { AuthManager } from "./authManager";
import { RuntimeHost } from "./runtime-host";
import { DesktopStore } from "./store";
import { importThemeFile } from "./themeImport";
import { ThemeStore } from "./themeStore";
import { SkillStore } from "./skillStore";
import { UpdateManager } from "./updateManager";
console.log("[desktop] main started");

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeHost;
let auth: AuthManager;
let store: DesktopStore;
let skills: SkillStore;
let themes: ThemeStore;
let updates: UpdateManager;
let gracefulQuit = false;

// Fully transparent so the Windows caption buttons sit directly on the menubar. An opaque overlay
// would paint a chrome block over the top-right corner and clip the floating canvas shadow there,
// making the top bar look disconnected on Windows.
const TITLEBAR_OVERLAY_COLOR = "#00000000";
const TITLEBAR_HEIGHT = 42;
const MACOS_TRAFFIC_LIGHT_DIAMETER = 12;
const MACOS_TRAFFIC_LIGHT_POSITION = {
  x: 14,
  y: (TITLEBAR_HEIGHT - MACOS_TRAFFIC_LIGHT_DIAMETER) / 2
};

if (process.platform === "win32") app.setAppUserModelId("com.squirrel.deepcreator.DeepCreator");

function trusted(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error("Untrusted desktop IPC sender.");
}

function trustedProjectRoot(projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined;
  const resolved = path.resolve(projectRoot);
  if (store.recentProjects().some((project) => project.path === resolved)) return resolved;
  try {
    const scratchRoot = realpathSync(path.join(store.activeProfileRuntimeDirectory(), "scratch-workspaces"));
    const target = realpathSync(resolved);
    if (target === scratchRoot || target.startsWith(`${scratchRoot}${path.sep}`)) return target;
  } catch {
    // Fall through to the trusted-root error.
  }
  throw new Error("只能管理最近项目或当前临时任务中的 Skill。");
}

function authenticated(): void {
  if (!auth.authenticated()) throw new Error("DeepCreator Profile 尚未准备好。");
}

function windowControlsState(): WindowControlsState {
  return {
    trafficLightsVisible: process.platform === "darwin" && !(mainWindow?.isFullScreen() ?? false)
  };
}

function registerIpc(): void {
  ipcMain.handle("desktop:updates:get-state", (event) => {
    trusted(event);
    return updates.getState();
  });
  ipcMain.handle("desktop:updates:check", (event) => {
    trusted(event);
    return updates.check();
  });
  ipcMain.handle("desktop:updates:install", (event) => {
    trusted(event);
    return updates.install();
  });
  ipcMain.handle("desktop:window-controls:get-state", (event) => {
    trusted(event);
    return windowControlsState();
  });
  ipcMain.handle("desktop:auth:get-state", (event) => { trusted(event); return auth.getState(); });
  ipcMain.handle("desktop:auth:sign-in", (event) => { trusted(event); return auth.signIn(); });
  ipcMain.handle("desktop:auth:cancel-sign-in", (event) => { trusted(event); return auth.cancelSignIn(); });
  ipcMain.handle("desktop:auth:sign-out", (event) => { trusted(event); return auth.signOut(); });
  ipcMain.handle("desktop:auth:update-local-profile", (event, input: LocalProfileInput) => {
    trusted(event);
    return auth.updateLocalProfile(input);
  });
  ipcMain.handle("desktop:auth:delete-account", (event, input: AuthDeleteInput) => {
    trusted(event);
    return auth.deleteAccount(input);
  });
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
      mainWindow?.setTitleBarOverlay({ color: TITLEBAR_OVERLAY_COLOR, height: TITLEBAR_HEIGHT, symbolColor: theme.symbolColor });
    }
  });
  ipcMain.handle("runtime:connection", (event) => { trusted(event); authenticated(); return runtime.connection(); });
  ipcMain.handle("runtime:retry", (event) => { trusted(event); authenticated(); return runtime.restart(); });
  ipcMain.handle("desktop:recent-projects", (event) => { trusted(event); authenticated(); return store.recentProjects(); });
  ipcMain.handle("desktop:activate-project", (event, projectPath: string) => {
    trusted(event);
    authenticated();
    const resolved = path.resolve(projectPath);
    if (!store.recentProjects().some((project) => project.path === resolved)) throw new Error("只能激活最近项目列表中的目录。");
    store.addProject(resolved);
    return store.recentProjects();
  });
  ipcMain.handle("desktop:pin-project", (event, projectPath: string, pinned: boolean) => {
    trusted(event);
    authenticated();
    return store.pinProject(projectPath, Boolean(pinned));
  });
  ipcMain.handle("desktop:rename-project", (event, projectPath: string, name: string) => {
    trusted(event);
    authenticated();
    return store.renameProject(projectPath, name);
  });
  ipcMain.handle("desktop:remove-project", (event, projectPath: string) => {
    trusted(event);
    authenticated();
    return store.removeProject(projectPath);
  });
  ipcMain.handle("desktop:open-project", async (event, projectPath: string) => {
    trusted(event);
    authenticated();
    const resolved = path.resolve(projectPath);
    if (!store.recentProjects().some((project) => project.path === resolved)) throw new Error("只能打开最近项目列表中的目录。");
    const error = await shell.openPath(resolved);
    if (error) throw new Error(error);
  });
  ipcMain.handle("desktop:pick-project", async (event) => {
    trusted(event);
    authenticated();
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "createDirectory"], title: "选择项目文件夹" });
    return result.canceled || !result.filePaths[0] ? null : store.addProject(result.filePaths[0]);
  });
  ipcMain.handle("desktop:settings:read", (event) => { trusted(event); authenticated(); return store.settings(); });
  ipcMain.handle("desktop:settings:save", async (event, input: DesktopSettingsInput) => {
    trusted(event);
    authenticated();
    const settings = store.saveSettings(input);
    try {
      const connection = await runtime.restart();
      return { connection, settings };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`配置已保存，但 Runtime 重新启动失败：${detail}`);
    }
  });
  ipcMain.handle("desktop:skills:list", (event, projectRoot?: string) => {
    trusted(event);
    authenticated();
    return skills.list(trustedProjectRoot(projectRoot));
  });
  ipcMain.handle("desktop:skills:preview-local", async (event) => {
    trusted(event);
    authenticated();
    const result = await dialog.showOpenDialog(mainWindow!, {
      filters: [{ extensions: ["deepcreator-skill", "zip"], name: "DeepCreator Skill" }],
      properties: ["openFile", "openDirectory"],
      title: "选择 Skill 文件夹或安装包"
    });
    return result.canceled || !result.filePaths[0] ? null : skills.previewLocal(result.filePaths[0]);
  });
  ipcMain.handle("desktop:skills:preview-github", (event, url: string) => {
    trusted(event);
    authenticated();
    return skills.previewGitHub(String(url));
  });
  ipcMain.handle("desktop:skills:install", async (event, input: SkillInstallInput) => {
    trusted(event);
    authenticated();
    const normalized = { ...input, projectRoot: trustedProjectRoot(input.projectRoot) };
    const result = skills.install(normalized);
    await runtime.restart();
    return result;
  });
  ipcMain.handle("desktop:skills:set-enabled", async (event, input: SkillTargetInput & { enabled: boolean }) => {
    trusted(event);
    authenticated();
    const result = skills.setEnabled({ ...input, projectRoot: trustedProjectRoot(input.projectRoot) });
    await runtime.restart();
    return result;
  });
  ipcMain.handle("desktop:skills:remove", async (event, input: SkillTargetInput) => {
    trusted(event);
    authenticated();
    const result = await skills.remove({ ...input, projectRoot: trustedProjectRoot(input.projectRoot) });
    await runtime.restart();
    return result;
  });
  ipcMain.handle("desktop:skills:check-updates", (event, projectRoot?: string) => {
    trusted(event);
    authenticated();
    return skills.checkUpdates(trustedProjectRoot(projectRoot));
  });
  ipcMain.handle("desktop:skills:update", (event, input: SkillTargetInput) => {
    trusted(event);
    authenticated();
    return skills.update({ ...input, projectRoot: trustedProjectRoot(input.projectRoot) });
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
      defaultPath: `${theme.name.replace(/[\\/:*?"<>|]/g, "-")}.deepcreator-theme.json`,
      filters: [{ extensions: ["json"], name: "DeepCreator 主题" }],
      title: "导出主题"
    });
    if (result.canceled || !result.filePath) return false;
    writeFileSync(result.filePath, `${JSON.stringify(theme, null, 2)}\n`, "utf8");
    return true;
  });
  ipcMain.handle("desktop:reveal", (event, filePath: string) => {
    trusted(event);
    authenticated();
    const resolved = path.resolve(filePath);
    if (!store.recentProjects().some((project) => resolved === project.path || resolved.startsWith(`${project.path}${path.sep}`))) {
      throw new Error("只能显示最近项目中的文件。");
    }
    shell.showItemInFolder(resolved);
  });
  ipcMain.handle("desktop:open-external", (event, rawUrl: string) => {
    trusted(event);
    authenticated();
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
    title: "DeepCreator",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION
        }
      : {
          titleBarOverlay: {
            color: TITLEBAR_OVERLAY_COLOR,
            height: TITLEBAR_HEIGHT,
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
  if (process.platform === "darwin") {
    const publishWindowControlsState = () => {
      window.webContents.send("window-controls:state", {
        trafficLightsVisible: !window.isFullScreen()
      });
    };
    window.on("enter-full-screen", publishWindowControlsState);
    window.on("leave-full-screen", publishWindowControlsState);
  }
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

if (process.platform === "win32" && electronSquirrelStartup) app.quit();
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });
  app.whenReady().then(async () => {
    console.log("[desktop] app ready");
    migratePreviousDesktopData();
    store = new DesktopStore();
    themes = new ThemeStore();
    skills = new SkillStore({
      appVersion: app.getVersion(),
      builtinDirectory: app.isPackaged ? path.join(process.resourcesPath, "skills") : path.join(app.getAppPath(), "skills"),
      globalDirectory: path.join(app.getPath("home"), ".deepcreator", "skills"),
      previewDirectory: path.join(app.getPath("userData"), "skill-previews"),
      registryFile: path.join(app.getPath("home"), ".deepcreator", "skill-registry.json"),
      trash: (target) => shell.trashItem(target)
    });
    runtime = new RuntimeHost(store, MAIN_WINDOW_VITE_DEV_SERVER_URL ?? "file://");
    auth = new AuthManager({
      onAuthenticated: () => runtime.start().then(() => undefined),
      onSignedOut: () => runtime.stop(),
      store
    });
    updates = new UpdateManager({
      configure: () => updateElectronApp({
        logger: {
          error: (...messages: unknown[]) => console.error("[desktop:update]", ...messages),
          info: (...messages: unknown[]) => console.info("[desktop:update]", ...messages),
          log: (...messages: unknown[]) => console.log("[desktop:update]", ...messages),
          warn: (...messages: unknown[]) => console.warn("[desktop:update]", ...messages)
        },
        notifyUser: false,
        updateInterval: "6 hours",
        updateSource: {
          host: __DEEPCREATOR_UPDATE_HOST__,
          repo: __DEEPCREATOR_UPDATE_REPOSITORY__,
          type: UpdateSourceType.ElectronPublicUpdateService
        }
      }),
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      prepareToInstall: async () => {
        gracefulQuit = true;
        try {
          await runtime.stop();
        } catch (error) {
          gracefulQuit = false;
          throw error;
        }
      },
      updater: {
        checkForUpdates: () => autoUpdater.checkForUpdates(),
        onAvailable: (listener) => { autoUpdater.on("update-available", listener); },
        onChecking: (listener) => { autoUpdater.on("checking-for-update", listener); },
        onDownloaded: (listener) => {
          autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName, releaseDate) => {
            listener({ releaseDate, releaseName, releaseNotes });
          });
        },
        onError: (listener) => { autoUpdater.on("error", listener); },
        onNotAvailable: (listener) => { autoUpdater.on("update-not-available", listener); },
        quitAndInstall: () => autoUpdater.quitAndInstall()
      }
    });
    registerIpc();
    mainWindow = createWindow();
    auth.onState((state) => mainWindow?.webContents.send("auth:state", state));
    runtime.onState((state) => mainWindow?.webContents.send("runtime:state", state));
    updates.onState((state) => mainWindow?.webContents.send("updates:state", state));
    updates.initialize();
    await auth.initialize().catch((error) => console.error("[desktop] auth initialization failed", error));
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow(); });
  });
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", (event) => {
    if (gracefulQuit || !runtime) return;
    event.preventDefault();
    gracefulQuit = true;
    void runtime.stop().finally(() => app.quit());
  });
  app.on("will-quit", () => updates?.dispose());
}
