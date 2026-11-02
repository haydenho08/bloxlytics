// Postgres reports errors with a five-character SQLSTATE; the first two characters
// are the class. Only these classes mean "this data can never be stored":
//   22 data exception (a value out of range, bad JSON)
//   23 integrity constraint violation (a game that doesn't exist, a failed CHECK)
// Retrying those gives the same answer forever, so the event goes to the dead
// letter stream.
//
// Everything else is treated as transient: connection refused, timeouts,
// deadlocks (40P01), a database restarting (57P01), even "column does not exist"
// (42703, a migration we forgot to run). Those get fixed by waiting or by us, and
// throwing the events away would turn an outage into data loss. When in doubt,
// keep the data and retry.
const PERMANENT_SQLSTATE_CLASSES = new Set(["22", "23"]);

export function isPermanentDbError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.length === 5 && PERMANENT_SQLSTATE_CLASSES.has(code.slice(0, 2));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
