import {
  ThemeImportInput,
  ThemePack,
  ThemePreference,
  ThemeSummary,
  WindowChromeTheme
} from "./theme";

export type RuntimePhase = "starting" | "ready" | "restarting" | "stopped" | "failed";

export type RuntimeConnection = {
  baseUrl: string;
  phase: RuntimePhase;
  token: string;
};

export type RuntimeState = {
  detail?: string;
  phase: RuntimePhase;
};

export type ProjectRef = {
  lastOpenedAt: string;
  name: string;
  path: string;
  pinned?: boolean;
};

export type DesktopSettings = {
  defaultModel: string;
  hasApiKey: boolean;
  hasZhipuApiKey: boolean;
};

export type DesktopSettingsInput = {
  apiKey?: string;
  defaultModel: string;
  zhipuApiKey?: string;
};

export type DesktopBridge = {
  appearance: {
    applyChrome: (theme: WindowChromeTheme) => Promise<void>;
    read: () => Promise<ThemePreference>;
    save: (preference: ThemePreference) => Promise<ThemePreference>;
  };
  files: {
    openExternal: (url: string) => Promise<void>;
    reveal: (filePath: string) => Promise<void>;
  };
  projects: {
    activate: (projectPath: string) => Promise<ProjectRef[]>;
    open: (projectPath: string) => Promise<void>;
    pick: () => Promise<ProjectRef | null>;
    pin: (projectPath: string, pinned: boolean) => Promise<ProjectRef[]>;
    recent: () => Promise<ProjectRef[]>;
    remove: (projectPath: string) => Promise<ProjectRef[]>;
    rename: (projectPath: string, name: string) => Promise<ProjectRef[]>;
  };
  runtime: {
    connection: () => Promise<RuntimeConnection>;
    onState: (listener: (state: RuntimeState) => void) => () => void;
    retry: () => Promise<RuntimeConnection>;
  };
  settings: {
    read: () => Promise<DesktopSettings>;
    save: (input: DesktopSettingsInput) => Promise<DesktopSettings>;
  };
  themes: {
    exportFile: (themeId: string) => Promise<boolean>;
    get: (themeId: string) => Promise<ThemePack | null>;
    importFile: (input: ThemeImportInput) => Promise<ThemePack | null>;
    list: () => Promise<ThemeSummary[]>;
    remove: (themeId: string) => Promise<ThemeSummary[]>;
    save: (theme: ThemePack) => Promise<ThemePack>;
  };
};
