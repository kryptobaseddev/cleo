/**
 * Per-task worktree lock (T12506 · epic T12498 E-WORKTREE-MULTI-AGENT).
 *
 * `createWorktree` used to be check-then-act: when the task's worktree
 * directory existed and `git status --porcelain` was empty it force-removed the
 * worktree and ran `git branch -D task/<id>`. A LIVE agent's worktree looks
 * clean whenever its only changes are gitignored (`.cleo/cleo.db`) or already
 * committed, so a second `cleo orchestrate spawn <id>` deleted files out from
 * under the running agent.
 *
 * This module is the mutual-exclusion half of the fix. Before any
 * `git worktree add`, the spawner takes an atomic per-task lock:
 *
 * - **Location:** `<cleoHome>/locks/worktrees/<projectHash>/<taskId>.lock`
 *   (via `@cleocode/paths`), shared by every spawn of the task on this machine.
 * - **Atomic publish:** the record is written to a private temp file and then
 *   hard-linked into place. `link(2)` fails with `EEXIST` when the lock already
 *   exists, so exactly one contender wins and a reader never sees a partially
 *   written record.
 * - **Holder identity:** session id, agent id, device id, owner pid plus the
 *   owner's `ps lstart` start time (rendered under `PS_STABLE_ENV`), host name
 *   and a heartbeat timestamp.
 * - **Liveness:** a held lock is reclaimable only when its holder is provably
 *   dead (pid gone, or alive with a different start time = recycled pid) or its
 *   heartbeat is older than the TTL. Anything else is `E_WORKTREE_LOCKED`.
 * - **Reclaim:** serialised through a second O_EXCL "reclaim mutex" file so two
 *   contenders that both saw the same dead holder cannot both win; the winner
 *   re-reads the lock and only replaces it if it is still the record it judged.
 *
 * @module worktree-lock
 * @task T12506
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import type {
  WorktreeLockAcquisition,
  WorktreeLockHolder,
  WorktreeLockRecord,
} from '@cleocode/contracts';
import { BRANCH_LOCK_ERROR_CODES, ExitCode, PS_STABLE_ENV } from '@cleocode/contracts';
import { resolveWorktreeTaskLockPath } from '@cleocode/paths';

/** Default heartbeat TTL: 4 hours. Override with `CLEO_WORKTREE_LOCK_TTL_MS`. */
export const DEFAULT_WORKTREE_LOCK_TTL_MS = 4 * 60 * 60 * 1000;

/** Environment variable overriding {@link DEFAULT_WORKTREE_LOCK_TTL_MS}. */
export const WORKTREE_LOCK_TTL_ENV = 'CLEO_WORKTREE_LOCK_TTL_MS';

/** A reclaim mutex older than this is abandoned (its owner crashed mid-reclaim). */
const RECLAIM_MUTEX_STALE_MS = 30_000;

/** Attempts to obtain the reclaim mutex before re-evaluating the lock. */
const RECLAIM_ATTEMPTS = 50;

/** Sleep between reclaim-mutex attempts. */
const RECLAIM_BACKOFF_MS = 20;

/** Liveness snapshot of one process. */
export interface ProcessLiveness {
  /** True when the pid exists (signal 0 succeeded or was refused with EPERM). */
  alive: boolean;
  /** `ps -o lstart=` under {@link PS_STABLE_ENV}, or `null` when unprobeable. */
  startedAt: string | null;
}

/** Reads the liveness of a pid; tests inject fakes. */
export type ProcessProbe = (pid: number) => ProcessLiveness;

/** Verdict on an existing lock record. */
export interface WorktreeLockAssessment {
  /** True when the holder must be treated as live (lock not reclaimable). */
  live: boolean;
  /** Why a non-live holder is reclaimable. */
  reason?: 'pid-gone' | 'pid-recycled' | 'heartbeat-stale';
}

/** Options for {@link acquireWorktreeTaskLock}. */
export interface AcquireWorktreeTaskLockOptions {
  /** Project hash scoping the worktree. */
  projectHash: string;
  /** Task the lock guards. */
  taskId: string;
  /** Holder identity; missing pid/start default to the calling process. */
  holder?: WorktreeLockHolder;
  /** Heartbeat TTL in ms (default {@link resolveWorktreeLockTtlMs}). */
  ttlMs?: number;
  /** Process probe (default {@link probeProcess}). */
  probe?: ProcessProbe;
  /** Clock (default `Date.now`). */
  now?: () => number;
}

/** Error thrown when the lock is held by a live holder. */
export interface WorktreeLockedError extends Error {
  /** Always `E_WORKTREE_LOCKED`. */
  code: typeof BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED;
  /** Numeric exit code (`ExitCode.WORKTREE_LOCKED`). */
  exitCode: number;
  /** The live holder's record. */
  holder: WorktreeLockRecord;
  /** Absolute path of the lock file. */
  lockPath: string;
  /** Remediation hint. */
  fix: string;
}

/**
 * Resolve the heartbeat TTL: a positive integer `CLEO_WORKTREE_LOCK_TTL_MS`
 * wins, anything else falls back to {@link DEFAULT_WORKTREE_LOCK_TTL_MS}.
 *
 * @param env - Environment to read (defaults to `process.env`).
 * @returns TTL in milliseconds.
 */
export function resolveWorktreeLockTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[WORKTREE_LOCK_TTL_ENV];
  if (raw === undefined) return DEFAULT_WORKTREE_LOCK_TTL_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_WORKTREE_LOCK_TTL_MS;
}

/**
 * Read a process's start time via `ps -o lstart=` with the stable env
 * (UTC, C locale). Returns `null` on Windows or when `ps` fails.
 *
 * @param pid - Process id.
 * @returns Whitespace-normalised `lstart` string, or `null`.
 */
export function readProcessStartTime(pid: number): string | null {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...PS_STABLE_ENV },
    }).trim();
    return out === '' ? null : out.replace(/\s+/g, ' ');
  } catch {
    return null;
  }
}

/**
 * Probe whether a pid is alive and, when it is, read its start time.
 *
 * `process.kill(pid, 0)` delivers no signal: `ESRCH` means no such process,
 * `EPERM` means it exists but belongs to another user (still alive).
 *
 * @param pid - Process id.
 * @returns Liveness snapshot.
 */
export function probeProcess(pid: number): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, startedAt: null };
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EPERM') return { alive: false, startedAt: null };
  }
  return { alive: true, startedAt: readProcessStartTime(pid) };
}

/**
 * Decide whether an existing lock's holder is live.
 *
 * Reclaimable when, and only when, the holder is provably dead — its pid is
 * gone, or alive with a different recorded start time (a recycled pid) — or
 * its heartbeat is older than `ttlMs`. A holder on another device cannot have
 * its pid probed, so only the heartbeat can release it.
 *
 * @param record - The lock record on disk.
 * @param opts - TTL, clock, probe and this device's id.
 * @returns The assessment.
 */
export function assessWorktreeLockHolder(
  record: WorktreeLockRecord,
  opts: { ttlMs: number; now: number; probe: ProcessProbe; deviceId: string | null },
): WorktreeLockAssessment {
  const sameDevice =
    record.deviceId === null || opts.deviceId === null || record.deviceId === opts.deviceId;
  if (sameDevice && record.hostname === hostname()) {
    const liveness = opts.probe(record.pid);
    if (!liveness.alive) return { live: false, reason: 'pid-gone' };
    if (
      record.processStartedAt !== null &&
      liveness.startedAt !== null &&
      liveness.startedAt !== record.processStartedAt
    ) {
      return { live: false, reason: 'pid-recycled' };
    }
  }
  const heartbeat = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(heartbeat) || opts.now - heartbeat > opts.ttlMs) {
    return { live: false, reason: 'heartbeat-stale' };
  }
  return { live: true };
}

/**
 * Read and validate the lock record at `lockPath`.
 *
 * @param lockPath - Absolute lock file path.
 * @returns The record, `null` when absent, or `'unreadable'` when the file
 *   exists but does not hold a valid record.
 */
function readLockRecordAt(lockPath: string): WorktreeLockRecord | null | 'unreadable' {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorktreeLockRecord>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.token !== 'string' ||
      typeof parsed.pid !== 'number' ||
      typeof parsed.heartbeatAt !== 'string'
    ) {
      return 'unreadable';
    }
    return parsed as WorktreeLockRecord;
  } catch {
    return 'unreadable';
  }
}

/**
 * Read the current lock record for a task, if any.
 *
 * @param projectHash - Project hash.
 * @param taskId - Task id.
 * @returns The record, or `null` when no valid lock exists.
 */
export function readWorktreeTaskLock(
  projectHash: string,
  taskId: string,
): WorktreeLockRecord | null {
  const record = readLockRecordAt(resolveWorktreeTaskLockPath(projectHash, taskId));
  return record === 'unreadable' ? null : record;
}

/** Write `content` to a fresh private temp file next to `target` and fsync it. */
function writeTempFile(target: string, token: string, content: string): string {
  const tmp = `${target}.${token}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

/** Unlink `path`, ignoring a missing file. */
function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Publish `record` at `lockPath` iff no lock exists (link(2) is atomic and
 * fails with EEXIST when the name is taken).
 *
 * @returns true when this call created the lock.
 */
function publishExclusive(lockPath: string, record: WorktreeLockRecord): boolean {
  const tmp = writeTempFile(lockPath, record.token, `${JSON.stringify(record, null, 2)}\n`);
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  } finally {
    unlinkQuiet(tmp);
  }
}

/** Block the thread for `ms` (bounded, used only while contending for the reclaim mutex). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the reclaim mutex (`<lock>.reclaim`, O_EXCL). A mutex older than
 * {@link RECLAIM_MUTEX_STALE_MS} belongs to a crashed reclaimer and is removed.
 *
 * @returns A release function, or `null` when the mutex stayed busy.
 */
function takeReclaimMutex(lockPath: string, now: () => number): (() => void) | null {
  const mutexPath = `${lockPath}.reclaim`;
  for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
    try {
      closeSync(openSync(mutexPath, 'wx', 0o600));
      return () => unlinkQuiet(mutexPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (now() - statSync(mutexPath).mtimeMs > RECLAIM_MUTEX_STALE_MS) unlinkQuiet(mutexPath);
      } catch {
        /* vanished between open and stat — retry */
      }
      sleepSync(RECLAIM_BACKOFF_MS);
    }
  }
  return null;
}

/** Build the typed E_WORKTREE_LOCKED error naming the holder. */
function lockedError(
  taskId: string,
  lockPath: string,
  holder: WorktreeLockRecord,
): WorktreeLockedError {
  const who = [
    holder.sessionId ? `session ${holder.sessionId}` : null,
    holder.agentId ? `agent ${holder.agentId}` : null,
    `pid ${holder.pid}${holder.processStartedAt ? ` (started ${holder.processStartedAt} UTC)` : ''}`,
    holder.deviceId ? `device ${holder.deviceId}` : null,
    `host ${holder.hostname}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
  const fix =
    `The worktree for ${taskId} belongs to a live holder. Attach to it with ` +
    `'cleo orchestrate spawn ${taskId} --resume', or wait until the holder exits or its ` +
    `heartbeat (last ${holder.heartbeatAt}) goes stale. Lock file: ${lockPath}`;
  return Object.assign(
    new Error(
      `${BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED}: the worktree for task ${taskId} is locked by ` +
        `${who} since ${holder.acquiredAt}. Refusing to re-provision a live worktree.`,
    ),
    {
      code: BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED,
      exitCode: ExitCode.WORKTREE_LOCKED,
      holder,
      lockPath,
      fix,
    },
  );
}

/**
 * Type guard for the error thrown by {@link acquireWorktreeTaskLock}.
 *
 * @param err - Any thrown value.
 * @returns True when `err` is an `E_WORKTREE_LOCKED` error.
 */
export function isWorktreeLockedError(err: unknown): err is WorktreeLockedError {
  return (
    err instanceof Error &&
    (err as { code?: unknown }).code === BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED
  );
}

/**
 * Atomically acquire the per-task worktree lock, reclaiming it from a dead or
 * stale holder.
 *
 * @param options - Task, holder identity, TTL and test seams.
 * @returns How the lock was obtained plus the record now on disk.
 * @throws {@link WorktreeLockedError} (`E_WORKTREE_LOCKED`) when a live holder
 *   owns the lock.
 */
export function acquireWorktreeTaskLock(
  options: AcquireWorktreeTaskLockOptions,
): WorktreeLockAcquisition {
  const { projectHash, taskId } = options;
  const holder = options.holder ?? {};
  const now = options.now ?? Date.now;
  const probe = options.probe ?? probeProcess;
  const ttlMs = options.ttlMs ?? resolveWorktreeLockTtlMs();
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  mkdirSync(dirname(lockPath), { recursive: true });

  const pid = holder.pid ?? process.pid;
  const processStartedAt =
    holder.processStartedAt !== undefined ? holder.processStartedAt : readProcessStartTime(pid);
  const stamp = new Date(now()).toISOString();
  const record: WorktreeLockRecord = {
    schemaVersion: 1,
    token: randomUUID(),
    taskId,
    projectHash,
    sessionId: holder.sessionId ?? null,
    agentId: holder.agentId ?? null,
    deviceId: holder.deviceId ?? null,
    pid,
    processStartedAt,
    hostname: hostname(),
    acquiredAt: stamp,
    heartbeatAt: stamp,
  };

  // Bounded: each pass either wins, throws, or observed a lock that changed
  // under it (another contender won or released), which cannot loop forever
  // without some contender making progress.
  for (let pass = 0; pass < 8; pass++) {
    if (publishExclusive(lockPath, record)) return { status: 'acquired', lockPath, record };

    const existing = readLockRecordAt(lockPath);
    if (existing === null) continue; // released between link and read — retry
    let reason: WorktreeLockAcquisition['reclaimReason'];
    if (existing === 'unreadable') {
      reason = 'unreadable';
    } else {
      const verdict = assessWorktreeLockHolder(existing, {
        ttlMs,
        now: now(),
        probe,
        deviceId: record.deviceId,
      });
      if (verdict.live) throw lockedError(taskId, lockPath, existing);
      reason = verdict.reason;
    }

    const release = takeReclaimMutex(lockPath, now);
    if (release === null) continue; // another contender is reclaiming — re-evaluate
    try {
      // Re-read under the mutex: only replace the exact record we judged.
      const current = readLockRecordAt(lockPath);
      const same =
        current === 'unreadable'
          ? existing === 'unreadable'
          : current !== null && existing !== 'unreadable' && current.token === existing.token;
      if (!same) continue;
      unlinkQuiet(lockPath);
      if (publishExclusive(lockPath, record)) {
        return {
          status: 'reclaimed',
          lockPath,
          record,
          ...(existing !== 'unreadable' ? { reclaimedFrom: existing } : {}),
          ...(reason ? { reclaimReason: reason } : {}),
        };
      }
    } finally {
      release();
    }
  }
  const final = readLockRecordAt(lockPath);
  if (final !== null && final !== 'unreadable') throw lockedError(taskId, lockPath, final);
  throw Object.assign(
    new Error(`E_WORKTREE_LOCK_CONTENDED: could not acquire the worktree lock for ${taskId}`),
    { code: BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED, exitCode: ExitCode.WORKTREE_LOCKED },
  );
}

/**
 * Refresh the holder's heartbeat. Only the holder that owns `token` may beat.
 *
 * @param projectHash - Project hash.
 * @param taskId - Task id.
 * @param token - Token of the acquisition to refresh.
 * @param now - Clock (default `Date.now`).
 * @returns The refreshed record, or `null` when `token` no longer holds the lock.
 */
export function heartbeatWorktreeTaskLock(
  projectHash: string,
  taskId: string,
  token: string,
  now: () => number = Date.now,
): WorktreeLockRecord | null {
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  const current = readLockRecordAt(lockPath);
  if (current === null || current === 'unreadable' || current.token !== token) return null;
  const next: WorktreeLockRecord = { ...current, heartbeatAt: new Date(now()).toISOString() };
  const tmp = writeTempFile(lockPath, `${token}.beat`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, lockPath);
  return next;
}

/**
 * Release the per-task lock. With `token`, only that acquisition's lock is
 * removed (a lock since reclaimed by someone else is left alone).
 *
 * @param projectHash - Project hash.
 * @param taskId - Task id.
 * @param token - Optional token of the acquisition to release.
 * @returns True when a lock file was removed.
 */
export function releaseWorktreeTaskLock(
  projectHash: string,
  taskId: string,
  token?: string,
): boolean {
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  if (token !== undefined) {
    const current = readLockRecordAt(lockPath);
    if (current === null || current === 'unreadable' || current.token !== token) return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
