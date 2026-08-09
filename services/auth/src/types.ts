import { AuthUser } from "../../../shared/contracts/auth.js";

export type LoginAttemptStatus = "pending" | "completed" | "failed" | "consumed" | "expired";

export type LoginAttemptRecord = {
  deviceId: string;
  expiresAt: Date;
  id: string;
  status: LoginAttemptStatus;
  userId?: string;
};

export type GitHubIdentity = {
  avatarUrl?: string;
  displayName: string;
  login: string;
  subject: string;
};

export type SessionMaterial = {
  deviceId: string;
  expiresAt: Date;
  id: string;
  refreshTokenHash: string;
  refreshTokenId: string;
};

export type SessionRecord = {
  deviceId: string;
  expiresAt: Date;
  id: string;
  revokedAt?: Date;
  user: AuthUser;
};

export type TokenBundle = {
  accessExpiresAt: string;
  accessToken: string;
  offlineGrant: string;
  offlineUntil: string;
  refreshExpiresAt: string;
  refreshToken: string;
  user: AuthUser;
};
