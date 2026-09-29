/**
 * Deterministic randomness and summary statistics for the System One
 * benchmark (T12495). Every random choice (negative sampling, the owner
 * spot-check sample) goes through a seeded generator so a dataset can be
 * rebuilt byte for byte.
 *
 * @task T12495
 * @epic T12486
 */

/** Default seed: the task number, so an unseeded run is still reproducible. */
export const DEFAULT_BENCH_SEED = 12495;

/** A seeded generator of floats in [0, 1). */
export type BenchRandom = () => number;

/**
 * Mulberry32: a small, fast, seeded PRNG (not cryptographic).
 *
 * @param seed - 32-bit seed.
 * @returns A generator of floats in [0, 1).
 */
export function createSeededRandom(seed: number): BenchRandom {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle into a new array.
 *
 * @param items - Items to shuffle.
 * @param random - Seeded generator.
 * @returns A shuffled copy.
 */
export function shuffled<T>(items: readonly T[], random: BenchRandom): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    const other = out[j];
    if (tmp === undefined || other === undefined) continue;
    out[i] = other;
    out[j] = tmp;
  }
  return out;
}

/**
 * The `p`-th percentile (nearest-rank) of `values`.
 *
 * @param values - Samples.
 * @param p - Percentile in [0, 100].
 * @returns The percentile, or `null` when there are no samples.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? null;
}

/** Mean and spread of one metric across repeated runs. */
export interface BenchSpread {
  /** Runs that produced a value. */
  readonly n: number;
  /** Arithmetic mean. */
  readonly mean: number | null;
  /** Sample standard deviation (0 for a single run). */
  readonly stddev: number | null;
  /** Smallest value. */
  readonly min: number | null;
  /** Largest value. */
  readonly max: number | null;
}

/**
 * Mean, sample standard deviation, min and max of the non-null values.
 *
 * @param values - One value per run; `null` means the run produced none.
 * @returns The spread.
 */
export function spreadOf(values: readonly (number | null)[]): BenchSpread {
  const xs = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (xs.length === 0) return { n: 0, mean: null, stddev: null, min: null, max: null };
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const variance =
    xs.length > 1 ? xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1) : 0;
  return {
    n: xs.length,
    mean,
    stddev: Math.sqrt(variance),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}
