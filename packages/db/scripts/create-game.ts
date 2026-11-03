import { GAME_ID_PATTERN } from "@bloxlytics/shared";
import { createGame, createPool } from "../src/index.ts";

const [gameId, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(" ") || gameId;

if (!gameId || !name || !GAME_ID_PATTERN.test(gameId)) {
  console.error('Usage: npm run create-game -- <game-id> ["Display name"]');
  console.error("game-id: lowercase letters, digits, - and _, e.g. my-obby");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("Set DATABASE_URL (see .env.example).");
  process.exit(1);
}

const pool = createPool(url, 1);
try {
  const { apiKey } = await createGame(pool, gameId, name);
  console.log(`Created game "${gameId}".`);
  console.log(`API key (shown once, only its hash is stored):\n\n  ${apiKey}\n`);
} finally {
  await pool.end();
}
