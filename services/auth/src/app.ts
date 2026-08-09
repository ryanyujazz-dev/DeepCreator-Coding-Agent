import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { FastifyInstance, FastifyReply, FastifyRequest, LogController } from "fastify";
import { randomUUID } from "node:crypto";
import { jwtVerify, JWTPayload } from "jose";
import { AuthUser } from "../../../shared/contracts/auth.js";
import { AuthConfig } from "./config.js";
import { exchangeGitHubToken, fetchGitHubIdentity, githubAuthorizationUrl, revokeGitHubToken } from "./github.js";
import { AuthRepository } from "./repository.js";
import {
  ACCESS_TTL_SECONDS,
  accessToken,
  hashSecret,
  LOGIN_ATTEMPT_TTL_SECONDS,
  offlineGrant,
  publicJwk,
  randomSecret,
  SESSION_TTL_SECONDS
} from "./security.js";
import { SessionMaterial, TokenBundle } from "./types.js";

type AuthenticatedRequest = FastifyRequest & { auth: { sessionId: string; user: AuthUser } };

const uuidPattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const genericAuthError = "Authentication could not be completed.";

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function callbackPage(success: boolean): string {
  const title = success ? "授权已完成" : "授权未完成";
  const detail = success ? "你可以关闭此页面并返回 DeepCreator。" : "请返回 DeepCreator 后重试。";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f7f8f8;color:#182026;font:16px/1.6 sans-serif}main{max-width:520px;margin:18vh auto;padding:32px}h1{font-size:24px;margin:0 0 8px}p{color:#66727a}</style></head><body><main><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

async function tokenBundle(
  config: AuthConfig,
  user: AuthUser,
  sessionId: string,
  deviceId: string,
  refreshToken: string,
  sessionExpiresAt: Date
): Promise<TokenBundle> {
  const accessExpiresAt = expiresIn(ACCESS_TTL_SECONDS);
  return {
    accessExpiresAt: accessExpiresAt.toISOString(),
    accessToken: await accessToken(config, user, sessionId, deviceId, accessExpiresAt),
    offlineGrant: await offlineGrant(config, user, sessionId, deviceId, sessionExpiresAt),
    offlineUntil: sessionExpiresAt.toISOString(),
    refreshExpiresAt: sessionExpiresAt.toISOString(),
    refreshToken,
    user
  };
}

function sessionMaterial(config: AuthConfig, deviceId: string, refreshToken: string, id = randomUUID()): SessionMaterial {
  return {
    deviceId,
    expiresAt: expiresIn(SESSION_TTL_SECONDS),
    id,
    refreshTokenHash: hashSecret(refreshToken, config.tokenPepper),
    refreshTokenId: randomUUID()
  };
}

async function authenticate(config: AuthConfig, repository: AuthRepository, request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    await reply.code(401).send({ error: genericAuthError });
    return;
  }
  try {
    const result = await jwtVerify(authorization.slice(7), config.publicKey, {
      audience: config.audience,
      issuer: config.issuer
    });
    const payload: JWTPayload = result.payload;
    if (payload.typ !== "access" || typeof payload.sub !== "string" || typeof payload.sid !== "string") throw new Error("Invalid token claims.");
    const user = await repository.userForSession(payload.sub, payload.sid);
    if (!user) throw new Error("Inactive session.");
    (request as AuthenticatedRequest).auth = { sessionId: payload.sid, user };
  } catch {
    await reply.code(401).send({ error: genericAuthError });
  }
}

export async function createAuthApp(config: AuthConfig, repository: AuthRepository): Promise<FastifyInstance> {
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      redact: ["req.headers.authorization", "req.body.code", "req.body.pollToken", "req.body.refreshToken"]
    },
    trustProxy: config.trustProxy
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        baseUri: ["'none'"],
        defaultSrc: ["'none'"],
        formAction: ["'none'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"]
      }
    }
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/")) {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    }
    return payload;
  });

  app.get("/healthz", async () => {
    await repository.pool.query("SELECT 1");
    return { status: "ok" };
  });

  app.get("/.well-known/jwks.json", async () => ({ keys: [await publicJwk(config)] }));

  app.post<{ Body: { appVersion: string; deviceId: string; platform: string } }>("/v1/auth/attempts", {
    config: { rateLimit: { max: 10, timeWindow: "15 minutes" } },
    schema: {
      body: {
        additionalProperties: false,
        properties: {
          appVersion: { maxLength: 64, minLength: 1, type: "string" },
          deviceId: { pattern: uuidPattern, type: "string" },
          platform: { enum: ["darwin", "win32", "linux", "development"], type: "string" }
        },
        required: ["appVersion", "deviceId", "platform"],
        type: "object"
      }
    }
  }, async (request, reply) => {
    const id = randomUUID();
    const pollToken = randomSecret();
    const oauthState = randomSecret();
    const expiresAt = expiresIn(LOGIN_ATTEMPT_TTL_SECONDS);
    await repository.createLoginAttempt({
      appVersion: request.body.appVersion,
      deviceId: request.body.deviceId,
      expiresAt,
      id,
      oauthStateHash: hashSecret(oauthState, config.tokenPepper),
      platform: request.body.platform,
      pollSecretHash: hashSecret(pollToken, config.tokenPepper)
    });
    return reply.code(201).send({
      attemptId: id,
      authorizeUrl: githubAuthorizationUrl(config, oauthState),
      expiresAt: expiresAt.toISOString(),
      pollAfterMs: 2_000,
      pollToken
    });
  });

  app.get<{ Querystring: { code?: string; error?: string; state?: string } }>("/v1/auth/github/callback", {
    schema: {
      querystring: {
        additionalProperties: false,
        properties: {
          code: { maxLength: 512, type: "string" },
          error: { maxLength: 128, type: "string" },
          error_description: { maxLength: 512, type: "string" },
          error_uri: { maxLength: 512, type: "string" },
          state: { maxLength: 128, minLength: 32, type: "string" }
        },
        type: "object"
      }
    }
  }, async (request, reply) => {
    const state = request.query.state;
    if (!state) return reply.code(400).type("text/html; charset=utf-8").send(callbackPage(false));
    const stateHash = hashSecret(state, config.tokenPepper);
    if (request.query.error || !request.query.code) {
      await repository.failGitHubLogin(stateHash, request.query.error || "missing_code");
      return reply.code(400).type("text/html; charset=utf-8").send(callbackPage(false));
    }
    let providerToken: string | undefined;
    try {
      providerToken = await exchangeGitHubToken(config, request.query.code);
      const identity = await fetchGitHubIdentity(config, providerToken);
      const status = await repository.completeGitHubLogin(stateHash, identity);
      if (status !== "completed") return reply.code(400).type("text/html; charset=utf-8").send(callbackPage(false));
      return reply.type("text/html; charset=utf-8").send(callbackPage(true));
    } catch (error) {
      request.log.warn({ err: error }, "GitHub callback failed");
      await repository.failGitHubLogin(stateHash, "provider_error");
      return reply.code(400).type("text/html; charset=utf-8").send(callbackPage(false));
    } finally {
      if (providerToken) {
        await revokeGitHubToken(config, providerToken).catch((error: unknown) => request.log.error({ err: error }, "GitHub token revocation failed"));
      }
    }
  });

  app.post<{ Body: { pollToken: string }; Params: { id: string } }>("/v1/auth/attempts/:id/exchange", {
    schema: {
      body: { additionalProperties: false, properties: { pollToken: { maxLength: 128, minLength: 32, type: "string" } }, required: ["pollToken"], type: "object" },
      params: { additionalProperties: false, properties: { id: { pattern: uuidPattern, type: "string" } }, required: ["id"], type: "object" }
    }
  }, async (request, reply) => {
    const pollHash = hashSecret(request.body.pollToken, config.tokenPepper);
    const attempt = await repository.inspectAttempt(request.params.id, pollHash);
    if (!attempt) return reply.code(401).send({ error: genericAuthError });
    if (attempt.expiresAt.getTime() <= Date.now() || attempt.status === "expired") return reply.code(410).send({ status: "expired" });
    if (attempt.status === "pending") return reply.code(202).send({ pollAfterMs: 2_000, status: "pending" });
    if (attempt.status !== "completed") return reply.code(409).send({ status: attempt.status });
    const refreshToken = randomSecret(48);
    const material = sessionMaterial(config, attempt.deviceId, refreshToken);
    const user = await repository.consumeAttemptAndCreateSession(request.params.id, pollHash, material);
    if (!user) return reply.code(409).send({ status: "consumed" });
    return tokenBundle(config, user, material.id, material.deviceId, refreshToken, material.expiresAt);
  });

  app.delete<{ Body: { pollToken: string }; Params: { id: string } }>("/v1/auth/attempts/:id", {
    schema: {
      body: { additionalProperties: false, properties: { pollToken: { maxLength: 128, minLength: 32, type: "string" } }, required: ["pollToken"], type: "object" },
      params: { additionalProperties: false, properties: { id: { pattern: uuidPattern, type: "string" } }, required: ["id"], type: "object" }
    }
  }, async (request, reply) => {
    await repository.cancelAttempt(request.params.id, hashSecret(request.body.pollToken, config.tokenPepper));
    return reply.code(204).send();
  });

  app.post<{ Body: { deviceId: string; refreshToken: string } }>("/v1/auth/sessions/refresh", {
    config: { rateLimit: { max: 30, timeWindow: "15 minutes" } },
    schema: {
      body: {
        additionalProperties: false,
        properties: {
          deviceId: { pattern: uuidPattern, type: "string" },
          refreshToken: { maxLength: 256, minLength: 48, type: "string" }
        },
        required: ["deviceId", "refreshToken"],
        type: "object"
      }
    }
  }, async (request, reply) => {
    const refreshToken = randomSecret(48);
    const next = sessionMaterial(config, request.body.deviceId, refreshToken);
    const session = await repository.rotateRefreshToken(hashSecret(request.body.refreshToken, config.tokenPepper), next);
    if (!session || session === "reused") return reply.code(401).send({ error: genericAuthError });
    return tokenBundle(config, session.user, session.id, session.deviceId, refreshToken, next.expiresAt);
  });

  app.post<{ Body: { refreshToken: string } }>("/v1/auth/sessions/logout", {
    schema: {
      body: {
        additionalProperties: false,
        properties: { refreshToken: { maxLength: 256, minLength: 48, type: "string" } },
        required: ["refreshToken"],
        type: "object"
      }
    }
  }, async (request, reply) => {
    await repository.revokeByRefreshToken(hashSecret(request.body.refreshToken, config.tokenPepper));
    return reply.code(204).send();
  });

  app.get("/v1/account", { preHandler: (request, reply) => authenticate(config, repository, request, reply) }, async (request) => {
    return { user: (request as AuthenticatedRequest).auth.user };
  });

  app.delete("/v1/account", { preHandler: (request, reply) => authenticate(config, repository, request, reply) }, async (request, reply) => {
    await repository.deleteAccount((request as AuthenticatedRequest).auth.user.id);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.warn({ err: error }, "Auth request failed");
    const details = error && typeof error === "object" ? error as { message?: unknown; statusCode?: unknown; validation?: unknown } : {};
    if (details.validation) return reply.code(400).send({ error: "Invalid request." });
    const statusCode = typeof details.statusCode === "number" && details.statusCode < 500 ? details.statusCode : 500;
    const message = statusCode < 500 && typeof details.message === "string" ? details.message : "The authentication service is unavailable.";
    return reply.code(statusCode).send({ error: message });
  });

  return app;
}
