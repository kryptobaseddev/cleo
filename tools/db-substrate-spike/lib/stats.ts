/**
 * Latency-statistics helpers for the SG-DB-SUBSTRATE-V2 spike benchmarks.
 *
 * Deliberately dependency-free (no perf libraries) so every harness produces
 * reproducible, auditable percentile numbers from a raw sample array. All
 * inputs are millisecond samples captured via `performance.now()` deltas.
 *
 * @task T11244
 * @saga T11242
 */

/** A summary of a latency sample set, all values in milliseconds. */
export interface LatencyStats {
  /** Number of samples. */
  count: number;
  /** Minimum observed latency (ms). */
  min: number;
  /** Maximum observed latency (ms). */
  max: number;
  /** Arithmetic mean (ms). */
  mean: number;
  /** 50th percentile (ms). */
  p50: number;
  /** 95th percentile (ms). */
  p95: number;
  /** 99th percentile (ms). */
  p99: number;
  /** 99.9th percentile (ms). */
  p999: number;
}

/**
 * Compute the value at the given percentile from a *sorted-ascending* sample
 * array using the nearest-rank method.
 *
 * @param sorted - Samples sorted ascending.
 * @param p - Percentile in the inclusive range [0, 100].
 * @returns The sample value at that percentile, or `0` for an empty array.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[idx] ?? 0;
}

/**
 * Summarize a raw millisecond-latency sample array into {@link LatencyStats}.
 *
 * @param samples - Unsorted latency samples in milliseconds.
 * @returns The computed {@link LatencyStats}.
 */
export function summarize(samples: readonly number[]): LatencyStats {
  const count = samples.length;
  if (count === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0, p999: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    count,
    min: sorted[0] ?? 0,
    max: sorted[count - 1] ?? 0,
    mean: sum / count,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    p999: percentile(sorted, 99.9),
  };
}

/**
 * Round a number to a fixed number of decimal places for stable JSON output.
 *
 * @param n - The value to round.
 * @param places - Decimal places (default 3).
 * @returns The rounded value.
 */
export function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/**
 * Format {@link LatencyStats} as a compact one-line histogram string for logs.
 *
 * @param label - A short label for the line.
 * @param s - The stats to format.
 * @returns A single formatted line (no trailing newline).
 */
export function formatStats(label: string, s: LatencyStats): string {
  return (
    `${label}: n=${s.count} min=${round(s.min)} p50=${round(s.p50)} ` +
    `p95=${round(s.p95)} p99=${round(s.p99)} p99.9=${round(s.p999)} ` +
    `max=${round(s.max)} mean=${round(s.mean)} (ms)`
  );
}
