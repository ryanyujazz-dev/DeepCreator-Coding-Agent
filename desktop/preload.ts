import { contextBridge, ipcRenderer } from "electron";
import { DesktopBridge, DesktopSettingsInput, RuntimeState } from "../shared/contracts/desktop";

const bridge: DesktopBridge = {
  appearance: {
    applyChrome: (theme) => ipcRenderer.invoke("desktop:appearance:apply-chrome", theme),
    read: () => ipcRenderer.invoke("desktop:appearance:read"),
    save: (preference) => ipcRenderer.invoke("desktop:appearance:save", preference)
  },
  files: {
    openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
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
  themes: {
    exportFile: (themeId) => ipcRenderer.invoke("desktop:themes:export", themeId),
    get: (themeId) => ipcRenderer.invoke("desktop:themes:get", themeId),
    importFile: (input) => ipcRenderer.invoke("desktop:themes:import", input),
    list: () => ipcRenderer.invoke("desktop:themes:list"),
    remove: (themeId) => ipcRenderer.invoke("desktop:themes:remove", themeId),
    save: (theme) => ipcRenderer.invoke("desktop:themes:save", theme)
  }
};

contextBridge.exposeInMainWorld("deepcreator", bridge);
