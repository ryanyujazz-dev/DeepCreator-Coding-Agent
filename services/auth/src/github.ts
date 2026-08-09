import { AuthConfig } from "./config.js";
import { GitHubIdentity } from "./types.js";

type GitHubTokenResponse = { access_token?: unknown; error?: unknown; error_description?: unknown };
type GitHubUserResponse = { avatar_url?: unknown; id?: unknown; login?: unknown; name?: unknown };

function githubAvatarUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

export function githubAuthorizationUrl(config: AuthConfig, state: string): string {
  const url = new URL(config.githubAuthorizeUrl);
  url.searchParams.set("client_id", config.githubClientId);
  url.searchParams.set("redirect_uri", `${config.publicBaseUrl}/v1/auth/github/callback`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubToken(config: AuthConfig, code: string): Promise<string> {
  const tokenResponse = await fetch(config.githubTokenUrl, {
    body: new URLSearchParams({
      client_id: config.githubClientId,
      client_secret: config.githubClientSecret,
      code,
      redirect_uri: `${config.publicBaseUrl}/v1/auth/github/callback`
    }),
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  const tokenPayload = await responseJson(tokenResponse) as GitHubTokenResponse;
  if (!tokenResponse.ok || typeof tokenPayload.access_token !== "string") {
    const detail = typeof tokenPayload.error_description === "string" ? tokenPayload.error_description : "GitHub authorization failed.";
    throw new Error(detail);
  }
  return tokenPayload.access_token;
}

export async function fetchGitHubIdentity(config: AuthConfig, token: string): Promise<GitHubIdentity> {
  const userResponse = await fetch(`${config.githubApiUrl}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "DeepCreator-Auth"
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  const user = await responseJson(userResponse) as GitHubUserResponse;
  if (!userResponse.ok || (typeof user.id !== "number" && typeof user.id !== "string") || typeof user.login !== "string") {
    throw new Error("GitHub user identity was unavailable.");
  }
  return {
    avatarUrl: githubAvatarUrl(user.avatar_url),
    displayName: typeof user.name === "string" && user.name.trim() ? user.name.trim() : user.login,
    login: user.login,
    subject: String(user.id)
  };
}

export async function revokeGitHubToken(config: AuthConfig, token: string): Promise<void> {
  const credentials = Buffer.from(`${config.githubClientId}:${config.githubClientSecret}`).toString("base64");
  const response = await fetch(`${config.githubApiUrl}/applications/${encodeURIComponent(config.githubClientId)}/token`, {
    body: JSON.stringify({ access_token: token }),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Basic ${credentials}`,
      "content-type": "application/json",
      "user-agent": "DeepCreator-Auth"
    },
    method: "DELETE",
    redirect: "error",
    signal: AbortSignal.timeout(15_000)
  });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub token revocation failed (${response.status}).`);
}
