/**
 * Request budget for decision providers — a token bucket shared by every CLEO
 * process on the machine.
 *
 * The provider allows 600 requests/minute per key. Every CLEO process (CLI
 * invocations, the sentient daemon, spawned agents) draws from ONE bucket whose
 * state lives in `<cleoHome>/decide/budget.json`, guarded by a `proper-lockfile`
 * lock — the same cross-process state-file pattern as
 * `llm/rate-limit-guard.ts`, with much shorter lock retries because a decision
 * has a sub-second budget.
 *
 * ## Why capacity 60 + 540/min, not 600 + 600/min
 *
 * A bucket of capacity `C` refilled at `r` admits at most `C + r·W` requests in
 * any window `W`. The defaults (60 + 540/min) keep every 60-second window at or
 * under 600 even after an idle period, so the budget itself never triggers a
 * 429. A 429 still happens if the key is shared with non-CLEO clients; then
 * {@link DecisionBudget.penalize} empties the bucket and blocks every process
 * until the server's `retry-after` has passed.
 *
 * The bucket fails CLOSED: if the lock cannot be taken quickly or the state
 * cannot be read, the request is denied and the caller falls back to its
 * heuristic. Exceeding the provider's limit is worse than one fallback.
 *
 * @task T12490
 * @epic T12486
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

/** Default burst capacity (tokens). */
export const DEFAULT_BUDGET_CAPACITY = 60;
/** Default refill rate (tokens per minute). Capacity + refill ≤ 600 per minute. */
export const DEFAULT_BUDGET_REFILL_PER_MINUTE = 540;
/** Cool-down applied after a 429 that carried no usable `retry-after`. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10_000;
/**
 * Longest cool-down any 429 may impose. The bucket is machine-wide, so an
 * uncapped `retry-after: 999999999` would stop every decision on the machine
 * for decades.
 */
export const MAX_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Result of {@link DecisionBudget.tryAcquire}. */
export type BudgetGrant =
  | { readonly granted: true }
  | { readonly granted: false; readonly reason: 'exhausted' | 'cooling_down' | 'unavailable' };

/** A request budget. Implementations never throw. */
export interface DecisionBudget {
  /** Take one token if available. */
  tryAcquire(): Promise<BudgetGrant>;
  /** Empty the bucket and block all acquisitions for `retryAfterMs` (after a 429). */
  penalize(retryAfterMs?: number): Promise<void>;
}

/** Bucket parameters. */
export interface TokenBucketOptions {
  /** Burst capacity. Default {@link DEFAULT_BUDGET_CAPACITY}. */
  readonly capacity?: number;
  /** Refill rate per minute. Default {@link DEFAULT_BUDGET_REFILL_PER_MINUTE}. */
  readonly refillPerMinute?: number;
  /** Wall clock in epoch ms (shared across processes). Default `Date.now`. */
  readonly now?: () => number;
}

/** Persisted bucket state. */
interface BucketState {
  /** Tokens available at `updatedAt`. */
  tokens: number;
  /** Epoch ms of the last refill computation. */
  updatedAt: number;
  /** Epoch ms before which every acquisition is refused (429 cool-down). */
  blockedUntil: number;
}

interface ResolvedBucket {
  capacity: number;
  refillPerMs: number;
  now: () => number;
}

function resolve(opts: TokenBucketOptions): ResolvedBucket {
  return {
    capacity: Math.max(1, opts.capacity ?? DEFAULT_BUDGET_CAPACITY),
    refillPerMs: Math.max(0, opts.refillPerMinute ?? DEFAULT_BUDGET_REFILL_PER_MINUTE) / 60_000,
    now: opts.now ?? Date.now,
  };
}

/** Apply refill + one acquisition to `state` (mutates) and report the outcome. */
function take(state: BucketState, bucket: ResolvedBucket): BudgetGrant {
  const now = bucket.now();
  // A cool-down beyond the cap can only come from a state file written before
  // the cap existed; honour at most the cap from when it was imposed.
  state.blockedUntil = Math.min(state.blockedUntil, state.updatedAt + MAX_RATE_LIMIT_COOLDOWN_MS);
  if (now < state.blockedUntil) return { granted: false, reason: 'cooling_down' };
  const elapsed = Math.max(0, now - state.updatedAt);
  state.tokens = Math.min(bucket.capacity, state.tokens + elapsed * bucket.refillPerMs);
  state.updatedAt = now;
  if (state.tokens < 1) return { granted: false, reason: 'exhausted' };
  state.tokens -= 1;
  return { granted: true };
}

function penalizeState(state: BucketState, bucket: ResolvedBucket, retryAfterMs?: number): void {
  const now = bucket.now();
  const wait = Math.min(
    MAX_RATE_LIMIT_COOLDOWN_MS,
    retryAfterMs !== undefined && retryAfterMs >= 0 ? retryAfterMs : DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  );
  state.tokens = 0;
  state.updatedAt = now;
  state.blockedUntil = Math.max(state.blockedUntil, now + wait);
}

function freshState(bucket: ResolvedBucket): BucketState {
  return { tokens: bucket.capacity, updatedAt: bucket.now(), blockedUntil: 0 };
}

/**
 * A process-local bucket. Useful for tests and for callers that must not touch
 * the filesystem; it does NOT coordinate with other processes.
 *
 * @param opts - Bucket parameters.
 * @returns A {@link DecisionBudget}.
 */
export function createMemoryTokenBucket(opts: TokenBucketOptions = {}): DecisionBudget {
  const bucket = resolve(opts);
  const state = freshState(bucket);
  return {
    async tryAcquire() {
      return take(state, bucket);
    },
    async penalize(retryAfterMs) {
      penalizeState(state, bucket, retryAfterMs);
    },
  };
}

/** Options for {@link createFileTokenBucket}. */
export interface FileTokenBucketOptions extends TokenBucketOptions {
  /** State-file path. Default {@link defaultBudgetStatePath}. */
  readonly statePath?: string;
}

/**
 * Default location of the shared bucket state: `<cleoHome>/decide/budget.json`.
 *
 * @returns Absolute path.
 */
export function defaultBudgetStatePath(): string {
  return join(getCleoHome(), 'decide', 'budget.json');
}

/** Short lock retries: the whole decision has a sub-second budget. */
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  stale: 2_000,
  retries: { retries: 4, factor: 1.5, minTimeout: 5, maxTimeout: 25 },
};

/** Schema of the persisted state; anything else is treated as corrupt. */
const bucketStateSchema = z.object({
  tokens: z.number(),
  updatedAt: z.number(),
  blockedUntil: z.number(),
});

function readState(path: string, bucket: ResolvedBucket): BucketState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return freshState(bucket);
  }
  try {
    const parsed = bucketStateSchema.safeParse(JSON.parse(raw));
    // A corrupt file resets to an EMPTY bucket, not a full one: fail closed.
    return parsed.success ? parsed.data : { tokens: 0, updatedAt: bucket.now(), blockedUntil: 0 };
  } catch {
    return { tokens: 0, updatedAt: bucket.now(), blockedUntil: 0 };
  }
}

function writeState(path: string, state: BucketState): void {
  const tmp = join(dirname(path), `.budget.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, JSON.stringify(state), 'utf-8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * A bucket whose state is shared by every process on the machine through a
 * locked JSON file.
 *
 * @param opts - Bucket parameters and state path.
 * @returns A {@link DecisionBudget}; `tryAcquire` resolves `unavailable` when
 *   the lock or state file cannot be used.
 */
export function createFileTokenBucket(opts: FileTokenBucketOptions = {}): DecisionBudget {
  const bucket = resolve(opts);
  const statePath = opts.statePath ?? defaultBudgetStatePath();

  async function withState<T>(mutate: (state: BucketState) => T): Promise<T> {
    mkdirSync(dirname(statePath), { recursive: true });
    const release = await lockfile.lock(statePath, LOCK_OPTIONS);
    try {
      const state = readState(statePath, bucket);
      const result = mutate(state);
      writeState(statePath, state);
      return result;
    } finally {
      await release().catch(() => undefined);
    }
  }

  return {
    async tryAcquire() {
      try {
        return await withState((state) => take(state, bucket));
      } catch {
        return { granted: false, reason: 'unavailable' };
      }
    },
    async penalize(retryAfterMs) {
      try {
        await withState((state) => penalizeState(state, bucket, retryAfterMs));
      } catch {
        /* best effort: the next acquisition will meet the provider's 429 again */
      }
    },
  };
}
