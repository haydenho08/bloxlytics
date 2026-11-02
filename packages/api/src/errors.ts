/**
 * Postgres or Redis failed. This isn't the client's fault and is usually
 * temporary, so it becomes a 503 + Retry-After (the SDK retries those) instead
 * of a 500.
 */
export class DependencyUnavailableError extends Error {
  constructor(
    readonly dependency: "redis" | "postgres",
    cause: unknown,
  ) {
    super(`${dependency} unavailable`, { cause });
  }
}

export async function withDependency<T>(
  dependency: "redis" | "postgres",
  work: Promise<T>,
): Promise<T> {
  try {
    return await work;
  } catch (err) {
    throw new DependencyUnavailableError(dependency, err);
  }
}
