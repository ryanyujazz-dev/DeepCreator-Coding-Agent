import { Pool, PoolClient } from "pg";
import { AuthUser } from "../../../shared/contracts/auth.js";
import { GitHubIdentity, LoginAttemptRecord, SessionMaterial, SessionRecord } from "./types.js";

type LoginAttemptInput = {
  appVersion: string;
  deviceId: string;
  expiresAt: Date;
  id: string;
  oauthStateHash: string;
  platform: string;
  pollSecretHash: string;
};

function userFromRow(row: Record<string, unknown>): AuthUser {
  return {
    avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : undefined,
    displayName: String(row.display_name),
    githubLogin: String(row.github_login),
    id: String(row.id)
  };
}

export class AuthRepository {
  constructor(readonly pool: Pool) {}

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createLoginAttempt(input: LoginAttemptInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO login_attempts
        (id, poll_secret_hash, oauth_state_hash, device_id, app_version, platform, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
      [input.id, input.pollSecretHash, input.oauthStateHash, input.deviceId, input.appVersion, input.platform, input.expiresAt]
    );
  }

  async completeGitHubLogin(oauthStateHash: string, identity: GitHubIdentity): Promise<"completed" | "expired" | "missing"> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await client.query<{ expires_at: Date; id: string; status: string }>(
        "SELECT id, status, expires_at FROM login_attempts WHERE oauth_state_hash = $1 FOR UPDATE",
        [oauthStateHash]
      );
      const row = attempt.rows[0];
      if (!row || row.status !== "pending") {
        await client.query("ROLLBACK");
        return "missing";
      }
      if (row.expires_at.getTime() <= Date.now()) {
        await client.query("UPDATE login_attempts SET status = 'expired' WHERE id = $1", [row.id]);
        await client.query("COMMIT");
        return "expired";
      }
      const user = await this.upsertGitHubUser(client, identity);
      await client.query(
        "UPDATE login_attempts SET status = 'completed', user_id = $2, completed_at = NOW() WHERE id = $1",
        [row.id, user.id]
      );
      await this.audit(client, user.id, "login.github_authorized", { login: identity.login });
      await client.query("COMMIT");
      return "completed";
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async failGitHubLogin(oauthStateHash: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE login_attempts SET status = 'failed', failure_reason = $2
       WHERE oauth_state_hash = $1 AND status = 'pending'`,
      [oauthStateHash, reason.slice(0, 80)]
    );
  }

  async inspectAttempt(id: string, pollSecretHash: string): Promise<LoginAttemptRecord | undefined> {
    const result = await this.pool.query<{ device_id: string; expires_at: Date; id: string; status: LoginAttemptRecord["status"]; user_id?: string }>(
      `SELECT id, device_id, status, expires_at, user_id FROM login_attempts
       WHERE id = $1 AND poll_secret_hash = $2`,
      [id, pollSecretHash]
    );
    const row = result.rows[0];
    return row ? { deviceId: row.device_id, expiresAt: row.expires_at, id: row.id, status: row.status, userId: row.user_id } : undefined;
  }

  async cancelAttempt(id: string, pollSecretHash: string): Promise<void> {
    await this.pool.query(
      "UPDATE login_attempts SET status = 'failed', failure_reason = 'cancelled' WHERE id = $1 AND poll_secret_hash = $2 AND status = 'pending'",
      [id, pollSecretHash]
    );
  }

  async consumeAttemptAndCreateSession(id: string, pollSecretHash: string, material: SessionMaterial): Promise<AuthUser | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const attempt = await client.query<Record<string, unknown>>(
        `SELECT la.status, la.expires_at, u.id, u.display_name, i.provider_login AS github_login, u.avatar_url
         FROM login_attempts la
         JOIN users u ON u.id = la.user_id AND u.status = 'active'
         JOIN identities i ON i.user_id = u.id AND i.provider = 'github'
         WHERE la.id = $1 AND la.poll_secret_hash = $2
         FOR UPDATE OF la`,
        [id, pollSecretHash]
      );
      const row = attempt.rows[0];
      if (!row || row.status !== "completed" || (row.expires_at as Date).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return undefined;
      }
      await client.query(
        `INSERT INTO sessions (id, user_id, device_id, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [material.id, row.id, material.deviceId, material.expiresAt]
      );
      await client.query(
        `INSERT INTO session_refresh_tokens (id, session_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [material.refreshTokenId, material.id, material.refreshTokenHash, material.expiresAt]
      );
      await client.query("UPDATE login_attempts SET status = 'consumed', consumed_at = NOW() WHERE id = $1", [id]);
      await this.audit(client, String(row.id), "session.created", { deviceId: material.deviceId, sessionId: material.id });
      await client.query("COMMIT");
      return userFromRow(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateRefreshToken(tokenHash: string, next: SessionMaterial): Promise<SessionRecord | "reused" | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Record<string, unknown>>(
        `SELECT rt.id AS refresh_id, rt.used_at, rt.expires_at AS refresh_expires_at,
                s.id, s.revoked_at, s.expires_at, s.device_id,
                u.id AS user_id, u.display_name, u.avatar_url,
                i.provider_login AS github_login
         FROM session_refresh_tokens rt
         JOIN sessions s ON s.id = rt.session_id
         JOIN users u ON u.id = s.user_id AND u.status = 'active'
         JOIN identities i ON i.user_id = u.id AND i.provider = 'github'
         WHERE rt.token_hash = $1
         FOR UPDATE OF rt, s`,
        [tokenHash]
      );
      const row = result.rows[0];
      if (!row || row.revoked_at || (row.refresh_expires_at as Date).getTime() <= Date.now()) {
        await client.query("ROLLBACK");
        return undefined;
      }
      if (String(row.device_id) !== next.deviceId) {
        await client.query("ROLLBACK");
        return undefined;
      }
      if (row.used_at) {
        await client.query("UPDATE sessions SET revoked_at = NOW(), revoke_reason = 'refresh_reuse' WHERE id = $1", [row.id]);
        await this.audit(client, String(row.user_id), "session.refresh_reuse", { sessionId: row.id });
        await client.query("COMMIT");
        return "reused";
      }
      await client.query("UPDATE session_refresh_tokens SET used_at = NOW() WHERE id = $1", [row.refresh_id]);
      await client.query(
        "INSERT INTO session_refresh_tokens (id, session_id, token_hash, expires_at) VALUES ($1, $2, $3, $4)",
        [next.refreshTokenId, row.id, next.refreshTokenHash, next.expiresAt]
      );
      await client.query("UPDATE sessions SET last_used_at = NOW(), expires_at = $2 WHERE id = $1", [row.id, next.expiresAt]);
      await client.query("COMMIT");
      return {
        deviceId: String(row.device_id),
        expiresAt: next.expiresAt,
        id: String(row.id),
        revokedAt: undefined,
        user: {
          avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : undefined,
          displayName: String(row.display_name),
          githubLogin: String(row.github_login),
          id: String(row.user_id)
        }
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async userForSession(userId: string, sessionId: string): Promise<AuthUser | undefined> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT u.id, u.display_name, u.avatar_url, i.provider_login AS github_login
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.status = 'active'
       JOIN identities i ON i.user_id = u.id AND i.provider = 'github'
       WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > NOW()`,
      [sessionId, userId]
    );
    return result.rows[0] ? userFromRow(result.rows[0]) : undefined;
  }

  async revokeByRefreshToken(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE sessions SET revoked_at = NOW(), revoke_reason = 'logout'
       WHERE id IN (SELECT session_id FROM session_refresh_tokens WHERE token_hash = $1)`,
      [tokenHash]
    );
  }

  async deleteAccount(userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.audit(client, userId, "account.deleted", {});
      await client.query("DELETE FROM users WHERE id = $1", [userId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async cleanupExpiredRecords(): Promise<void> {
    await this.pool.query(
      `DELETE FROM login_attempts
       WHERE created_at < NOW() - INTERVAL '24 hours'
          OR expires_at < NOW() - INTERVAL '24 hours'`
    );
    await this.pool.query(
      `DELETE FROM sessions
       WHERE expires_at < NOW() - INTERVAL '7 days'
          OR revoked_at < NOW() - INTERVAL '7 days'`
    );
    await this.pool.query("DELETE FROM auth_audit_events WHERE created_at < NOW() - INTERVAL '90 days'");
  }

  private async upsertGitHubUser(client: PoolClient, identity: GitHubIdentity): Promise<AuthUser> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identity.subject]);
    const existing = await client.query<{ user_id: string }>(
      "SELECT user_id FROM identities WHERE provider = 'github' AND provider_subject = $1",
      [identity.subject]
    );
    let userId = existing.rows[0]?.user_id;
    if (!userId) {
      const created = await client.query<{ id: string }>(
        "INSERT INTO users (display_name, avatar_url) VALUES ($1, $2) RETURNING id",
        [identity.displayName, identity.avatarUrl ?? null]
      );
      userId = created.rows[0].id;
      await client.query(
        `INSERT INTO identities (user_id, provider, provider_subject, provider_login)
         VALUES ($1, 'github', $2, $3)`,
        [userId, identity.subject, identity.login]
      );
    } else {
      await client.query("UPDATE users SET display_name = $2, avatar_url = $3, updated_at = NOW() WHERE id = $1", [userId, identity.displayName, identity.avatarUrl ?? null]);
      await client.query("UPDATE identities SET provider_login = $2, updated_at = NOW() WHERE user_id = $1 AND provider = 'github'", [userId, identity.login]);
    }
    return { avatarUrl: identity.avatarUrl, displayName: identity.displayName, githubLogin: identity.login, id: userId };
  }

  private async audit(client: PoolClient, userId: string | undefined, action: string, metadata: Record<string, unknown>): Promise<void> {
    await client.query(
      "INSERT INTO auth_audit_events (user_id, action, metadata) VALUES ($1, $2, $3::jsonb)",
      [userId ?? null, action, JSON.stringify(metadata)]
    );
  }
}
