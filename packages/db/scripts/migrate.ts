import { createPool, runMigrations } from "../src/index.ts";

const url = process.argv[2] ?? process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (see .env.example) or pass a connection string.");
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const applied = await runMigrations(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Already up to date.");
} finally {
  await pool.end();
}
