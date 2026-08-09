export type AuthPhase =
  | "checking"
  | "signed_out"
  | "authorizing"
  | "signed_in"
  | "offline"
  | "expired"
  | "error";

export type AuthMode = "github" | "local";

export type LocalProfileAvatar = "amber" | "blue" | "green" | "slate";

export type LocalProfileInput = {
  avatar: LocalProfileAvatar;
  displayName: string;
};

export type AuthUser = {
  avatar?: LocalProfileAvatar;
  avatarUrl?: string;
  displayName: string;
  githubLogin: string;
  id: string;
};

export type AuthLoginAttempt = {
  expiresAt: string;
  provider: "github";
};

export type AuthState = {
  attempt?: AuthLoginAttempt;
  detail?: string;
  mode: AuthMode;
  offlineUntil?: string;
  phase: AuthPhase;
  profileSetupRequired?: boolean;
  user?: AuthUser;
};

export type AuthDeleteInput = {
  confirmation: "DELETE";
};
