export type AppUpdatePhase =
  | "unsupported"
  | "idle"
  | "checking"
  | "downloading"
  | "current"
  | "ready"
  | "installing"
  | "error";

export type AppUpdateState = {
  availableVersion?: string;
  checkedAt?: string;
  currentVersion: string;
  detail?: string;
  phase: AppUpdatePhase;
  releaseDate?: string;
  releaseNotes?: string;
  supported: boolean;
};
