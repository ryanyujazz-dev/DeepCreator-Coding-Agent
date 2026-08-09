import { createAuthApp } from "./app.js";
import { loadAuthConfig } from "./config.js";
import { createPool, migrate } from "./database.js";
import { AuthRepository } from "./repository.js";

const config = await loadAuthConfig();
const pool = createPool();
await migrate(pool);
const repository = new AuthRepository(pool);
const app = await createAuthApp(config, repository);
await repository.cleanupExpiredRecords();
const cleanupTimer = setInterval(() => {
  void repository.cleanupExpiredRecords().catch((error: unknown) => app.log.error({ err: error }, "Auth record cleanup failed"));
}, 6 * 60 * 60 * 1000);
cleanupTimer.unref();

const shutdown = async () => {
  clearInterval(cleanupTimer);
  await app.close();
  await repository.close();
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
