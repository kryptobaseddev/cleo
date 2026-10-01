/**
 * Holder records for the governor's local slots (T12963).
 *
 * `proper-lockfile` frees a slot whose holder died only after
 * {@link GOVERNOR_SLOT_STALE_MS} (10 min) of mtime staleness. With a one-slot
 * `test-run` budget, a SIGKILLed `cleo verify tool:test` blocked every later
 * heavy run for ten minutes, and the deferral named no one. Each slot now
 * carries a `<slot>.holder.json` record with the holder's pid and process
 * start time: a slot whose holder process is provably gone is reaped at once,
 * as the tool semaphore does for its slots (gh#1222), and a deferral names who
 * holds the slot.
 *
 * Start times are `ps -o lstart=` strings rendered under `PS_STABLE_ENV` (UTC,
 * C locale), so a string written by one process compares equal to the same
 * process's start time read by another, whatever either one's `TZ` or locale.
 *
 * @task T12963
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename } from 'node:path';
import type { ResourceClass } from '@cleocode/contracts';
import lockfile from 'proper-lockfile';
import { getLogger } from '../logger.js';
import { readProcessEntry } from '../sessions/terminal-identity.js';

let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('resource-governor');
  return _log;
}

/** `proper-lockfile` staleness of a governor slot: a holder that stops refreshing is freed after this. */
export const GOVERNOR_SLOT_STALE_MS = 600_000;

/**
 * Who holds a local governor slot, written to `<slot>.holder.json` once the
 * lock is taken.
 *
 * @task T12963
 */
export interface GovernorSlotHolder {
  /** OS process id of the holder. */
  pid: number;
  /**
   * The holder's process start time (`ps -o lstart=` under `PS_STABLE_ENV`),
   * or `null` when `ps` could not say. A live process at `pid` with a
   * different start time is not the holder: the pid was recycled.
   */
  startedAt: string | null;
  /** Host the pid belongs to. Liveness is only judged on this host. */
  host: string;
  /** Class the slot belongs to. */
  cls: ResourceClass;
  /** Wall-clock acquisition time (epoch ms), for deferral messages. */
  acquiredAtMs: number;
  /**
   * The lock directory this record describes (`<ino>:<birthtimeMs>`), or
   * `null` when it could not be read. A record whose lock was since replaced
   * describes nobody.
   */
  lockId: string | null;
}

/**
 * How a holder's pid is probed. Tests inject one; production uses
 * `kill(pid, 0)` and `ps`.
 *
 * @task T12963
 */
export interface PidProbe {
  /** `gone` (no such process), `alive`, or `unknown` when the probe itself failed. */
  liveness(pid: number): 'gone' | 'alive' | 'unknown';
  /** The process start time as `ps -o lstart=` prints it, or `null` when it cannot be read. */
  startedAt(pid: number): string | null;
}

/**
 * Verdict on a slot's recorded holder. Only `dead` frees the slot; `unknown`
 * keeps it held, because reaping a live holder would admit two heavy runs
 * against one budget.
 *
 * @task T12963
 */
export type GovernorHolderState = 'alive' | 'dead' | 'unknown';

/**
 * A lock mtime younger than this was refreshed by its live holder:
 * `proper-lockfile` touches it every `GOVERNOR_SLOT_STALE_MS / 2`, plus slack
 * for a busy event loop. Within it a live pid is taken as the holder without
 * spawning `ps`.
 */
const LOCK_REFRESH_WINDOW_MS = GOVERNOR_SLOT_STALE_MS / 2 + 30_000;

/** How long a pid's start time is reused before `ps` is asked again. */
const START_CACHE_TTL_MS = 10_000;

/** Stale threshold of the per-slot reap guard; a reap holds it for milliseconds. */
const REAP_GUARD_STALE_MS = 10_000;

const _startCache = new Map<number, { readAtMs: number; startedAt: string | null }>();

/** This process's own start time, read once (`undefined` until then). */
let _ownStartedAt: string | null | undefined;

/** A pid we may ever probe: an integer above 1 (never 0, 1 or a negative group). */
function isProbeablePid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 1;
}

/**
 * Start time of `pid`, or `null` when `ps` cannot say. Cached for
 * {@link START_CACHE_TTL_MS}: a blocked acquire polls every 200 ms, and a `ps`
 * spawn per poll is load an overloaded machine does not need.
 */
function processStartedAt(pid: number): string | null {
  const now = Date.now();
  const hit = _startCache.get(pid);
  if (hit && now - hit.readAtMs < START_CACHE_TTL_MS) return hit.startedAt;
  const startedAt = readProcessEntry(pid)?.startedAt ?? null;
  _startCache.set(pid, { readAtMs: now, startedAt });
  return startedAt;
}

/** Default pid probe: `kill(pid, 0)` and a cached `ps` start time. */
const defaultPidProbe: PidProbe = {
  liveness(pid) {
    if (!isProbeablePid(pid)) return 'unknown';
    try {
      process.kill(pid, 0); // signal 0 = existence check, sends nothing
      return 'alive';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return 'gone';
      // EPERM: it exists but belongs to another user. Anything else: we cannot tell.
      return code === 'EPERM' ? 'alive' : 'unknown';
    }
  },
  startedAt: processStartedAt,
};

function holderPathOf(slotPath: string): string {
  return `${slotPath}.holder.json`;
}

/** The slot's current lock directory — identity and mtime — or `null` when there is none. */
function lockStatOf(slotPath: string): { id: string; mtimeMs: number } | null {
  try {
    const st = statSync(`${slotPath}.lock`);
    return { id: `${st.ino}:${Math.trunc(st.birthtimeMs)}`, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Write the holder record for a slot whose lock is held, stamping it with the
 * current lock's identity. Best-effort: a failed write leaves the slot
 * unreapable (it waits out {@link GOVERNOR_SLOT_STALE_MS}), never unheld.
 *
 * @param slotPath - Slot lock file path.
 * @param holder - Who holds it.
 * @returns The record as written.
 *
 * @internal Exported so tests can plant a foreign holder.
 * @task T12963
 */
export function writeGovernorHolder(
  slotPath: string,
  holder: Omit<GovernorSlotHolder, 'lockId'>,
): GovernorSlotHolder {
  const record: GovernorSlotHolder = { ...holder, lockId: lockStatOf(slotPath)?.id ?? null };
  try {
    writeFileSync(holderPathOf(slotPath), JSON.stringify(record), 'utf-8');
  } catch {
    /* best-effort — never fail an acquire that succeeded */
  }
  return record;
}

/**
 * Read a slot's holder record, or `null` when absent or malformed.
 *
 * @param slotPath - Slot lock file path.
 * @returns The record, or `null`.
 *
 * @task T12963
 */
export function readGovernorHolder(slotPath: string): GovernorSlotHolder | null {
  try {
    const parsed = JSON.parse(
      readFileSync(holderPathOf(slotPath), 'utf-8'),
    ) as Partial<GovernorSlotHolder>;
    if (
      !isProbeablePid(parsed.pid) ||
      typeof parsed.host !== 'string' ||
      typeof parsed.acquiredAtMs !== 'number' ||
      (parsed.startedAt !== null && typeof parsed.startedAt !== 'string')
    ) {
      return null;
    }
    return parsed as GovernorSlotHolder;
  } catch {
    return null;
  }
}

/**
 * Decide whether a slot's recorded holder still holds it.
 *
 * - `dead`: the pid is gone, or alive with a different start time than the
 *   record's (a recycled pid).
 * - `unknown`: no record, another host's pid, a record that does not describe
 *   the current lock, or a probe that failed. Never treated as dead.
 * - `alive`: otherwise, including a live pid whose start time was never
 *   recorded.
 *
 * A live holder's `proper-lockfile` timer refreshes the lock mtime every
 * `GOVERNOR_SLOT_STALE_MS / 2`. While the mtime is that fresh a live pid is
 * taken as the holder without asking `ps`, so a contended acquire spawns
 * nothing. A pid recycled inside that window therefore reads as alive until
 * the refresh lapses; that is the safe direction.
 *
 * @param holder - The slot's record, or `null`.
 * @param slotPath - Slot lock file path.
 * @param probe - Pid probe; tests inject one.
 * @returns The verdict.
 *
 * @task T12963
 */
export function assessGovernorHolder(
  holder: GovernorSlotHolder | null,
  slotPath: string,
  probe: PidProbe = defaultPidProbe,
): GovernorHolderState {
  if (holder === null || holder.host !== hostname() || !isProbeablePid(holder.pid)) {
    return 'unknown';
  }
  const lock = lockStatOf(slotPath);
  if (lock === null || holder.lockId !== lock.id) return 'unknown';
  const liveness = probe.liveness(holder.pid);
  if (liveness !== 'alive') return liveness === 'gone' ? 'dead' : 'unknown';
  if (Date.now() - lock.mtimeMs < LOCK_REFRESH_WINDOW_MS) return 'alive';
  if (holder.startedAt === null) return 'alive';
  const startedAt = probe.startedAt(holder.pid);
  if (startedAt === null) return 'unknown'; // ps failed: never proof of death
  return startedAt === holder.startedAt ? 'alive' : 'dead';
}

/**
 * Name every held slot and its holder, for a deferral reason.
 *
 * @param slots - Slot lock file paths of one class.
 * @returns `; held by …`, or `''` when no slot is held.
 *
 * @task T12963
 */
export function describeSlotHolders(slots: readonly string[]): string {
  const held: string[] = [];
  for (const path of slots) {
    if (!existsSync(`${path}.lock`)) continue;
    const h = readGovernorHolder(path);
    held.push(
      h
        ? `${basename(path)}: pid ${h.pid} on ${h.host} since ` +
            `${new Date(h.acquiredAtMs).toISOString()} (${assessGovernorHolder(h, path)})`
        : `${basename(path)}: holder unknown`,
    );
  }
  return held.length > 0 ? `; held by ${held.join(', ')}` : '';
}

/** A grant's release: drops our holder record, then the lock. Idempotent. */
function holderRelease(
  slotPath: string,
  holder: GovernorSlotHolder,
  unlock: () => Promise<void>,
): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    // Record first, lock second: the record must never outlive our lock and
    // end up describing the next holder's.
    const current = readGovernorHolder(slotPath);
    if (current?.pid === holder.pid && current.acquiredAtMs === holder.acquiredAtMs) {
      try {
        rmSync(holderPathOf(slotPath), { force: true });
      } catch {
        /* best-effort — a stale record is only ever advisory */
      }
    }
    try {
      await unlock();
    } catch {
      // Already released (e.g. stale recovery) — post-condition holds.
    }
  };
}

/** Take a free slot without waiting; record the holder. `null` when busy. */
async function tryLockSlot(
  slotPath: string,
  cls: ResourceClass,
): Promise<(() => Promise<void>) | null> {
  let unlock: () => Promise<void>;
  try {
    unlock = await lockfile.lock(slotPath, {
      retries: 0,
      stale: GOVERNOR_SLOT_STALE_MS,
      realpath: false,
    });
  } catch {
    return null;
  }
  if (_ownStartedAt === undefined) _ownStartedAt = processStartedAt(process.pid);
  const holder = writeGovernorHolder(slotPath, {
    pid: process.pid,
    startedAt: _ownStartedAt,
    host: hostname(),
    cls,
    acquiredAtMs: Date.now(),
  });
  return holderRelease(slotPath, holder, unlock);
}

/**
 * Free a busy slot whose holder is provably dead, then take it.
 *
 * The reap runs under a per-slot guard and re-checks the holder inside it, and
 * the new holder record is written before the guard is released, so two
 * waiters that both saw the dead holder cannot each remove the other's fresh
 * lock.
 */
async function reapAndLockSlot(
  slotPath: string,
  cls: ResourceClass,
): Promise<(() => Promise<void>) | null> {
  if (assessGovernorHolder(readGovernorHolder(slotPath), slotPath) !== 'dead') return null;
  let releaseGuard: () => Promise<void>;
  try {
    releaseGuard = await lockfile.lock(`${slotPath}.reap`, {
      lockfilePath: `${slotPath}.reaping`,
      retries: 0,
      stale: REAP_GUARD_STALE_MS,
      realpath: false,
    });
  } catch {
    return null; // another waiter is reaping this slot
  }
  try {
    const holder = readGovernorHolder(slotPath);
    if (assessGovernorHolder(holder, slotPath) !== 'dead') return null;
    rmSync(holderPathOf(slotPath), { force: true });
    rmSync(`${slotPath}.lock`, { recursive: true, force: true });
    log().warn(
      { cls, slot: basename(slotPath), holderPid: holder?.pid },
      'reaped a resource slot whose holder process is gone or its pid recycled',
    );
    return await tryLockSlot(slotPath, cls);
  } catch {
    return null;
  } finally {
    await releaseGuard().catch(() => {});
  }
}

/**
 * Take a slot without waiting: free, or freed by reaping a dead holder.
 *
 * @param slotPath - Slot lock file path.
 * @param cls - Class the slot belongs to.
 * @returns The grant's release (drops the holder record, then the lock), or
 *   `null` when the slot is held.
 *
 * @task T12963
 */
export async function lockSlot(
  slotPath: string,
  cls: ResourceClass,
): Promise<(() => Promise<void>) | null> {
  return (await tryLockSlot(slotPath, cls)) ?? (await reapAndLockSlot(slotPath, cls));
}

/**
 * Forget cached start times, this process's included. Tests only.
 * @internal
 */
export function _resetSlotHolderStateForTest(): void {
  _startCache.clear();
  _ownStartedAt = undefined;
}
