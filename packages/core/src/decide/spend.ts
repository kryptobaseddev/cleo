/**
 * Monthly spend cap for System One decisions — the CLEO-enforced COST budget
 * of owner decision D11159 (spec `system-one-integration` §7).
 *
 * Every CLEO process on the machine records provider-reported cost (integer
 * micro-dollars) into ONE ledger, `<cleoHome>/decide/spend.json`, guarded by a
 * `proper-lockfile` lock. Once the month-to-date spend reaches the cap
 * (`decide.budget.monthlyMicros`, default
 * {@link DEFAULT_MONTHLY_SPEND_CAP_MICROS} = $1), every site degrades to its
 * heuristic with fallback reason `budget` until the UTC month rolls over. It
 * never fails a command.
 *
 * ## Reserve, then commit
 *
 * A caller reserves its estimated cost BEFORE the provider call, under the
 * same lock as the cap check, and commits the reported cost (or releases the
 * reservation) after it. Concurrent callers therefore see each other's
 * in-flight spend and cannot overshoot the cap together. A reservation whose
 * process died expires after {@link RESERVATION_TTL_MS}.
 *
 * The lock retries for about a second with backoff: a decision may wait for
 * the ledger, but a cost is never dropped because 40 processes recorded at
 * once (review of #1685: the first version lost 33 of 40 concurrent records).
 *
 * The ledger also carries the key-limit stop: a 403 `key_limit_exceeded`
 * (an unverified provider extension) means the key's monthly decision limit
 * is reached, so decisions stop until the end of the UTC month.
 *
 * A corrupt ledger fails closed (every site uses its heuristic) and
 * `cleo decide status` says so; `cleo decide budget reset` repairs it, moving
 * the bad file aside as a receipt.
 *
 * @task T12664
 * @epic T12486
 */

import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import lockfile from 'proper-lockfile';
import { z } from 'zod';

/** Default monthly cap: 1,000,000 micro-dollars = $1 (D11159). */
export const DEFAULT_MONTHLY_SPEND_CAP_MICROS = 1_000_000;

/** Config key holding the monthly cap in micro-dollars. */
export const MONTHLY_SPEND_CAP_KEY = 'decide.budget.monthlyMicros';

/** How long an uncommitted reservation counts against the cap, ms. */
export const RESERVATION_TTL_MS = 60_000;

/** Verdict of a spend check or reservation. */
export type SpendVerdict = 'ok' | 'over_budget' | 'key_limited' | 'unavailable';

/** Month-to-date state, as `cleo decide status` reports it. */
export interface SpendStatus {
  /** UTC month, `YYYY-MM`. */
  readonly month: string;
  /** Micro-dollars committed this month. */
  readonly spentMicros: number;
  /** Micro-dollars reserved by calls still in flight. */
  readonly reservedMicros: number;
  /** Epoch ms until which the key's monthly limit stops decisions, when set. */
  readonly keyLimitedUntil?: number;
}

/** Result of {@link SpendLedger.reserve}. */
export interface SpendReservation {
  /** The verdict; only `ok` carries a reservation. */
  readonly verdict: SpendVerdict;
  /** Reservation id to commit or release. */
  readonly id?: string;
}

/** Result of {@link SpendLedger.inspect}. */
export type SpendLedgerHealth = 'ok' | 'absent' | 'corrupt' | 'unavailable';

/** A monthly spend ledger. Implementations never throw. */
export interface SpendLedger {
  /**
   * Check the cap and, when there is room for `estimateMicros` on top of the
   * committed and reserved spend, reserve it — atomically.
   */
  reserve(capMicros: number, estimateMicros: number): Promise<SpendReservation>;
  /** Replace a reservation with the provider-reported cost. */
  commit(id: string, costMicros: number): Promise<void>;
  /** Drop a reservation (the call was not billed). */
  release(id: string): Promise<void>;
  /** Add a cost with no reservation. */
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
  reservations: Record<string, { micros: number; at: number }>;
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

function freshState(now: number): LedgerState {
  return { month: utcMonth(now), spentMicros: 0, keyLimitedUntil: 0, reservations: {} };
}

/** Roll a state over to the current month and drop expired reservations (mutates). */
function roll(state: LedgerState, now: number): void {
  const month = utcMonth(now);
  if (state.month !== month) {
    state.month = month;
    state.spentMicros = 0;
  }
  if (state.keyLimitedUntil <= now) state.keyLimitedUntil = 0;
  for (const [id, r] of Object.entries(state.reservations)) {
    if (now - r.at >= RESERVATION_TTL_MS) delete state.reservations[id];
  }
}

function reservedOf(state: LedgerState): number {
  return Object.values(state.reservations).reduce((n, r) => n + r.micros, 0);
}

function positive(micros: number): number {
  return Number.isFinite(micros) && micros > 0 ? Math.round(micros) : 0;
}

function doReserve(
  state: LedgerState,
  capMicros: number,
  estimateMicros: number,
  now: number,
): SpendReservation {
  roll(state, now);
  if (state.keyLimitedUntil > now) return { verdict: 'key_limited' };
  const estimate = positive(estimateMicros);
  if (
    state.spentMicros + reservedOf(state) + estimate > capMicros ||
    state.spentMicros >= capMicros
  ) {
    return { verdict: 'over_budget' };
  }
  const id = randomBytes(8).toString('hex');
  state.reservations[id] = { micros: estimate, at: now };
  return { verdict: 'ok', id };
}

function toStatus(state: LedgerState): SpendStatus {
  return {
    month: state.month,
    spentMicros: state.spentMicros,
    reservedMicros: reservedOf(state),
    ...(state.keyLimitedUntil > 0 ? { keyLimitedUntil: state.keyLimitedUntil } : {}),
  };
}

/** The operations every ledger implements, over a state accessor. */
function ledgerOver(
  withState: <T>(mutate: (s: LedgerState) => T, write: boolean) => Promise<T>,
  now: () => number,
): SpendLedger {
  return {
    async reserve(capMicros, estimateMicros) {
      try {
        return await withState((s) => doReserve(s, capMicros, estimateMicros, now()), true);
      } catch {
        return { verdict: 'unavailable' };
      }
    },
    async commit(id, costMicros) {
      try {
        await withState((s) => {
          roll(s, now());
          delete s.reservations[id];
          s.spentMicros += positive(costMicros);
        }, true);
      } catch {
        /* the reservation expires; an unrecorded cost only makes the cap later */
      }
    },
    async release(id) {
      try {
        await withState((s) => {
          delete s.reservations[id];
        }, true);
      } catch {
        /* the reservation expires on its own */
      }
    },
    async record(costMicros) {
      const micros = positive(costMicros);
      if (micros === 0) return;
      try {
        await withState((s) => {
          roll(s, now());
          s.spentMicros += micros;
        }, true);
      } catch {
        /* best effort */
      }
    },
    async markKeyLimited() {
      try {
        await withState((s) => {
          roll(s, now());
          s.keyLimitedUntil = startOfNextUtcMonth(now());
        }, true);
      } catch {
        /* the next call meets the 403 again */
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
  const state = freshState(now());
  return ledgerOver(async (mutate) => mutate(state), now);
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

/**
 * Lock retries: about a second with backoff (5 ms growing to 50 ms). Long
 * enough that dozens of concurrent processes all get their turn; a caller on
 * a decision deadline is bounded by that deadline, not by this.
 */
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  stale: 5_000,
  retries: { retries: 40, factor: 1.2, minTimeout: 5, maxTimeout: 50, randomize: true },
};

const ledgerSchema = z.object({
  month: z.string(),
  spentMicros: z.number().nonnegative(),
  keyLimitedUntil: z.number().nonnegative(),
  reservations: z
    .record(z.string(), z.object({ micros: z.number().nonnegative(), at: z.number() }))
    .default({}),
});

/** Thrown when the ledger file exists but cannot be parsed. */
class CorruptLedgerError extends Error {}

function readLedger(path: string, now: number): LedgerState {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return freshState(now);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CorruptLedgerError('spend ledger is not JSON');
  }
  const parsed = ledgerSchema.safeParse(json);
  if (!parsed.success) throw new CorruptLedgerError('spend ledger has an unexpected shape');
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
 * A lock or read failure (including a corrupt file) makes `reserve` answer
 * `unavailable`, which the client treats as a fallback: the cap fails closed,
 * like the request bucket.
 *
 * @param opts - Clock and state path.
 * @returns A {@link SpendLedger}.
 */
export function createFileSpendLedger(opts: FileSpendLedgerOptions = {}): SpendLedger {
  const now = opts.now ?? Date.now;
  const statePath = opts.statePath ?? defaultSpendStatePath();
  return ledgerOver(async (mutate, write) => {
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
  }, now);
}

/**
 * Whether the ledger file is readable.
 *
 * @param statePath - Ledger path. Default {@link defaultSpendStatePath}.
 * @returns `ok`, `absent`, `corrupt` or `unavailable` (unreadable for another reason).
 */
export function inspectSpendLedger(statePath = defaultSpendStatePath()): SpendLedgerHealth {
  if (!existsSync(statePath)) return 'absent';
  try {
    readLedger(statePath, Date.now());
    return 'ok';
  } catch (err) {
    return err instanceof CorruptLedgerError ? 'corrupt' : 'unavailable';
  }
}

/** Receipt of {@link resetSpendLedger}. */
export interface SpendResetReceipt {
  /** Ledger path. */
  readonly statePath: string;
  /** Health before the reset. */
  readonly before: SpendLedgerHealth;
  /** Where the previous file was moved, when there was one. */
  readonly backupPath?: string;
  /** ISO time of the reset. */
  readonly resetAt: string;
}

/**
 * Reset the ledger (`cleo decide budget reset`): move the current file aside
 * to `spend.json.reset-<iso>` and start an empty ledger for this month. The
 * repair for a corrupt ledger, which otherwise fails closed forever. The
 * month-to-date spend restarts at zero, so the moved file is kept as the
 * receipt of what was recorded.
 *
 * @param statePath - Ledger path. Default {@link defaultSpendStatePath}.
 * @param now - Wall clock, epoch ms.
 * @returns What was reset and where the old file went.
 */
export async function resetSpendLedger(
  statePath = defaultSpendStatePath(),
  now: number = Date.now(),
): Promise<SpendResetReceipt> {
  const before = inspectSpendLedger(statePath);
  const resetAt = new Date(now).toISOString();
  mkdirSync(dirname(statePath), { recursive: true });
  const release = await lockfile.lock(statePath, LOCK_OPTIONS);
  try {
    let backupPath: string | undefined;
    if (existsSync(statePath)) {
      backupPath = `${statePath}.reset-${resetAt.replace(/[:.]/g, '-')}`;
      renameSync(statePath, backupPath);
    }
    writeLedger(statePath, freshState(now));
    return { statePath, before, ...(backupPath ? { backupPath } : {}), resetAt };
  } finally {
    await release().catch(() => undefined);
  }
}
