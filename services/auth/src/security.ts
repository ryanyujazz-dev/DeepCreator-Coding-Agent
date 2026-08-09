import { createHmac, randomBytes } from "node:crypto";
import { JWK, SignJWT } from "jose";
import { AuthUser } from "../../../shared/contracts/auth.js";
import { AuthConfig } from "./config.js";

export const ACCESS_TTL_SECONDS = 15 * 60;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const LOGIN_ATTEMPT_TTL_SECONDS = 10 * 60;

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

async function signedToken(
  config: AuthConfig,
  user: AuthUser,
  sessionId: string,
  deviceId: string,
  type: "access" | "offline",
  expiresAt: Date
): Promise<string> {
  return new SignJWT({ deviceId, githubLogin: user.githubLogin, name: user.displayName, sid: sessionId, typ: type })
    .setProtectedHeader({ alg: "EdDSA", kid: config.keyId, typ: "JWT" })
    .setAudience(config.audience)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .setIssuedAt()
    .setIssuer(config.issuer)
    .setSubject(user.id)
    .sign(config.privateKey);
}

export function accessToken(config: AuthConfig, user: AuthUser, sessionId: string, deviceId: string, expiresAt: Date): Promise<string> {
  return signedToken(config, user, sessionId, deviceId, "access", expiresAt);
}

export function offlineGrant(config: AuthConfig, user: AuthUser, sessionId: string, deviceId: string, expiresAt: Date): Promise<string> {
  return signedToken(config, user, sessionId, deviceId, "offline", expiresAt);
}

export async function publicJwk(config: AuthConfig): Promise<JWK> {
  return { ...config.publicJwk, alg: "EdDSA", kid: config.keyId, use: "sig" };
}
