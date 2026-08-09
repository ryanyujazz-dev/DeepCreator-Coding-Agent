import { createPool, migrate } from "./database.js";

const pool = createPool();
try {
  await migrate(pool);
  console.log("DeepCreator auth migrations are current.");
} finally {
  await pool.end();
}
