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
};

export type DesktopSettingsInput = {
  apiKey?: string;
  defaultModel: string;
};

export type DesktopBridge = {
  files: {
    openExternal: (url: string) => Promise<void>;
    reveal: (filePath: string) => Promise<void>;
  };
  projects: {
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
};
