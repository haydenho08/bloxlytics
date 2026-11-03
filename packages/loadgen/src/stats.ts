/** Nearest-rank percentile (p in 0..100) of unsorted samples. NaN if there are none. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

/** What happened during one measurement window. */
export class Window {
  readonly startedAt = Date.now();
  /** Milliseconds from sending a request to its response, for accepted (202) requests. */
  readonly latencies: number[] = [];
  accepted = 0;
  requests = 0;
  rateLimited = 0;
  overloaded = 0;
  failed = 0;

  record(status: number, events: number, ms: number): void {
    this.requests++;
    if (status === 202) {
      this.accepted += events;
      this.latencies.push(ms);
    } else if (status === 429) this.rateLimited++;
    else if (status === 503) this.overloaded++;
    else this.failed++;
  }

  seconds(now = Date.now()): number {
    return (now - this.startedAt) / 1000;
  }
}
