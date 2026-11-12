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
 *   dead: its CLEO session has ended (T13425; the recorded owner pid is often a
 *   long-lived agent harness that outlives every session it hosts), its pid is
 *   gone, or the pid is alive with a different start time (recycled). The
 *   heartbeat TTL applies ONLY to holders whose pid cannot be verified (another
 *   device, or no recorded start time); a verified live holder is never
 *   reclaimed on age. Anything else is `E_WORKTREE_LOCKED`.
 * - **Re-entry:** the same caller (session id, agent id, owner pid and start
 *   time all equal) re-enters its own lock, so an orchestrator can retry.
 * - **Every lock-file write is serialised** through a mutex: an exclusive OS
 *   advisory lock on an open descriptor of `<lock>.flock` (T14491, via the
 *   worktree-napi `tryLockFile` binding): publish, re-entry, reclaim,
 *   heartbeat, release and session-end release (T14407). A holder of the mutex
 *   (a dispose under {@link withWorktreeTaskLockHeld}) therefore sees no lock
 *   transition at all until it lets go. The OS frees the mutex when its holder
 *   exits, so it has no staleness test and is never broken. During the
 *   transition from CLEO v2026.11.1 it also takes that release's O_EXCL
 *   `<lock>.reclaim` mutex, so old and new processes exclude each other.
 *
 * @module worktree-lock
 * @task T12506
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { threadId } from 'node:worker_threads';
import type {
  WorktreeLockAcquisition,
  WorktreeLockHolder,
  WorktreeLockRecord,
  WorktreeLockSessionProbe,
} from '@cleocode/contracts';
import { BRANCH_LOCK_ERROR_CODES } from '@cleocode/contracts/branch-lock.js';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { PS_STABLE_ENV } from '@cleocode/contracts/process-probe.js';
import { resolveStableDeviceIdPath, resolveWorktreeTaskLockPath } from '@cleocode/paths';
import { type FileLockHandleNapi, tryLockFile } from './napi-binding.js';

/** Default heartbeat TTL: 4 hours. Override with `CLEO_WORKTREE_LOCK_TTL_MS`. */
export const DEFAULT_WORKTREE_LOCK_TTL_MS = 4 * 60 * 60 * 1000;

/** Environment variable overriding {@link DEFAULT_WORKTREE_LOCK_TTL_MS}. */
export const WORKTREE_LOCK_TTL_ENV = 'CLEO_WORKTREE_LOCK_TTL_MS';

/** Attempts to obtain the lock mutex before reporting it busy. */
const RECLAIM_ATTEMPTS = 50;

/** A record younger than this that does not parse is still being written (O_EXCL fallback). */
const UNREADABLE_GRACE_MS = 5_000;

/** Upper bound on acquisition passes (each pass wins, throws, waits or observes progress). */
const MAX_ACQUIRE_PASSES = 400;

/** `link(2)` errnos that mean "hard links unsupported here", not "lock held". */
const LINK_UNSUPPORTED = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'ENOSYS', 'EXDEV', 'EMLINK']);

/** Sleep between lock-mutex attempts. */
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
  reason?: 'pid-gone' | 'pid-recycled' | 'heartbeat-stale' | 'session-ended';
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
  /** The existing holder's session state (T13425); absent = pid and heartbeat only. */
  sessionProbe?: WorktreeLockSessionProbe;
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
 * - Same device, holder session reported `ended` by `sessionProbe`: reclaimable
 *   (`session-ended`) even while the owner pid lives. The pid is usually the
 *   agent harness, which hosts many sessions in turn (T13425).
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
  opts: {
    ttlMs: number;
    now: number;
    probe: ProcessProbe;
    deviceId: string | null;
    sessionProbe?: WorktreeLockSessionProbe;
  },
): WorktreeLockAssessment {
  const sameDevice =
    record.deviceId !== null && opts.deviceId !== null
      ? record.deviceId === opts.deviceId
      : record.hostname === hostname();
  if (
    sameDevice &&
    record.sessionId !== null &&
    opts.sessionProbe !== undefined &&
    opts.sessionProbe(record.sessionId) === 'ended'
  ) {
    return { live: false, reason: 'session-ended' };
  }
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

/** Mutex paths this thread holds now (a nested take reports busy at once). */
const heldMutexes = new Set<string>();

/**
 * Path of the mutex guarding `lockPath`. It is a different file from the
 * pre-T14491 O_EXCL mutex (`<lock>.reclaim`), so a stale one of those never
 * blocks the OS lock. The file is never deleted (see {@link tryLockFile}).
 */
function mutexPathFor(lockPath: string): string {
  return `${lockPath}.flock`;
}

/**
 * Path of the pre-T14491 O_EXCL mutex that CLEO v2026.11.1 and older take
 * around every lock transition and dispose. Taken too during the transition.
 */
function legacyMutexPathFor(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

/** This process's start time, read once (a `ps` call). */
let ownStartTime: string | null | undefined;

/**
 * Content of a pre-T14491 `.reclaim` mutex or `.reclaim.break` breaker file,
 * as CLEO v2026.11.1 writes it. Every field is optional on read: older writers
 * left a bare token.
 */
interface LegacyMutexFile {
  token: string;
  pid: number;
  processStartedAt: string | null;
  threadId: number;
}

/** The holder a legacy file names: the {@link LegacyMutexFile} fields liveness is judged by. */
type LegacyHolder = Pick<LegacyMutexFile, 'pid' | 'processStartedAt'>;

/** A legacy file as read through one descriptor: content and identity belong together. */
interface LegacyFileSnapshot {
  raw: string;
  dev: bigint;
  ino: bigint;
}

/** Liveness of a legacy file's holder by the old release's own rule. */
type LegacyHolderState = 'alive' | 'dead' | 'unknown';

/**
 * Raised when a legacy breaker file names a dead holder: only a human (or the
 * old release itself) may remove it, never this release (T14491).
 */
export class LegacyMutexStaleError extends Error {
  /** Always `E_WORKTREE_LEGACY_MUTEX_STALE`. */
  readonly code = 'E_WORKTREE_LEGACY_MUTEX_STALE';
  /** Absolute path of the abandoned file. */
  readonly stalePath: string;
  /** Remediation for the operator. */
  readonly fix: string;

  /**
   * @param stalePath - The abandoned legacy file.
   * @param pid - The dead holder's pid, when the file names one.
   */
  constructor(stalePath: string, pid: number | null) {
    super(
      `an older CLEO left an abandoned worktree lock breaker at ${stalePath}` +
        `${pid === null ? '' : ` (holder pid ${pid} is gone)`}`,
    );
    this.name = 'LegacyMutexStaleError';
    this.stalePath = stalePath;
    this.fix =
      `An older CLEO (v2026.11.1 or earlier) crashed while breaking a worktree lock and left ${stalePath}. ` +
      'Stop every older CLEO process on this machine (or upgrade it), then remove the file by hand: ' +
      `rm '${stalePath}' — and retry. This release never removes another process's breaker.`;
  }
}

/** Read a legacy file's content and identity through one descriptor, or `null` when missing. */
function readLegacySnapshot(path: string): LegacyFileSnapshot | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const raw = readFileSync(fd, 'utf-8');
    const st = fstatSync(fd, { bigint: true });
    return { raw, dev: st.dev, ino: st.ino };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** True when `b` is still the very file `a` read: same identity and content. */
function sameLegacyFile(a: LegacyFileSnapshot, b: LegacyFileSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.raw === b.raw;
}

/** The holder pid a legacy file names, or `null` (bare token, partial write). */
function legacyHolderPid(raw: string): LegacyHolder | null {
  let parsed: Partial<LegacyMutexFile>;
  try {
    parsed = JSON.parse(raw) as Partial<LegacyMutexFile>;
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || typeof parsed.pid !== 'number') return null;
  return {
    pid: parsed.pid,
    processStartedAt: typeof parsed.processStartedAt === 'string' ? parsed.processStartedAt : null,
  };
}

/**
 * Judge a legacy file's holder. `dead` only when its pid is gone, or alive with
 * a different start time (recycled). A live pid whose start time cannot be
 * compared is `alive`; a file naming no pid is `unknown` (it may be mid-write).
 */
function legacyHolderState(raw: string): LegacyHolderState {
  const holder = legacyHolderPid(raw);
  if (holder === null) return 'unknown';
  const liveness = probeProcess(holder.pid);
  if (!liveness.alive) return 'dead';
  if (
    holder.processStartedAt !== null &&
    liveness.startedAt !== null &&
    liveness.startedAt !== holder.processStartedAt
  ) {
    return 'dead';
  }
  return 'alive';
}

/** This process's holder record for a legacy file (live pid, so an old breaker never removes it). */
function ownLegacyContent(): string {
  if (ownStartTime === undefined) ownStartTime = readProcessStartTime(process.pid);
  return JSON.stringify({
    token: randomUUID(),
    pid: process.pid,
    processStartedAt: ownStartTime,
    threadId,
  } satisfies LegacyMutexFile);
}

/** Remove `path` only while it still holds `content` (a file this process created). */
function removeOwnLegacyFile(path: string, content: string): void {
  try {
    if (readFileSync(path, 'utf-8') === content) unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Take the legacy `<lock>.reclaim` mutex the way CLEO v2026.11.1 and older do
 * (O_EXCL create, live holder record as content), so old and new processes
 * exclude each other while both run on one machine (T14491). The caller holds
 * the OS lock, so new-release processes never race each other here.
 *
 * A `.reclaim` that exists is never removed while its holder lives. A dead one
 * (pid gone or recycled, which is how a SIGKILLed holder of either release
 * leaves it) is broken only through the old release's own break protocol:
 * {@link breakDeadLegacyMutex}.
 *
 * TRANSITIONAL: delete with the interlock once no CLEO older than T14491 can run.
 *
 * @returns A release function (removes only the file this call created), or
 *   `null` when the legacy mutex is held or was just broken (retry).
 * @throws {@link LegacyMutexStaleError} on an abandoned foreign breaker; any
 *   I/O error other than EEXIST (fail closed).
 */
function takeLegacyMutex(legacyPath: string): (() => void) | null {
  const content = ownLegacyContent();
  try {
    writeExclusive(legacyPath, content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const seen = readLegacySnapshot(legacyPath);
    if (seen !== null && legacyHolderState(seen.raw) === 'dead') {
      breakDeadLegacyMutex(legacyPath, seen);
    }
    return null;
  }
  return () => removeOwnLegacyFile(legacyPath, content);
}

/**
 * Break a dead `.reclaim` under the old release's breaker lock
 * `<lock>.reclaim.break` (T14491). The breaker is created with O_EXCL and names
 * this live process, so an old breaker never removes it; under it `.reclaim`
 * is re-read through one descriptor and unlinked only while it is still the
 * same dead file. `.reclaim` can only disappear under a breaker and O_EXCL
 * never replaces it, so a live replacement can never be unlinked here, and
 * this release never unlinks a live file of any process. Only the breaker this
 * call created is removed. A foreign breaker is never removed: a live one means
 * wait, a dead one is reported with {@link LegacyMutexStaleError}.
 *
 * Residual race (accepted for the transition, owner decision D11244): two OLD
 * processes recovering the same dead foreign breaker can, between them, unlink
 * the breaker this call has just created; that needs a crashed old breaker and
 * two old contenders, and is the race old releases already have among
 * themselves.
 *
 * @throws {@link LegacyMutexStaleError} when a dead foreign breaker blocks the break.
 */
function breakDeadLegacyMutex(legacyPath: string, seen: LegacyFileSnapshot): void {
  const breakerPath = `${legacyPath}.break`;
  const content = ownLegacyContent();
  try {
    writeExclusive(breakerPath, content);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const breaker = readLegacySnapshot(breakerPath);
    if (breaker !== null && legacyHolderState(breaker.raw) === 'dead') {
      throw new LegacyMutexStaleError(breakerPath, legacyHolderPid(breaker.raw)?.pid ?? null);
    }
    return; // a live (or mid-write) breaker: wait
  }
  try {
    const current = readLegacySnapshot(legacyPath);
    if (
      current !== null &&
      sameLegacyFile(current, seen) &&
      legacyHolderState(current.raw) === 'dead'
    ) {
      unlinkQuiet(legacyPath);
    }
  } finally {
    removeOwnLegacyFile(breakerPath, content);
  }
}

/**
 * Take the per-lock mutex: an exclusive OS advisory lock held on an open file
 * descriptor of `<lock>.flock` (T14491). It serialises every write of the lock
 * file (publish, reclaim, re-entry, heartbeat, release) and the whole of
 * {@link withWorktreeTaskLockHeld}.
 *
 * The OS releases it when the holder releases it or exits, however it exits,
 * so the OS lock has no staleness test, no break and no breaker: a crashed
 * holder frees it by dying, and a live one is never displaced. A mutex this
 * very thread holds is reported busy at once: waiting would block the holder,
 * which can never release it.
 *
 * While older CLEO releases may still run, the legacy `<lock>.reclaim` mutex is
 * also taken under the OS lock ({@link takeLegacyMutex}), so a dispose by an
 * old process and a transition by a new one never overlap.
 *
 * @returns A release function, or `null` when the mutex stayed busy.
 * @throws When the lock file cannot be opened or locked, or the native binding
 *   lacks the lock (fail closed: callers refuse, they never proceed unlocked).
 */
function takeLockMutex(lockPath: string): (() => void) | null {
  const mutexPath = mutexPathFor(lockPath);
  if (heldMutexes.has(mutexPath)) return null;
  for (let attempt = 0; attempt < RECLAIM_ATTEMPTS; attempt++) {
    const handle = tryLockFile(mutexPath);
    if (handle !== null) {
      let releaseLegacy: (() => void) | null;
      try {
        releaseLegacy = takeLegacyMutex(legacyMutexPathFor(lockPath));
      } catch (err) {
        releaseOsLock(handle);
        throw err;
      }
      if (releaseLegacy !== null) {
        heldMutexes.add(mutexPath);
        const legacy = releaseLegacy;
        return () => {
          heldMutexes.delete(mutexPath);
          legacy();
          releaseOsLock(handle);
        };
      }
      releaseOsLock(handle);
    }
    sleepSync(RECLAIM_BACKOFF_MS);
  }
  return null;
}

/** Release an OS lock handle; a failed unlock still closes the descriptor, which releases it. */
function releaseOsLock(handle: FileLockHandleNapi): void {
  try {
    handle.release();
  } catch {
    /* the descriptor is closed either way, which releases the lock */
  }
}

/**
 * Unlink the lock file when `matches` accepts what is on disk. The caller
 * holds the lock mutex.
 *
 * @returns What was removed, or `null` when nothing was (absent, rejected or an I/O error).
 */
function unlinkLockIf(lockPath: string, matches: (read: LockRead) => boolean): LockRead | null {
  try {
    const current = readLockAt(lockPath, Date.now());
    if (current.kind === 'absent' || !matches(current)) return null;
    unlinkSync(lockPath);
    return current;
  } catch {
    return null;
  }
}

/**
 * {@link unlinkLockIf} under the lock mutex. A busy mutex or an I/O error
 * removes nothing (fail closed: the lock stays).
 */
function releaseLockIf(lockPath: string, matches: (read: LockRead) => boolean): LockRead | null {
  let release: (() => void) | null;
  try {
    release = takeLockMutex(lockPath);
  } catch {
    return null;
  }
  if (release === null) return null;
  try {
    return unlinkLockIf(lockPath, matches);
  } finally {
    release();
  }
}

/** Outcome of {@link withWorktreeTaskLockHeld}. */
export type WorktreeTaskLockHold<T> = { held: true; value: T } | { held: false; reason: string };

/**
 * Run `fn` while `token` provably holds the task lock (T14407).
 *
 * Takes the same mutex every lock transition takes, re-reads the lock under
 * it, and runs `fn` only when the record on disk carries `token`; the mutex is
 * held until `fn` returns, so no re-entry or reclaim can replace the lock in
 * between. Fails closed: a busy mutex, a missing, unreadable or foreign lock,
 * or a read error means `fn` never runs. `fn` must not take the lock mutex
 * itself (every lock-file write does); it releases the lock through the
 * `releaseLock` callback it receives, which removes it only while it still
 * carries `token`.
 *
 * @param projectHash - Project hash.
 * @param taskId - Task id.
 * @param token - Token of the acquisition that must hold the lock.
 * @param fn - Work to do while the lock is held; receives the record and a
 *   `releaseLock` callback (true when it removed the lock).
 * @param now - Clock (default `Date.now`).
 * @returns `fn`'s value, or why it did not run.
 */
export function withWorktreeTaskLockHeld<T>(
  projectHash: string,
  taskId: string,
  token: string,
  fn: (record: WorktreeLockRecord, releaseLock: () => boolean) => T,
  now: () => number = Date.now,
): WorktreeTaskLockHold<T> {
  const lockPath = resolveWorktreeTaskLockPath(projectHash, taskId);
  let release: (() => void) | null;
  try {
    release = takeLockMutex(lockPath);
  } catch (err) {
    return { held: false, reason: `the lock mutex could not be taken (${String(err)})` };
  }
  if (release === null) return { held: false, reason: 'the lock mutex stayed busy' };
  try {
    let current: LockRead;
    try {
      current = readLockAt(lockPath, now());
    } catch (err) {
      return { held: false, reason: `the task lock could not be read (${String(err)})` };
    }
    if (current.kind === 'absent') return { held: false, reason: 'the task lock was released' };
    if (current.kind === 'unreadable')
      return { held: false, reason: 'the task lock is unreadable' };
    if (current.record.token !== token) {
      return { held: false, reason: 'the task lock passed to another acquisition' };
    }
    const releaseLock = (): boolean =>
      unlinkLockIf(lockPath, (r) => r.kind === 'record' && r.record.token === token) !== null;
    return { held: true, value: fn(current.record, releaseLock) };
  } finally {
    release();
  }
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
      fix:
        cause instanceof LegacyMutexStaleError
          ? cause.fix
          : `Make ${dirname(lockPath)} writable (check permissions, free space and the CLEO_HOME filesystem), then retry the spawn.`,
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

  let backoff = false;
  for (let pass = 0; pass < MAX_ACQUIRE_PASSES; pass++) {
    if (backoff) sleepSync(RECLAIM_BACKOFF_MS); // O_EXCL fallback writer mid-write
    backoff = false;
    // Every write of the lock file happens under its mutex (T14407).
    const release = takeLockMutex(lockPath);
    if (release === null) {
      // Someone is transitioning or disposing the lock: refuse, naming its holder.
      const busy = readLockAt(lockPath, now());
      if (busy.kind === 'record') throw lockedError(taskId, lockPath, busy.record);
      continue;
    }
    try {
      if (publishExclusive(lockPath, record)) return { status: 'acquired', lockPath, record };

      const existing = readLockAt(lockPath, now());
      if (existing.kind === 'absent') continue; // released between create and read — retry
      let status: 'reclaimed' | 'reentered';
      let reason: WorktreeLockAcquisition['reclaimReason'];
      if (existing.kind === 'unreadable') {
        if (existing.ageMs < UNREADABLE_GRACE_MS) {
          backoff = true;
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
          ...(options.sessionProbe ? { sessionProbe: options.sessionProbe } : {}),
        });
        if (verdict.live) throw lockedError(taskId, lockPath, existing.record);
        status = 'reclaimed';
        reason = verdict.reason;
      }

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
  const release = takeLockMutex(lockPath);
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
 * Release the per-task lock under its mutex (T14407). With `token`, only that
 * acquisition's lock is removed (a lock since reclaimed or re-entered by
 * someone else is left alone). A busy mutex removes nothing. Inside
 * {@link withWorktreeTaskLockHeld}, use the `releaseLock` callback instead.
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
  return (
    releaseLockIf(
      lockPath,
      (r) => token === undefined || (r.kind === 'record' && r.record.token === token),
    ) !== null
  );
}

/**
 * Release every per-task worktree lock of a project whose holder is
 * `sessionId` (T13425): `cleo session end` frees the worktrees that session
 * holds, so a successor's `--resume` is not refused while the harness pid that
 * spawned it lives on. Each lock is re-checked and removed under its mutex, so
 * a lock another holder took in the meantime is left alone (T14407).
 *
 * @param projectHash - Project hash.
 * @param sessionId - The ended session.
 * @returns The released locks' records.
 */
export function releaseWorktreeTaskLocksForSession(
  projectHash: string,
  sessionId: string,
): WorktreeLockRecord[] {
  const dir = dirname(resolveWorktreeTaskLockPath(projectHash, '_'));
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.lock'));
  } catch {
    return [];
  }
  const released: WorktreeLockRecord[] = [];
  for (const name of names) {
    const taskId = name.slice(0, -'.lock'.length);
    const seen = readWorktreeTaskLock(projectHash, taskId);
    if (seen === null || seen.sessionId !== sessionId) continue;
    const removed = releaseLockIf(
      resolveWorktreeTaskLockPath(projectHash, taskId),
      (r) => r.kind === 'record' && r.record.sessionId === sessionId,
    );
    if (removed?.kind === 'record') released.push(removed.record);
  }
  return released;
}
