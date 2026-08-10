import { contextBridge, ipcRenderer } from "electron";
import { AuthState } from "../shared/contracts/auth";
import {
  DesktopBridge,
  DesktopSettingsInput,
  RuntimeState,
  WindowControlsState
} from "../shared/contracts/desktop";
import { AppUpdateState } from "../shared/contracts/update";

const bridge: DesktopBridge = {
  platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
  auth: {
    cancelSignIn: () => ipcRenderer.invoke("desktop:auth:cancel-sign-in"),
    deleteAccount: (input) => ipcRenderer.invoke("desktop:auth:delete-account", input),
    getState: () => ipcRenderer.invoke("desktop:auth:get-state"),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AuthState) => listener(state);
      ipcRenderer.on("auth:state", handler);
      return () => ipcRenderer.removeListener("auth:state", handler);
    },
    signIn: () => ipcRenderer.invoke("desktop:auth:sign-in"),
    signOut: () => ipcRenderer.invoke("desktop:auth:sign-out"),
    updateLocalProfile: (input) => ipcRenderer.invoke("desktop:auth:update-local-profile", input)
  },
  appearance: {
    applyChrome: (theme) => ipcRenderer.invoke("desktop:appearance:apply-chrome", theme),
    read: () => ipcRenderer.invoke("desktop:appearance:read"),
    save: (preference) => ipcRenderer.invoke("desktop:appearance:save", preference)
  },
  files: {
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
    openPath: (filePath) => ipcRenderer.invoke("desktop:open-path", filePath),
    reveal: (filePath) => ipcRenderer.invoke("desktop:reveal", filePath)
  },
  projects: {
    activate: (projectPath) => ipcRenderer.invoke("desktop:activate-project", projectPath),
    open: (projectPath) => ipcRenderer.invoke("desktop:open-project", projectPath),
    pick: () => ipcRenderer.invoke("desktop:pick-project"),
    pin: (projectPath, pinned) => ipcRenderer.invoke("desktop:pin-project", projectPath, pinned),
    recent: () => ipcRenderer.invoke("desktop:recent-projects"),
    remove: (projectPath) => ipcRenderer.invoke("desktop:remove-project", projectPath),
    rename: (projectPath, name) => ipcRenderer.invoke("desktop:rename-project", projectPath, name)
  },
  runtime: {
    connection: () => ipcRenderer.invoke("runtime:connection"),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RuntimeState) => listener(state);
      ipcRenderer.on("runtime:state", handler);
      return () => ipcRenderer.removeListener("runtime:state", handler);
    },
    retry: () => ipcRenderer.invoke("runtime:retry")
  },
  settings: {
    read: () => ipcRenderer.invoke("desktop:settings:read"),
    save: (input: DesktopSettingsInput) => ipcRenderer.invoke("desktop:settings:save", input)
  },
  skills: {
    checkUpdates: (projectRoot) => ipcRenderer.invoke("desktop:skills:check-updates", projectRoot),
    install: (input) => ipcRenderer.invoke("desktop:skills:install", input),
    list: (projectRoot) => ipcRenderer.invoke("desktop:skills:list", projectRoot),
    previewGitHub: (url) => ipcRenderer.invoke("desktop:skills:preview-github", url),
    previewLocal: () => ipcRenderer.invoke("desktop:skills:preview-local"),
    remove: (input) => ipcRenderer.invoke("desktop:skills:remove", input),
    setEnabled: (input) => ipcRenderer.invoke("desktop:skills:set-enabled", input),
    update: (input) => ipcRenderer.invoke("desktop:skills:update", input)
  },
  themes: {
    exportFile: (themeId) => ipcRenderer.invoke("desktop:themes:export", themeId),
    get: (themeId) => ipcRenderer.invoke("desktop:themes:get", themeId),
    importFile: (input) => ipcRenderer.invoke("desktop:themes:import", input),
    list: () => ipcRenderer.invoke("desktop:themes:list"),
    remove: (themeId) => ipcRenderer.invoke("desktop:themes:remove", themeId),
    save: (theme) => ipcRenderer.invoke("desktop:themes:save", theme)
  },
  updates: {
    check: () => ipcRenderer.invoke("desktop:updates:check"),
    getState: () => ipcRenderer.invoke("desktop:updates:get-state"),
    install: () => ipcRenderer.invoke("desktop:updates:install"),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => listener(state);
      ipcRenderer.on("updates:state", handler);
      return () => ipcRenderer.removeListener("updates:state", handler);
    }
  },
  windowControls: {
    getState: () => ipcRenderer.invoke("desktop:window-controls:get-state"),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: WindowControlsState) => listener(state);
      ipcRenderer.on("window-controls:state", handler);
      return () => ipcRenderer.removeListener("window-controls:state", handler);
    }
  }
};

contextBridge.exposeInMainWorld("deepcreator", bridge);
