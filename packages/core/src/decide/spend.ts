/**
 * Monthly spend cap for System One decisions — the CLEO-enforced COST budget
 * of owner decision D11159 (spec `system-one-integration` §7).
 *
 * Every CLEO process on the machine records provider-reported cost (integer
 * micro-dollars) into ONE ledger, `<cleoHome>/decide/spend.json`, guarded by
 * the same `proper-lockfile` pattern as the request bucket (`./budget.ts`).
 * Once the month-to-date spend reaches the cap (`decide.budget.monthlyMicros`,
 * default {@link DEFAULT_MONTHLY_SPEND_CAP_MICROS} = $1), every site degrades
 * to its heuristic with fallback reason `budget` until the UTC month rolls
 * over. It never fails a command.
 *
 * The ledger also carries the key-limit stop: a 403 `key_limit_exceeded`
 * means the key's monthly decision limit (set in the provider console) is
 * reached, so decisions stop until the end of the UTC month.
 *
 * The request-rate bucket stays in place alongside this; they answer
 * different questions (requests per minute vs dollars per month).
 *
 * @task T12664
 * @epic T12486
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

/** Default monthly cap: 1,000,000 micro-dollars = $1 (D11159). */
export const DEFAULT_MONTHLY_SPEND_CAP_MICROS = 1_000_000;

/** Config key holding the monthly cap in micro-dollars. */
export const MONTHLY_SPEND_CAP_KEY = 'decide.budget.monthlyMicros';

/** Verdict of {@link SpendLedger.check}. */
export type SpendVerdict = 'ok' | 'over_budget' | 'key_limited' | 'unavailable';

/** Month-to-date state, as `cleo decide status` reports it. */
export interface SpendStatus {
  /** UTC month, `YYYY-MM`. */
  readonly month: string;
  /** Micro-dollars recorded this month. */
  readonly spentMicros: number;
  /** Epoch ms until which the key's monthly limit stops decisions, when set. */
  readonly keyLimitedUntil?: number;
}

/** A monthly spend ledger. Implementations never throw. */
export interface SpendLedger {
  /** May a decision be asked under `capMicros`? */
  check(capMicros: number): Promise<SpendVerdict>;
  /** Add provider-reported cost for this month. */
  record(costMicros: number): Promise<void>;
  /** Stop decisions until the end of the current UTC month (403 key limit). */
  markKeyLimited(): Promise<void>;
  /** Current month-to-date state; `null` when unreadable. */
  status(): Promise<SpendStatus | null>;
}

/** Persisted ledger state. */
interface LedgerState {
  month: string;
  spentMicros: number;
  keyLimitedUntil: number;
}

/**
 * The UTC month of `epochMs`, `YYYY-MM`.
 *
 * @param epochMs - Epoch milliseconds.
 * @returns The month string.
 */
export function utcMonth(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Epoch ms of the first instant of the next UTC month.
 *
 * @param epochMs - Epoch milliseconds.
 * @returns Start of the next UTC month.
 */
export function startOfNextUtcMonth(epochMs: number): number {
  const d = new Date(epochMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Roll a state over to the current month (mutates). */
function roll(state: LedgerState, now: number): void {
  const month = utcMonth(now);
  if (state.month !== month) {
    state.month = month;
    state.spentMicros = 0;
  }
  if (state.keyLimitedUntil <= now) state.keyLimitedUntil = 0;
}

function verdict(state: LedgerState, capMicros: number, now: number): SpendVerdict {
  roll(state, now);
  if (state.keyLimitedUntil > now) return 'key_limited';
  if (capMicros >= 0 && state.spentMicros >= capMicros) return 'over_budget';
  return 'ok';
}

function toStatus(state: LedgerState): SpendStatus {
  return {
    month: state.month,
    spentMicros: state.spentMicros,
    ...(state.keyLimitedUntil > 0 ? { keyLimitedUntil: state.keyLimitedUntil } : {}),
  };
}

/** Clock option shared by both ledgers. */
export interface SpendLedgerOptions {
  /** Wall clock, epoch ms. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A process-local ledger (tests, callers that must not touch disk).
 *
 * @param opts - Clock.
 * @returns A {@link SpendLedger} that does NOT coordinate across processes.
 */
export function createMemorySpendLedger(opts: SpendLedgerOptions = {}): SpendLedger {
  const now = opts.now ?? Date.now;
  const state: LedgerState = { month: utcMonth(now()), spentMicros: 0, keyLimitedUntil: 0 };
  return {
    async check(capMicros) {
      return verdict(state, capMicros, now());
    },
    async record(costMicros) {
      roll(state, now());
      if (Number.isFinite(costMicros) && costMicros > 0)
        state.spentMicros += Math.round(costMicros);
    },
    async markKeyLimited() {
      roll(state, now());
      state.keyLimitedUntil = startOfNextUtcMonth(now());
    },
    async status() {
      roll(state, now());
      return toStatus(state);
    },
  };
}

/** Options for {@link createFileSpendLedger}. */
export interface FileSpendLedgerOptions extends SpendLedgerOptions {
  /** Ledger path. Default {@link defaultSpendStatePath}. */
  readonly statePath?: string;
}

/**
 * Default ledger location: `<cleoHome>/decide/spend.json`.
 *
 * @returns Absolute path.
 */
export function defaultSpendStatePath(): string {
  return join(getCleoHome(), 'decide', 'spend.json');
}

const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  stale: 2_000,
  retries: { retries: 4, factor: 1.5, minTimeout: 5, maxTimeout: 25 },
};

const ledgerSchema = z.object({
  month: z.string(),
  spentMicros: z.number().nonnegative(),
  keyLimitedUntil: z.number().nonnegative(),
});

function readLedger(path: string, now: number): LedgerState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { month: utcMonth(now), spentMicros: 0, keyLimitedUntil: 0 };
  }
  const parsed = ledgerSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error('corrupt spend ledger');
  return parsed.data;
}

function writeLedger(path: string, state: LedgerState): void {
  const tmp = join(dirname(path), `.spend.${randomBytes(6).toString('hex')}.tmp`);
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
 * A ledger shared by every process on the machine through a locked JSON file.
 * A lock or read failure (including a corrupt file) makes `check` answer
 * `unavailable`, which the client treats as a fallback: the cap fails closed,
 * like the request bucket.
 *
 * @param opts - Clock and state path.
 * @returns A {@link SpendLedger}.
 */
export function createFileSpendLedger(opts: FileSpendLedgerOptions = {}): SpendLedger {
  const now = opts.now ?? Date.now;
  const statePath = opts.statePath ?? defaultSpendStatePath();

  async function withState<T>(mutate: (state: LedgerState) => T, write: boolean): Promise<T> {
    mkdirSync(dirname(statePath), { recursive: true });
    const release = await lockfile.lock(statePath, LOCK_OPTIONS);
    try {
      const state = readLedger(statePath, now());
      const result = mutate(state);
      if (write) writeLedger(statePath, state);
      return result;
    } finally {
      await release().catch(() => undefined);
    }
  }

  return {
    async check(capMicros) {
      try {
        return await withState((s) => verdict(s, capMicros, now()), false);
      } catch {
        return 'unavailable';
      }
    },
    async record(costMicros) {
      if (!Number.isFinite(costMicros) || costMicros <= 0) return;
      try {
        await withState((s) => {
          roll(s, now());
          s.spentMicros += Math.round(costMicros);
        }, true);
      } catch {
        /* best effort: an unrecorded cost only makes the cap later */
      }
    },
    async markKeyLimited() {
      try {
        await withState((s) => {
          roll(s, now());
          s.keyLimitedUntil = startOfNextUtcMonth(now());
        }, true);
      } catch {
        /* best effort: the next call meets the 403 again */
      }
    },
    async status() {
      try {
        return await withState((s) => {
          roll(s, now());
          return toStatus(s);
        }, false);
      } catch {
        return null;
      }
    },
  };
}
