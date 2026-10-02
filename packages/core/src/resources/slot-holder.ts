/**
 * Holder records for local lock slots: the governor's class slots and the
 * tool semaphore's per-tool slots (T12963, gh#1222).
 *
 * `proper-lockfile` frees a slot whose holder died only after
 * {@link GOVERNOR_SLOT_STALE_MS} (10 min) of mtime staleness. With a one-slot
 * `test-run` budget, a SIGKILLed `cleo verify tool:test` blocked every later
 * heavy run for ten minutes, and the deferral named no one. Each slot carries
 * a `<slot>.holder.json` record: the holder's pid and process start time, the
 * lock directory it describes, and the process groups of the tools it started.
 * A slot is reaped only when the holder pid is provably gone (or recycled) AND
 * every one of those tool groups is gone too: a tool started detached outlives
 * a SIGKILLed cleo, and it is the tool that uses the machine.
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
import { followToolGroups, isProbeableId, probeProcessGroup } from './tool-groups.js';

let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('resource-governor');
  return _log;
}

/** `proper-lockfile` staleness of a slot: a holder that stops refreshing is freed after this. */
export const GOVERNOR_SLOT_STALE_MS = 600_000;

/**
 * The liveness fields every slot holder record carries.
 *
 * @task T12963
 */
export interface SlotHolderIdentity {
  /** OS process id of the holder. */
  pid: number;
  /** Host the pid belongs to. Liveness is only judged on this host. */
  host: string;
  /**
   * The holder's process start time (`ps -o lstart=` under `PS_STABLE_ENV`),
   * or `null` when `ps` could not say. A live process at `pid` with a
   * different start time is not the holder: the pid was recycled. Absent from
   * records written before T12963.
   */
  startedAt?: string | null;
  /**
   * The lock directory this record describes (`<ino>:<birthtimeMs>`), or
   * `null` when it has no usable identity. A record whose lock was since
   * replaced, or that has no identity, never authorises a reap.
   */
  lockId?: string | null;
  /**
   * Process groups of the tools the holder started while holding the slot.
   * The slot stays held while any of them has a member.
   */
  toolGroups?: readonly number[];
}

/**
 * Who holds a local governor slot, written to `<slot>.holder.json` once the
 * lock is taken.
 *
 * @task T12963
 */
export interface GovernorSlotHolder extends SlotHolderIdentity {
  /** The holder's process start time, or `null` when `ps` could not say. */
  startedAt: string | null;
  /** The lock directory this record describes, or `null` when it has none. */
  lockId: string | null;
  /** Class the slot belongs to. */
  cls: ResourceClass;
  /** Wall-clock acquisition time (epoch ms), for deferral messages. */
  acquiredAtMs: number;
}

/**
 * How a holder's pid and tool groups are probed. Tests inject one; production
 * uses `kill(pid, 0)`, `kill(-pgid, 0)` and `ps`.
 *
 * @task T12963
 */
export interface PidProbe {
  /** `gone` (no such process), `alive`, or `unknown` when the probe itself failed. */
  liveness(pid: number): 'gone' | 'alive' | 'unknown';
  /** The process start time as `ps -o lstart=` prints it, or `null` when it cannot be read. */
  startedAt(pid: number): string | null;
  /** `gone` (no member left), `alive`, or `unknown` when the probe failed. */
  groupLiveness(pgid: number): 'gone' | 'alive' | 'unknown';
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

/**
 * A lock this close to `proper-lockfile`'s own stale threshold is left to
 * `proper-lockfile`: its stale takeover runs outside the reap guard and could
 * replace the lock between our check and our `rm` (T12963 re-review F2).
 */
const STALE_TAKEOVER_MARGIN_MS = 60_000;

/** How long a pid's start time is reused before `ps` is asked again. */
const START_CACHE_TTL_MS = 10_000;

/** Stale threshold of the per-slot reap guard; a reap holds it for milliseconds. */
const REAP_GUARD_STALE_MS = 10_000;

const _startCache = new Map<number, { readAtMs: number; startedAt: string | null }>();

/** This process's own start time, read once (`undefined` until then). */
let _ownStartedAt: string | null | undefined;

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

/**
 * This process's start time (`ps -o lstart=` under `PS_STABLE_ENV`), read once
 * per process, or `null` when `ps` could not say.
 *
 * @returns The start time, or `null`.
 *
 * @task T12963
 */
export function ownProcessStartedAt(): string | null {
  if (_ownStartedAt === undefined) _ownStartedAt = processStartedAt(process.pid);
  return _ownStartedAt;
}

/** Default probe: `kill(pid, 0)`, `kill(-pgid, 0)` and a cached `ps` start time. */
const defaultPidProbe: PidProbe = {
  liveness(pid) {
    if (!isProbeableId(pid)) return 'unknown';
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
  groupLiveness: probeProcessGroup,
};

function holderPathOf(slotPath: string): string {
  return `${slotPath}.holder.json`;
}

/**
 * A lock directory's identity: `<ino>:<birthtimeMs>`, or `null` when the
 * filesystem reports no birth time (NFS, FUSE, older kernels report 0). An
 * inode alone can be reused by the next lock, so such a lock has no identity
 * and is never reaped (T12963 re-review F3).
 *
 * @param ino - The lock directory's inode.
 * @param birthtimeMs - Its birth time, as `fs.Stats.birthtimeMs`.
 * @returns The identity, or `null`.
 *
 * @internal Exported for tests.
 * @task T12963
 */
export function lockIdentity(ino: number, birthtimeMs: number): string | null {
  const birth = Math.trunc(birthtimeMs);
  return Number.isFinite(birth) && birth > 0 ? `${ino}:${birth}` : null;
}

/** The slot's current lock directory (identity and mtime), or `null` when there is none. */
function lockStatOf(slotPath: string): { id: string | null; mtimeMs: number } | null {
  try {
    const st = statSync(`${slotPath}.lock`);
    return { id: lockIdentity(st.ino, st.birthtimeMs), mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The identity of a slot's current lock directory, for a holder record's
 * `lockId`, or `null` when there is no lock or it has no usable identity.
 *
 * @param slotPath - Slot lock file path.
 * @returns The lock identity, or `null`.
 *
 * @task T12963
 */
export function currentLockId(slotPath: string): string | null {
  return lockStatOf(slotPath)?.id ?? null;
}

/**
 * Write a slot's holder record. Best-effort: a failed write leaves the slot
 * unreapable (it waits out the stale timeout), never unheld.
 *
 * @param slotPath - Slot lock file path.
 * @param record - The record to write.
 *
 * @task T12963
 */
export function writeHolderRecord(slotPath: string, record: SlotHolderIdentity): void {
  try {
    writeFileSync(holderPathOf(slotPath), JSON.stringify(record), 'utf-8');
  } catch {
    /* best-effort — never fail an acquire that succeeded */
  }
}

/**
 * Keep a held slot's record listing every tool group this process starts
 * while it holds the slot. Rewrites only while the slot's lock is still the
 * one the record describes.
 *
 * @param slotPath - Slot lock file path.
 * @param record - The record as first written (its `toolGroups` are replaced).
 * @returns The groups already running (put them in the first record) and `stop`.
 *
 * @task T12963
 */
export function recordToolGroupsWhileHeld<T extends SlotHolderIdentity>(
  slotPath: string,
  record: () => T,
): { groups: readonly number[]; stop: () => void } {
  return followToolGroups((groups) => {
    const current = record();
    if (current.lockId == null || currentLockId(slotPath) !== current.lockId) return;
    writeHolderRecord(slotPath, { ...current, toolGroups: [...groups] });
  });
}

/**
 * Write the holder record for a governor slot whose lock is held, stamping it
 * with the current lock's identity.
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
  const record: GovernorSlotHolder = { ...holder, lockId: currentLockId(slotPath) };
  writeHolderRecord(slotPath, record);
  return record;
}

/**
 * Read a governor slot's holder record, or `null` when absent or malformed.
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
      !isProbeableId(parsed.pid) ||
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

/** The holder pid alone: gone, recycled, alive or unknown. */
function assessHolderPid(
  holder: SlotHolderIdentity,
  lockMtimeMs: number | null,
  probe: PidProbe,
): GovernorHolderState {
  const liveness = probe.liveness(holder.pid);
  if (liveness !== 'alive') return liveness === 'gone' ? 'dead' : 'unknown';
  // Without the lock's mtime, or while it is being refreshed, a live pid is the holder.
  if (lockMtimeMs === null || Date.now() - lockMtimeMs < LOCK_REFRESH_WINDOW_MS) return 'alive';
  if (holder.startedAt == null) return 'alive';
  const startedAt = probe.startedAt(holder.pid);
  if (startedAt === null) return 'unknown'; // ps failed: never proof of death
  return startedAt === holder.startedAt ? 'alive' : 'dead';
}

/** The holder's tool groups: `dead` only when every one is provably gone. */
function assessToolGroups(groups: unknown, probe: PidProbe): GovernorHolderState {
  if (groups === undefined) return 'dead';
  if (!Array.isArray(groups)) return 'unknown';
  let unknown = false;
  for (const pgid of groups) {
    if (!isProbeableId(pgid)) return 'unknown';
    const state = probe.groupLiveness(pgid);
    if (state === 'alive') return 'alive';
    if (state === 'unknown') unknown = true;
  }
  return unknown ? 'unknown' : 'dead';
}

/**
 * Decide whether a slot's recorded holder still holds it.
 *
 * - `dead`: the holder pid is gone, or alive with a different start time
 *   than the record's (a recycled pid), AND every tool group it started is
 *   gone.
 * - `unknown`: no record, another host's pid, a pid of 1 or below, a record
 *   that does not describe the current lock (or a lock with no identity), or
 *   a probe that failed. Never treated as dead.
 * - `alive`: otherwise, including a live pid whose start time was never
 *   recorded, and a dead holder whose tool is still running.
 *
 * A live holder's `proper-lockfile` timer refreshes the lock mtime every
 * `GOVERNOR_SLOT_STALE_MS / 2`. While the mtime is that fresh a live pid is
 * taken as the holder without asking `ps`, so a contended acquire spawns
 * nothing. A pid recycled inside that window therefore reads as alive until
 * the refresh lapses; that is the safe direction.
 *
 * @param holder - The slot's record, or `null`.
 * @param slotPath - Slot lock file path. Without it the lock identity and
 *   mtime are not consulted, so a live pid is always `alive` (report-only).
 * @param probe - Pid probe; tests inject one.
 * @returns The verdict.
 *
 * @task T12963
 */
export function assessSlotHolder(
  holder: SlotHolderIdentity | null,
  slotPath?: string,
  probe: PidProbe = defaultPidProbe,
): GovernorHolderState {
  if (holder === null || holder.host !== hostname() || !isProbeableId(holder.pid)) {
    return 'unknown';
  }
  let lockMtimeMs: number | null = null;
  if (slotPath !== undefined) {
    const lock = lockStatOf(slotPath);
    if (lock === null || lock.id === null || holder.lockId !== lock.id) return 'unknown';
    lockMtimeMs = lock.mtimeMs;
  }
  const pid = assessHolderPid(holder, lockMtimeMs, probe);
  return pid === 'dead' ? assessToolGroups(holder.toolGroups, probe) : pid;
}

/**
 * {@link assessSlotHolder} for a governor slot's record.
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
  return assessSlotHolder(holder, slotPath, probe);
}

/**
 * Free a held slot whose holder is provably dead: its pid gone or recycled
 * and every tool group it started gone.
 *
 * Runs under a per-slot guard and re-checks the holder inside it. The holder
 * record is removed with the lock, so a second reaper that takes the guard
 * afterwards finds no record (or the next holder's) and stands down. A lock
 * within {@link STALE_TAKEOVER_MARGIN_MS} of `staleMs` is left to
 * `proper-lockfile`, and the lock identity is re-read immediately before the
 * `rm`, so a concurrent stale takeover's fresh lock is never removed.
 *
 * @param slotPath - Slot lock file path.
 * @param readHolder - Reads the slot's record (the governor's or the tool semaphore's).
 * @param opts - The slot's `proper-lockfile` stale threshold, and a probe (tests).
 * @returns `true` when the slot was reaped; the caller then takes it.
 *
 * @task T12963
 */
export function reapSlotIfHolderDead(
  slotPath: string,
  readHolder: (slotPath: string) => SlotHolderIdentity | null,
  opts: { staleMs?: number; probe?: PidProbe } = {},
): boolean {
  const staleMs = opts.staleMs ?? GOVERNOR_SLOT_STALE_MS;
  const probe = opts.probe ?? defaultPidProbe;
  if (assessSlotHolder(readHolder(slotPath), slotPath, probe) !== 'dead') return false;
  let releaseGuard: () => void;
  try {
    releaseGuard = lockfile.lockSync(`${slotPath}.reap`, {
      lockfilePath: `${slotPath}.reaping`,
      stale: REAP_GUARD_STALE_MS,
      realpath: false,
    });
  } catch {
    return false; // another waiter is reaping this slot
  }
  try {
    const holder = readHolder(slotPath);
    if (holder === null || assessSlotHolder(holder, slotPath, probe) !== 'dead') return false;
    const lock = lockStatOf(slotPath);
    if (lock === null || Date.now() - lock.mtimeMs > staleMs - STALE_TAKEOVER_MARGIN_MS) {
      return false;
    }
    // Re-read the identity last: a lock replaced since the check, and the
    // record its new holder wrote, are left alone.
    if (currentLockId(slotPath) !== holder.lockId) return false;
    rmSync(holderPathOf(slotPath), { force: true });
    rmSync(`${slotPath}.lock`, { recursive: true, force: true });
    log().warn(
      { slot: slotPath, holderPid: holder.pid, toolGroups: holder.toolGroups ?? [] },
      'reaped a slot whose holder process and tool groups are gone',
    );
    return true;
  } catch {
    return false;
  } finally {
    try {
      releaseGuard();
    } catch {
      /* the guard was already released */
    }
  }
}

/**
 * Name every held governor slot and its holder, for a deferral reason.
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
    const groups = h?.toolGroups?.length ? ` with tool group(s) ${h.toolGroups.join(',')}` : '';
    held.push(
      h
        ? `${basename(path)}: pid ${h.pid} on ${h.host}${groups} since ` +
            `${new Date(h.acquiredAtMs).toISOString()} (${assessGovernorHolder(h, path)})`
        : `${basename(path)}: holder unknown`,
    );
  }
  return held.length > 0 ? `; held by ${held.join(', ')}` : '';
}

/** A grant's release: stops recording tool groups, drops our record, then the lock. Idempotent. */
function holderRelease(
  slotPath: string,
  holder: () => GovernorSlotHolder,
  stopRecording: () => void,
  unlock: () => Promise<void>,
): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    stopRecording();
    // Record first, lock second: the record must never outlive our lock and
    // end up describing the next holder's.
    const mine = holder();
    const current = readGovernorHolder(slotPath);
    if (current?.pid === mine.pid && current.acquiredAtMs === mine.acquiredAtMs) {
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
  let holder: GovernorSlotHolder;
  const recording = recordToolGroupsWhileHeld(slotPath, () => holder);
  holder = writeGovernorHolder(slotPath, {
    pid: process.pid,
    startedAt: ownProcessStartedAt(),
    host: hostname(),
    cls,
    acquiredAtMs: Date.now(),
    toolGroups: [...recording.groups],
  });
  return holderRelease(slotPath, () => holder, recording.stop, unlock);
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
  const free = await tryLockSlot(slotPath, cls);
  if (free !== null) return free;
  return reapSlotIfHolderDead(slotPath, readGovernorHolder) ? tryLockSlot(slotPath, cls) : null;
}

/**
 * Forget cached start times, this process's included. Tests only.
 * @internal
 */
export function _resetSlotHolderStateForTest(): void {
  _startCache.clear();
  _ownStartedAt = undefined;
}
