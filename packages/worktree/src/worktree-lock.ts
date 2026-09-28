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
 *   written record. Filesystems without hard links (exFAT, some network
 *   mounts) fall back to `open(O_CREAT|O_EXCL)` on the final path; a reader
 *   that meets a young, not-yet-parseable record waits instead of reclaiming.
 * - **Every acquisition failure is a refusal.** An I/O error (EACCES, EROFS,
 *   ENOSPC, ...) surfaces as `E_WORKTREE_LOCKED` with `reason:
 *   'lock-unavailable'` — never as a generic error a caller might answer with
 *   worktree cleanup.
 * - **Holder identity:** session id, agent id, device id, owner pid plus the
 *   owner's `ps lstart` start time (rendered under `PS_STABLE_ENV`), host name
 *   and a heartbeat timestamp.
 * - **Liveness:** a held lock is reclaimable only when its holder is provably
 *   dead (pid gone, or alive with a different start time = recycled pid). The
 *   heartbeat TTL applies ONLY to holders whose pid cannot be verified (another
 *   device, or no recorded start time); a verified live holder is never
 *   reclaimed on age. Anything else is `E_WORKTREE_LOCKED`.
 * - **Re-entry:** the same caller (session id, agent id, owner pid and start
 *   time all equal) re-enters its own lock, so an orchestrator can retry.
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
import { resolveStableDeviceIdPath, resolveWorktreeTaskLockPath } from '@cleocode/paths';

/** Default heartbeat TTL: 4 hours. Override with `CLEO_WORKTREE_LOCK_TTL_MS`. */
export const DEFAULT_WORKTREE_LOCK_TTL_MS = 4 * 60 * 60 * 1000;

/** Environment variable overriding {@link DEFAULT_WORKTREE_LOCK_TTL_MS}. */
export const WORKTREE_LOCK_TTL_ENV = 'CLEO_WORKTREE_LOCK_TTL_MS';

/** A reclaim mutex older than this is abandoned (its owner crashed mid-reclaim). */
const RECLAIM_MUTEX_STALE_MS = 30_000;

/** Attempts to obtain the reclaim mutex before re-evaluating the lock. */
const RECLAIM_ATTEMPTS = 50;

/** A record younger than this that does not parse is still being written (O_EXCL fallback). */
const UNREADABLE_GRACE_MS = 5_000;

/** Upper bound on acquisition passes (each pass wins, throws, waits or observes progress). */
const MAX_ACQUIRE_PASSES = 400;

/** `link(2)` errnos that mean "hard links unsupported here", not "lock held". */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV', 'EMLINK']);

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
  /** True when the holder's pid + start time were verified live on this device. */
  verified?: boolean;
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
  /** This device's id (default: the persisted `<cleoHome>/device-id`, if any). */
  deviceId?: string | null;
}

/** Error thrown when the lock is held by a live holder. */
export interface WorktreeLockedError extends Error {
  /** Always `E_WORKTREE_LOCKED`. */
  code: typeof BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED;
  /** Numeric exit code (`ExitCode.WORKTREE_LOCKED`). */
  exitCode: number;
  /** The live holder's record; `null` when the lock itself could not be taken. */
  holder: WorktreeLockRecord | null;
  /** `held` = a live holder owns it; `lock-unavailable` = the lock file could not be created or read. */
  reason: 'held' | 'lock-unavailable';
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
 * Read this device's persisted stable id (`<cleoHome>/device-id`), or `null`
 * when core has not created it yet. Never creates it.
 *
 * @returns The device id, or `null`.
 */
export function readStableDeviceId(): string | null {
  try {
    const raw = readFileSync(resolveStableDeviceIdPath(), 'utf-8').trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock's holder is live.
 *
 * - Same device (device ids equal; host names equal when either id is
 *   unknown): the pid is probed. Gone → `pid-gone`; alive with a different
 *   start time → `pid-recycled`; alive with the SAME start time → live and
 *   verified, whatever the heartbeat age (a verified live holder is never
 *   reclaimed on age — T12506 review).
 * - Unverifiable (another device, or no start time on either side): only the
 *   heartbeat TTL can release it.
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
    record.deviceId !== null && opts.deviceId !== null
      ? record.deviceId === opts.deviceId
      : record.hostname === hostname();
  if (sameDevice) {
    const liveness = opts.probe(record.pid);
    if (!liveness.alive) return { live: false, reason: 'pid-gone' };
    if (record.processStartedAt !== null && liveness.startedAt !== null) {
      if (liveness.startedAt !== record.processStartedAt) {
        return { live: false, reason: 'pid-recycled' };
      }
      return { live: true, verified: true };
    }
  }
  const heartbeat = Date.parse(record.heartbeatAt);
  if (!Number.isFinite(heartbeat) || opts.now - heartbeat > opts.ttlMs) {
    return { live: false, reason: 'heartbeat-stale' };
  }
  return { live: true, verified: false };
}

/**
 * True when `candidate` is the same caller as the lock's `holder`: session id
 * and agent id both present and equal, and the same owner process (pid and
 * start time). Only then may a spawn re-enter an existing lock.
 *
 * @param holder - Record on disk.
 * @param candidate - Record the caller would publish.
 * @returns Whether re-entry is allowed.
 */
export function isSameLockCaller(
  holder: WorktreeLockRecord,
  candidate: WorktreeLockRecord,
): boolean {
  return (
    holder.sessionId !== null &&
    holder.agentId !== null &&
    holder.sessionId === candidate.sessionId &&
    holder.agentId === candidate.agentId &&
    holder.pid === candidate.pid &&
    holder.processStartedAt !== null &&
    holder.processStartedAt === candidate.processStartedAt
  );
}

/** Result of reading a lock file. */
type LockRead =
  | { kind: 'absent' }
  | { kind: 'record'; record: WorktreeLockRecord }
  | { kind: 'unreadable'; ageMs: number };

/**
 * Read and validate the lock record at `lockPath`.
 *
 * @param lockPath - Absolute lock file path.
 * @param now - Current time (ms) used to age an unparseable file.
 * @returns What is on disk.
 */
function readLockAt(lockPath: string, now: number): LockRead {
  let raw: string;
  try {
    raw = readFileSync(lockPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    throw err;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<WorktreeLockRecord>;
    if (
      parsed.schemaVersion === 1 &&
      typeof parsed.token === 'string' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.heartbeatAt === 'string'
    ) {
      return { kind: 'record', record: parsed as WorktreeLockRecord };
    }
  } catch {
    /* fall through */
  }
  let ageMs = Number.POSITIVE_INFINITY;
  try {
    ageMs = now - statSync(lockPath).mtimeMs;
  } catch {
    /* vanished */
  }
  return { kind: 'unreadable', ageMs };
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
  try {
    const read = readLockAt(resolveWorktreeTaskLockPath(projectHash, taskId), Date.now());
    return read.kind === 'record' ? read.record : null;
  } catch {
    return null;
  }
}

/** Write `content` to `path` with `O_CREAT|O_EXCL` and fsync it. Throws EEXIST when taken. */
function writeExclusive(path: string, content: string): void {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Unlink `path`, ignoring a missing file. */
function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Serialise a record for disk. */
function serialise(record: WorktreeLockRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Publish `record` at `lockPath` iff no lock exists.
 *
 * Primary path: temp file + `link(2)` (atomic, fails with EEXIST). When the
 * filesystem has no hard links (exFAT → ENOTSUP/EPERM, ...), falls back to
 * `O_EXCL` on the final path — still exclusive, and readers treat a young
 * unparseable record as "being written".
 *
 * @returns true when this call created the lock; false when it already exists.
 * @throws Any other I/O error (the caller turns it into a refusal).
 */
function publishExclusive(lockPath: string, record: WorktreeLockRecord): boolean {
  const tmp = `${lockPath}.${record.token}.tmp`;
  writeExclusive(tmp, serialise(record));
  let linkErr: NodeJS.ErrnoException | undefined;
  try {
    linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    linkErr = err as NodeJS.ErrnoException;
  } finally {
    unlinkQuiet(tmp);
  }
  if (linkErr.code === 'EEXIST') return false;
  if (!LINK_UNSUPPORTED.has(linkErr.code ?? '')) throw linkErr;
  try {
    writeExclusive(lockPath, serialise(record));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

/** Block the thread for `ms` (bounded; used only while contending). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove an abandoned mutex only if it is still the file we judged stale:
 * rename it to a private name, then compare inodes. A mutex created in the
 * meantime by a live contender is put back rather than deleted.
 */
function breakStaleMutex(mutexPath: string, staleIno: number): void {
  const graveyard = `${mutexPath}.${randomUUID()}.stale`;
  try {
    renameSync(mutexPath, graveyard);
  } catch {
    return; // already gone
  }
  let ino = -1;
  try {
    ino = statSync(graveyard).ino;
  } catch {
    return;
  }
  if (ino === staleIno) {
    unlinkQuiet(graveyard);
    return;
  }
  try {
    linkSync(graveyard, mutexPath); // restore the live contender's mutex
  } catch {
    try {
      renameSync(graveyard, mutexPath);
    } catch {
      /* best effort */
    }
  }
  unlinkQuiet(graveyard);
}

/**
 * Take the per-lock mutex (`<lock>.reclaim`, O_EXCL, content = our token). It
 * serialises every non-create transition of the lock file (reclaim, re-entry,
 * heartbeat). A mutex older than {@link RECLAIM_MUTEX_STALE_MS} belongs to a
 * crashed holder and is broken by inode.
 *
 * @returns A release function (removes the mutex only if it is still ours),
 *   or `null` when the mutex stayed busy.
 */
function takeLockMutex(lockPath: string, now: () => number): (() => void) | null {
  const mutexPath = `${lockPath}.reclaim`;
  const token = randomUUID();
  for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
    try {
      writeExclusive(mutexPath, token);
      return () => {
        try {
          if (readFileSync(mutexPath, 'utf-8') === token) unlinkSync(mutexPath);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const st = statSync(mutexPath);
        if (now() - st.mtimeMs > RECLAIM_MUTEX_STALE_MS) breakStaleMutex(mutexPath, st.ino);
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
    `The worktree for ${taskId} belongs to a live holder (${who}). The same orchestrator ` +
    `(same session, agent and owner process) re-enters automatically. Otherwise wait for ` +
    `that holder to finish; if it is abandoned, stop process ${holder.pid} — a dead ` +
    `holder's lock is reclaimed on the next spawn and its worktree is re-attached, never ` +
    `removed. Lock file: ${lockPath}`;
  return Object.assign(
    new Error(
      `${BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED}: the worktree for task ${taskId} is locked by ` +
        `${who} since ${holder.acquiredAt}. Refusing to re-provision a live worktree.`,
    ),
    {
      code: BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED,
      exitCode: ExitCode.WORKTREE_LOCKED,
      holder,
      reason: 'held' as const,
      lockPath,
      fix,
    },
  );
}

/** Wrap an I/O failure while taking the lock as a refusal (never a cleanup trigger). */
function unavailableError(taskId: string, lockPath: string, cause: unknown): WorktreeLockedError {
  const detail =
    cause instanceof Error
      ? `${(cause as NodeJS.ErrnoException).code ?? cause.name}: ${cause.message}`
      : String(cause);
  return Object.assign(
    new Error(
      `${BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED}: could not take the worktree lock for task ` +
        `${taskId} (${detail}). Refusing to provision without it; nothing was removed.`,
    ),
    {
      code: BRANCH_LOCK_ERROR_CODES.E_WORKTREE_LOCKED,
      exitCode: ExitCode.WORKTREE_LOCKED,
      holder: null,
      reason: 'lock-unavailable' as const,
      lockPath,
      fix: `Make ${dirname(lockPath)} writable (check permissions, free space and the CLEO_HOME filesystem), then retry the spawn.`,
      cause,
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
 * Atomically acquire the per-task worktree lock: create it, re-enter it (same
 * caller), or reclaim it from a provably dead / unverifiable-and-stale holder.
 *
 * @param options - Task, holder identity, TTL and test seams.
 * @returns How the lock was obtained plus the record now on disk.
 * @throws {@link WorktreeLockedError} (`E_WORKTREE_LOCKED`) when a live holder
 *   owns the lock OR the lock could not be taken at all. Every failure of this
 *   function is a refusal: callers must never answer it with cleanup.
 */
export function acquireWorktreeTaskLock(
  options: AcquireWorktreeTaskLockOptions,
): WorktreeLockAcquisition {
  const lockPath = resolveWorktreeTaskLockPath(options.projectHash, options.taskId);
  try {
    return acquireUnchecked(options, lockPath);
  } catch (err) {
    if (isWorktreeLockedError(err)) throw err;
    throw unavailableError(options.taskId, lockPath, err);
  }
}

/** {@link acquireWorktreeTaskLock} without the refusal wrapper. */
function acquireUnchecked(
  options: AcquireWorktreeTaskLockOptions,
  lockPath: string,
): WorktreeLockAcquisition {
  const { projectHash, taskId } = options;
  const holder = options.holder ?? {};
  const now = options.now ?? Date.now;
  const probe = options.probe ?? probeProcess;
  const ttlMs = options.ttlMs ?? resolveWorktreeLockTtlMs();
  mkdirSync(dirname(lockPath), { recursive: true });

  const pid = holder.pid ?? process.pid;
  const processStartedAt =
    holder.processStartedAt !== undefined ? holder.processStartedAt : readProcessStartTime(pid);
  const deviceId =
    holder.deviceId !== undefined && holder.deviceId !== null
      ? holder.deviceId
      : options.deviceId !== undefined
        ? options.deviceId
        : readStableDeviceId();
  const stamp = new Date(now()).toISOString();
  const record: WorktreeLockRecord = {
    schemaVersion: 1,
    token: randomUUID(),
    taskId,
    projectHash,
    sessionId: holder.sessionId ?? null,
    agentId: holder.agentId ?? null,
    deviceId,
    pid,
    processStartedAt,
    hostname: hostname(),
    acquiredAt: stamp,
    heartbeatAt: stamp,
  };

  for (let pass = 0; pass < MAX_ACQUIRE_PASSES; pass++) {
    if (publishExclusive(lockPath, record)) return { status: 'acquired', lockPath, record };

    const existing = readLockAt(lockPath, now());
    if (existing.kind === 'absent') continue; // released between create and read — retry
    let status: 'reclaimed' | 'reentered';
    let reason: WorktreeLockAcquisition['reclaimReason'];
    if (existing.kind === 'unreadable') {
      if (existing.ageMs < UNREADABLE_GRACE_MS) {
        sleepSync(RECLAIM_BACKOFF_MS); // O_EXCL fallback writer mid-write
        continue;
      }
      status = 'reclaimed';
      reason = 'unreadable';
    } else if (isSameLockCaller(existing.record, record)) {
      status = 'reentered';
    } else {
      const verdict = assessWorktreeLockHolder(existing.record, {
        ttlMs,
        now: now(),
        probe,
        deviceId,
      });
      if (verdict.live) throw lockedError(taskId, lockPath, existing.record);
      status = 'reclaimed';
      reason = verdict.reason;
    }

    const release = takeLockMutex(lockPath, now);
    if (release === null) continue; // another contender is transitioning it — re-evaluate
    try {
      // Re-read under the mutex: only replace the exact record we judged.
      const current = readLockAt(lockPath, now());
      const same =
        existing.kind === 'unreadable'
          ? current.kind === 'unreadable'
          : current.kind === 'record' && current.record.token === existing.record.token;
      if (!same) continue;
      unlinkQuiet(lockPath);
      if (publishExclusive(lockPath, record)) {
        return {
          status,
          lockPath,
          record,
          ...(existing.kind === 'record' ? { reclaimedFrom: existing.record } : {}),
          ...(status === 'reclaimed' && reason ? { reclaimReason: reason } : {}),
        };
      }
    } finally {
      release();
    }
  }
  const final = readLockAt(lockPath, now());
  if (final.kind === 'record') throw lockedError(taskId, lockPath, final.record);
  throw new Error(`lock for ${taskId} stayed contended for ${MAX_ACQUIRE_PASSES} passes`);
}

/**
 * Refresh the holder's heartbeat. Only the holder that owns `token` may beat,
 * and the rewrite happens under the lock mutex after re-checking the token, so
 * it can never clobber a lock another contender reclaimed in the meantime.
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
  const release = takeLockMutex(lockPath, now);
  if (release === null) return null;
  try {
    const current = readLockAt(lockPath, now());
    if (current.kind !== 'record' || current.record.token !== token) return null;
    const next: WorktreeLockRecord = {
      ...current.record,
      heartbeatAt: new Date(now()).toISOString(),
    };
    const tmp = `${lockPath}.${token}.beat.tmp`;
    unlinkQuiet(tmp);
    writeExclusive(tmp, serialise(next));
    renameSync(tmp, lockPath);
    return next;
  } catch {
    return null;
  } finally {
    release();
  }
}

/**
 * Release the per-task lock. With `token`, only that acquisition's lock is
 * removed (a lock since reclaimed or re-entered by someone else is left alone).
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
  try {
    if (token !== undefined) {
      const current = readLockAt(lockPath, Date.now());
      if (current.kind !== 'record' || current.record.token !== token) return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}
