import pg from "pg";

export * from "./apiKeys.ts";
export * from "./migrate.ts";

export type { Pool } from "pg";

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
