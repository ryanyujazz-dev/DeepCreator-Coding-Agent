import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

export function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required.");
  const max = Number(process.env.DATABASE_POOL_SIZE || 10);
  if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("DATABASE_POOL_SIZE must be an integer between 1 and 100.");
  return new Pool({
    connectionString,
    max,
    ssl: process.env.DATABASE_SSL === "disable" ? false : { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false" }
  });
}

export async function migrate(pool: Pool): Promise<void> {
  const current = path.dirname(fileURLToPath(import.meta.url));
  const migrationDirectory = path.resolve(current, "../migrations");
  const files = (await readdir(migrationDirectory)).filter((file) => /^\d+_[a-z0-9_-]+\.sql$/.test(file)).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(736829101)");
    await client.query(
      `CREATE TABLE IF NOT EXISTS deepcreator_auth_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`
    );
    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM deepcreator_auth_migrations WHERE version = $1", [file]);
      if (existing.rowCount) continue;
      const sql = await readFile(path.join(migrationDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO deepcreator_auth_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(736829101)").catch(() => undefined);
    client.release();
  }
}
