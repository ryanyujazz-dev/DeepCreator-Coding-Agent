import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { importJWK, importPKCS8, jwtVerify } from "jose";
import { Pool } from "pg";
import { createAuthApp } from "../services/auth/src/app";
import { AuthConfig } from "../services/auth/src/config";
import { migrate } from "../services/auth/src/database";
import { AuthRepository } from "../services/auth/src/repository";
import { accessToken, hashSecret, offlineGrant, publicJwk, randomSecret } from "../services/auth/src/security";

async function config(overrides: Partial<AuthConfig> = {}): Promise<AuthConfig> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privatePem = String(privateKey.export({ format: "pem", type: "pkcs8" }));
  const publicKeyJwk = publicKey.export({ format: "jwk" });
  return {
    audience: "deepcreator-desktop",
    githubApiUrl: "http://127.0.0.1:1",
    githubAuthorizeUrl: "https://github.com/login/oauth/authorize",
    githubClientId: "test-client",
    githubClientSecret: "test-secret",
    githubTokenUrl: "http://127.0.0.1:1/token",
    host: "127.0.0.1",
    issuer: "https://auth.deepcreator.test",
    keyId: "test-key",
    port: 0,
    privateKey: await importPKCS8(privatePem, "EdDSA"),
    privateKeyObject: privateKey,
    publicBaseUrl: "https://auth.deepcreator.test",
    publicJwk: publicKeyJwk,
    publicKey: await importJWK(publicKeyJwk, "EdDSA"),
    tokenPepper: "test-pepper-with-more-than-thirty-two-bytes",
    trustProxy: false,
    ...overrides
  };
}

test("hashes opaque secrets deterministically without storing the input", () => {
  const secret = randomSecret();
  const hash = hashSecret(secret, "pepper");
  assert.equal(hash.length, 64);
  assert.equal(hash, hashSecret(secret, "pepper"));
  assert.notEqual(hash, hashSecret(secret, "other-pepper"));
  assert.ok(!hash.includes(secret));
});

test("signs distinct access and offline grants with the published Ed25519 key", async () => {
  const authConfig = await config();
  const user = { displayName: "Mona", githubLogin: "octocat", id: randomUUID() };
  const sessionId = randomUUID();
  const expiresAt = new Date(Date.now() + 60_000);
  const published = await publicJwk(authConfig);
  const verifier = await importJWK(published, "EdDSA");
  const access = await accessToken(authConfig, user, sessionId, randomUUID(), expiresAt);
  const offline = await offlineGrant(authConfig, user, sessionId, randomUUID(), expiresAt);
  assert.equal((await jwtVerify(access, verifier)).payload.typ, "access");
  assert.equal((await jwtVerify(offline, verifier)).payload.typ, "offline");
  assert.equal("d" in published, false);
});

test("revokes a temporary GitHub token when public identity lookup fails", async () => {
  let revocations = 0;
  const github = createServer((request, response) => {
    if (request.url === "/login/oauth/access_token") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "temporary-provider-token" }));
      return;
    }
    if (request.url === "/user") {
      response.statusCode = 503;
      response.end("unavailable");
      return;
    }
    if (request.method === "DELETE" && request.url?.includes("/applications/")) {
      revocations += 1;
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  const address = github.address();
  assert.ok(address && typeof address === "object");
  const githubBase = `http://127.0.0.1:${address.port}`;
  const authConfig = await config({ githubApiUrl: githubBase, githubTokenUrl: `${githubBase}/login/oauth/access_token` });
  const repository = {
    completeGitHubLogin: async () => "completed" as const,
    failGitHubLogin: async () => undefined
  } as unknown as AuthRepository;
  let app: Awaited<ReturnType<typeof createAuthApp>> | undefined;
  try {
    app = await createAuthApp(authConfig, repository);
    const response = await app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?state=${"s".repeat(43)}&code=test-code`
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-security-policy"] || "", /default-src 'none'/);
    for (let attempt = 0; attempt < 20 && revocations === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(revocations, 1);
  } finally {
    await app?.close();
    github.closeAllConnections();
    await new Promise<void>((resolve, reject) => github.close((error) => error ? reject(error) : resolve()));
  }
});

test("records a denied GitHub authorization without accepting extra callback data", async () => {
  let failureReason = "";
  const authConfig = await config();
  const repository = {
    failGitHubLogin: async (_stateHash: string, reason: string) => { failureReason = reason; }
  } as unknown as AuthRepository;
  const app = await createAuthApp(authConfig, repository);
  try {
    const response = await app.inject({
      method: "GET",
      url: `/v1/auth/github/callback?state=${"s".repeat(43)}&error=access_denied&error_description=cancelled&error_uri=https%3A%2F%2Fgithub.com`
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.headers["content-type"] || "", /text\/html/);
    assert.equal(failureReason, "access_denied");
  } finally {
    await app.close();
  }
});

const databaseUrl = process.env.AUTH_TEST_DATABASE_URL;

test("completes GitHub login once and detects refresh-token replay", { skip: !databaseUrl }, async () => {
  const github = createServer((request, response) => {
    if (request.url === "/login/oauth/access_token") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ access_token: "github-temporary-token" }));
      return;
    }
    if (request.url === "/user") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ avatar_url: "https://avatars.githubusercontent.com/u/1", id: 1, login: "octocat", name: "Mona Lisa" }));
      return;
    }
    if (request.method === "DELETE" && request.url?.includes("/applications/")) {
      response.statusCode = 204;
      response.end();
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => github.listen(0, "127.0.0.1", resolve));
  const address = github.address();
  assert.ok(address && typeof address === "object");
  const githubBase = `http://127.0.0.1:${address.port}`;
  const pool = new Pool({ connectionString: databaseUrl, ssl: false });
  await migrate(pool);
  await pool.query("TRUNCATE auth_audit_events, session_refresh_tokens, sessions, login_attempts, identities, users RESTART IDENTITY CASCADE");
  const repository = new AuthRepository(pool);
  const authConfig = await config({
    githubApiUrl: githubBase,
    githubTokenUrl: `${githubBase}/login/oauth/access_token`
  });
  const app = await createAuthApp(authConfig, repository);
  try {
    const deviceId = randomUUID();
    const started = await app.inject({
      method: "POST",
      payload: { appVersion: "0.1.0", deviceId, platform: "darwin" },
      url: "/v1/auth/attempts"
    });
    assert.equal(started.statusCode, 201);
    const attempt = started.json<{ attemptId: string; authorizeUrl: string; pollToken: string }>();
    const state = new URL(attempt.authorizeUrl).searchParams.get("state");
    assert.ok(state);
    const callback = await app.inject({ method: "GET", url: `/v1/auth/github/callback?code=test-code&state=${encodeURIComponent(state)}` });
    assert.equal(callback.statusCode, 200);

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", payload: { pollToken: attempt.pollToken }, url: `/v1/auth/attempts/${attempt.attemptId}/exchange` }),
      app.inject({ method: "POST", payload: { pollToken: attempt.pollToken }, url: `/v1/auth/attempts/${attempt.attemptId}/exchange` })
    ]);
    assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 409]);
    const sessionResponse = first.statusCode === 200 ? first : second;
    const session = sessionResponse.json<{ accessToken: string; refreshToken: string; user: { githubLogin: string } }>();
    assert.equal(session.user.githubLogin, "octocat");

    const refreshed = await app.inject({
      method: "POST",
      payload: { deviceId, refreshToken: session.refreshToken },
      url: "/v1/auth/sessions/refresh"
    });
    assert.equal(refreshed.statusCode, 200);
    const replayed = await app.inject({
      method: "POST",
      payload: { deviceId, refreshToken: session.refreshToken },
      url: "/v1/auth/sessions/refresh"
    });
    assert.equal(replayed.statusCode, 401);
  } finally {
    await app.close();
    await repository.close();
    await new Promise<void>((resolve, reject) => github.close((error) => error ? reject(error) : resolve()));
  }
});
