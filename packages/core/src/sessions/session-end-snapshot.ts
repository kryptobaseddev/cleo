/**
 * Session-end SQLite snapshot — requested after the session is persisted,
 * taken in a detached child process.
 *
 * ADR-013 / T5158: `.cleo/cleo.db` is not tracked in git, so ending a session
 * writes a point-in-time snapshot to `.cleo/backups/sqlite/`. Both session-end
 * paths call {@link requestSessionEndSnapshot} as their LAST step, after the
 * session row is written as ended:
 *
 *   - the CLI / dispatch path (`cleo session end`, the Claude Code Stop hook,
 *     orchestrate handoff, safestop, GC): `session/engine-ops.ts` `sessionEnd`;
 *   - the SDK path: `sessions/index.ts` `endSession`.
 *
 * The request spawns a detached, unref'd worker and returns — the command that
 * ended the session never waits for a VACUUM. At most one worker is QUEUED per
 * project: a per-project marker ({@link SESSION_END_WORKER_MARKER}) exists from
 * spawn until the worker holds the gate lock. A request that finds a live
 * marker spawns nothing ("coalesced", logged): the queued worker drops the
 * marker only once it holds the lock, and then snapshots UNCONDITIONALLY, so
 * its snapshot contains every write made before any request that coalesced
 * onto it. A generation claimed by some other snapshot while the worker waited
 * proves nothing about those requests, so the worker never counts itself
 * covered (T12508 round 5). A burst therefore keeps at most two workers alive
 * (one running, one queued) and produces at most two snapshots.
 *
 * The worker appends its outcome as one JSON line to
 * `.cleo/logs/session-end-snapshot.log`; coalesced requests are logged there
 * too.
 *
 * `CLEO_SESSION_END_SNAPSHOT=inline` runs the snapshot in-process instead
 * (bounded lock wait, generation coverage), as does a failure to spawn the
 * worker. Under vitest the default is `inline`, so unit tests do not leave
 * detached processes behind.
 *
 * @task T12508
 */

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { getLogger } from '../logger.js';
import { getCleoDir } from '../paths.js';
import {
  describeSnapshotMiss,
  SESSION_END_LOCK_WAIT_RETRIES,
  type SnapshotGateResult,
} from '../store/snapshot-gate.js';

/** Package specifier of the detached worker's compiled entry. */
const WORKER_SPECIFIER = '@cleocode/core/sessions/session-end-snapshot-entry.js';

/** Basename of the per-project "a worker is queued" marker in the backup dir. */
export const SESSION_END_WORKER_MARKER = '.session-end-worker.pending';

/**
 * A marker older than this is stale whatever its holder says. The worker
 * drops the marker as soon as it holds the gate lock, and it waits at most
 * about 90 s for that lock, so a live marker is always younger.
 */
export const SESSION_END_MARKER_STALE_MS = 2 * 60_000;

/** A process identity: pid plus its start time, so a reused pid is not mistaken for it. */
interface ProcessIdentity {
  /** Process id. */
  readonly pid: number;
  /** Start time as reported by `ps -o lstart=`, or `null` where `ps` is unavailable. */
  readonly pidStart: string | null;
}

/**
 * Content of the worker-pending marker. Written ONCE, atomically, and never
 * rewritten: the queued worker's identity goes in a per-token sidecar
 * (`<marker>.<token>.worker`), so handing the reservation to the worker can
 * never recreate a marker the worker has already dropped.
 */
interface WorkerMarker extends ProcessIdentity {
  /** Random token handed to the worker; only that worker may remove the marker. */
  readonly token: string;
}

/** How a session-end snapshot was requested. */
export interface SessionEndSnapshotRequest {
  /**
   * `detached`: a worker was spawned to take the snapshot. `coalesced`: a
   * worker was already queued (it has not taken the lock yet), so its
   * snapshot will contain this session's writes — no new worker. `inline`:
   * this process took the snapshot.
   */
  readonly mode: 'detached' | 'coalesced' | 'inline';
  /** Snapshot generation observed when the request was made (`null` = unknown). */
  readonly seenGeneration: number | null;
  /** PID of the detached child. */
  readonly pid?: number;
  /** Gate outcome, for an inline snapshot. */
  readonly result?: SnapshotGateResult | null;
}

/** Options for {@link snapshotAfterSessionEnd}. */
export interface SessionEndSnapshotOptions {
  /** Generation observed when the request was made; defaults to "now". */
  readonly seenGeneration?: number;
  /** Never treat a prefix as covered (the worker; see the module comment). */
  readonly alwaysSnapshot?: boolean;
  /** Lock retries; defaults to {@link SESSION_END_LOCK_WAIT_RETRIES} (about 6.5 s). */
  readonly lockWaitRetries?: number;
  /** Called under the gate lock before the generation is claimed. */
  readonly onLockAcquired?: () => void;
}

/**
 * Take the session-end snapshot in THIS process through the gate's
 * `required` mode. Used by the detached worker and by the inline fallback.
 *
 * Never throws. A result other than a written or covered snapshot is logged
 * at warn level with its cause.
 *
 * @param projectRoot - Project root of the ended session.
 * @param opts - Request generation and lock wait.
 * @returns The gate outcome, or `null` when no snapshot could be attempted.
 * @task T12508
 */
export async function snapshotAfterSessionEnd(
  projectRoot: string,
  opts: SessionEndSnapshotOptions = {},
): Promise<SnapshotGateResult | null> {
  const log = getLogger('session-end-snapshot');
  try {
    const { vacuumIntoBackupAll } = await import('../store/sqlite-backup.js');
    const result = await vacuumIntoBackupAll({
      cwd: projectRoot,
      mode: 'required',
      lockWaitRetries: opts.lockWaitRetries ?? SESSION_END_LOCK_WAIT_RETRIES,
      ...(opts.seenGeneration !== undefined && { seenGeneration: opts.seenGeneration }),
      ...(opts.alwaysSnapshot !== undefined && { alwaysSnapshot: opts.alwaysSnapshot }),
      ...(opts.onLockAcquired !== undefined && { onLockAcquired: opts.onLockAcquired }),
    });
    const miss = describeSnapshotMiss(result);
    if (miss) log.warn({ projectRoot, cause: miss }, 'Session-end snapshot not taken');
    // T13245: the global store (global brain, nexus, agent registry) had no
    // backup at all; it gets an hourly-debounced one here.
    const { autoGlobalBackup } = await import('../system/backup.js');
    await autoGlobalBackup();
    return result;
  } catch (err) {
    log.warn({ err, projectRoot }, 'Session-end snapshot failed');
    return null;
  }
}

/** Whether to snapshot in-process instead of in a detached child. */
function runInline(): boolean {
  const mode = process.env['CLEO_SESSION_END_SNAPSHOT'];
  if (mode === 'inline') return true;
  if (mode === 'detached') return false;
  return process.env['VITEST'] !== undefined;
}

/** Resolve the compiled worker entry, or `null` when it is not installed/built. */
function resolveWorkerEntry(): string | null {
  try {
    return createRequire(import.meta.url).resolve(WORKER_SPECIFIER);
  } catch {
    return null;
  }
}

/** Absolute path of the worker-pending marker for a project. */
export function sessionEndWorkerMarkerPath(projectRoot: string): string {
  return join(getCleoDir(projectRoot), 'backups', 'sqlite', SESSION_END_WORKER_MARKER);
}

/** Path of the sidecar holding the queued worker's identity for `token`. */
function workerSidecarPath(markerPath: string, token: string): string {
  return `${markerPath}.${token}.worker`;
}

/** Path of the session-end worker log for a project. */
function workerLogPath(projectRoot: string): string {
  return join(getCleoDir(projectRoot), 'logs', 'session-end-snapshot.log');
}

/** Whether a process with this pid exists (EPERM means it exists but is not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/**
 * Start time of a process as `ps -o lstart=` prints it (second resolution,
 * stable for the life of the process), or `null` when it cannot be read —
 * the process is gone, or `ps` is unavailable (Windows).
 */
function processStart(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
      env: { ...process.env, LC_ALL: 'C' },
    }).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/** Identity of a process that is running now. */
function identityOf(pid: number): ProcessIdentity {
  return { pid, pidStart: processStart(pid) };
}

/**
 * Whether `who` is still the process that recorded it: its pid is alive and,
 * where start times are available, the pid's current start time matches. A
 * reused pid (or pid 1, always alive) with a different start time is not.
 */
function isSameLiveProcess(who: ProcessIdentity): boolean {
  if (!isPidAlive(who.pid)) return false;
  if (who.pidStart === null) return true; // Recorded without `ps`: liveness only.
  const now = processStart(who.pid);
  return now === null ? true : now === who.pidStart;
}

/** Parse a JSON process identity (and token), or `null` when malformed. */
function parseIdentity(text: string): (ProcessIdentity & { token?: string }) | null {
  try {
    const v: { pid?: number; pidStart?: string | null; token?: string } | null = JSON.parse(text);
    if (!v || typeof v.pid !== 'number') return null;
    const pidStart = typeof v.pidStart === 'string' ? v.pidStart : null;
    return typeof v.token === 'string'
      ? { pid: v.pid, pidStart, token: v.token }
      : { pid: v.pid, pidStart };
  } catch {
    return null;
  }
}

/** Read the marker, or `null` when it is missing or malformed. */
function readWorkerMarker(path: string): WorkerMarker | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  const v = parseIdentity(text);
  return v?.token === undefined ? null : { token: v.token, pid: v.pid, pidStart: v.pidStart };
}

/** Read the queued worker's identity for `token`, or `null` when not yet handed over. */
function readWorkerSidecar(markerPath: string, token: string): ProcessIdentity | null {
  try {
    return parseIdentity(readFileSync(workerSidecarPath(markerPath, token), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Whether the marker names a worker that is still queued: it is younger than
 * {@link SESSION_END_MARKER_STALE_MS}, and its holder — the worker named in
 * the sidecar, or else the requester still handing over — is the same live
 * process that recorded it.
 */
function isMarkerLive(path: string): boolean {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (ageMs > SESSION_END_MARKER_STALE_MS) return false;
  const marker = readWorkerMarker(path);
  if (!marker) return false;
  return isSameLiveProcess(readWorkerSidecar(path, marker.token) ?? marker);
}

/** Write `text` to `path` atomically: a unique temp file, then rename. */
function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Create the marker atomically and exclusively: write it complete to a temp
 * file, then `link()` it into place — the link fails with EEXIST if a marker
 * exists, and no reader ever sees a partial marker. Where hard links are not
 * supported, falls back to an O_EXCL create. Returns `false` when a marker
 * already exists.
 */
function tryCreateMarker(path: string, marker: WorkerMarker): boolean {
  const body = JSON.stringify(marker);
  const tmp = `${path}.${marker.token}.new`;
  try {
    writeFileSync(tmp, body);
    try {
      linkSync(tmp, path);
      return true;
    } catch (err) {
      if (!(err instanceof Error && 'code' in err)) throw err;
      if (err.code === 'EEXIST') return false;
      if (!['EPERM', 'ENOTSUP', 'EXDEV', 'EMLINK'].includes(String(err.code))) throw err;
    }
    let fd: number;
    try {
      fd = openSync(path, 'wx');
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'EEXIST') return false;
      throw err;
    }
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
    return true;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Remove the marker and its worker sidecar. */
function removeMarker(path: string, token: string | null): void {
  rmSync(path, { force: true });
  if (token !== null) rmSync(workerSidecarPath(path, token), { force: true });
}

/** Remove worker sidecars that do not belong to the current marker's token. */
function removeOrphanSidecars(path: string, currentToken: string): void {
  try {
    const dir = dirname(path);
    const prefix = `${SESSION_END_WORKER_MARKER}.`;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith('.worker')) continue;
      if (name === `${prefix}${currentToken}.worker`) continue;
      rmSync(join(dir, name), { force: true });
    }
  } catch {
    // Orphans are harmless: a sidecar is read only for the current token.
  }
}

/**
 * Reserve the right to spawn the session-end worker for this project.
 * Returns the reservation, or `null` when a live worker is already queued.
 * A stale marker (holder gone or replaced, or older than
 * {@link SESSION_END_MARKER_STALE_MS}) is removed and the reservation retried
 * once.
 */
function reserveWorkerMarker(path: string): WorkerMarker | null {
  const marker: WorkerMarker = { token: randomUUID(), ...identityOf(process.pid) };
  let created = tryCreateMarker(path, marker);
  if (!created) {
    if (isMarkerLive(path)) return null;
    removeMarker(path, readWorkerMarker(path)?.token ?? null);
    created = tryCreateMarker(path, marker);
  }
  if (!created) return null;
  removeOrphanSidecars(path, marker.token);
  return marker;
}

/**
 * Record the spawned worker as the marker's holder, so the marker stays live
 * after this (short-lived) requester exits. Writes only the per-token sidecar,
 * atomically; the marker itself is never touched, so if the worker has already
 * dropped the marker (it holds the lock and is about to snapshot) nothing is
 * recreated and later requests correctly spawn the next worker.
 */
function handMarkerToWorker(path: string, token: string, worker: ProcessIdentity): void {
  try {
    writeAtomic(workerSidecarPath(path, token), JSON.stringify(worker));
  } catch {
    // Without the sidecar the marker goes stale when this requester exits.
  }
}

/**
 * Remove the worker-pending marker if it still carries `token` — i.e. it was
 * created for this worker and not replaced after being judged stale — and the
 * worker's sidecar. Called by the worker under the gate lock, before it
 * snapshots, and again when it exits. Never throws.
 *
 * @param projectRoot - Project whose marker to release.
 * @param token - Token the worker was spawned with.
 * @task T12508
 */
export function releaseSessionEndWorkerMarker(projectRoot: string, token: string): void {
  try {
    const path = sessionEndWorkerMarkerPath(projectRoot);
    if (readWorkerMarker(path)?.token === token) rmSync(path, { force: true });
    rmSync(workerSidecarPath(path, token), { force: true });
  } catch {
    // Best-effort: a leftover marker goes stale within minutes.
  }
}

/** Append one line to the worker log recording a coalesced request. Never throws. */
function logCoalesced(projectRoot: string, markerPath: string): void {
  try {
    const marker = readWorkerMarker(markerPath);
    const holder = marker ? (readWorkerSidecar(markerPath, marker.token) ?? marker) : null;
    const log = workerLogPath(projectRoot);
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(
      log,
      `${JSON.stringify({
        event: 'session-end-snapshot-coalesced',
        at: new Date().toISOString(),
        pid: process.pid,
        projectRoot,
        queuedWorkerPid: holder?.pid ?? null,
      })}\n`,
    );
  } catch {
    // Logging is best-effort.
  }
}

/**
 * Request the session-end snapshot. Call it as the LAST step of ending a
 * session, after the session row is persisted as ended.
 *
 * Unless a worker is already queued for this project, spawns a detached,
 * unref'd worker that takes the snapshot, and returns immediately. A request
 * that finds a live marker spawns nothing and is logged as coalesced (see the
 * module comment for why that is safe). Falls back to an inline snapshot
 * (bounded lock wait) when the worker cannot be spawned. Never throws.
 *
 * @param projectRoot - Project root of the ended session.
 * @returns How the snapshot was requested.
 * @task T12508
 */
export async function requestSessionEndSnapshot(
  projectRoot: string,
): Promise<SessionEndSnapshotRequest> {
  const log = getLogger('session-end-snapshot');
  let seenGeneration: number | null = null;
  try {
    const { readProjectSnapshotGeneration } = await import('../store/sqlite-backup.js');
    seenGeneration = await readProjectSnapshotGeneration(projectRoot);
  } catch {
    // Unknown generation: an inline snapshot is then never considered covered.
  }
  const inlineOpts: SessionEndSnapshotOptions = seenGeneration === null ? {} : { seenGeneration };

  const entry = runInline() ? null : resolveWorkerEntry();
  if (entry !== null) {
    let marker: WorkerMarker | null = null;
    try {
      const backupDir = join(getCleoDir(projectRoot), 'backups', 'sqlite');
      mkdirSync(backupDir, { recursive: true });
      const markerPath = sessionEndWorkerMarkerPath(projectRoot);
      marker = reserveWorkerMarker(markerPath);
      if (marker === null) {
        logCoalesced(projectRoot, markerPath);
        return { mode: 'coalesced', seenGeneration };
      }

      const logFile = workerLogPath(projectRoot);
      mkdirSync(dirname(logFile), { recursive: true });
      const fd = openSync(logFile, 'a');
      try {
        const child = spawn(process.execPath, [entry, projectRoot, marker.token], {
          detached: true,
          stdio: ['ignore', fd, fd],
          cwd: projectRoot,
          env: process.env,
        });
        // A spawn failure is emitted asynchronously; without a listener it
        // would be an uncaught error in the process ending the session.
        child.on('error', (err) =>
          log.warn({ err, projectRoot }, 'Session-end snapshot worker failed'),
        );
        child.unref();
        if (child.pid !== undefined) {
          handMarkerToWorker(markerPath, marker.token, identityOf(child.pid));
          return { mode: 'detached', seenGeneration, pid: child.pid };
        }
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      log.warn({ err, projectRoot }, 'Could not spawn session-end snapshot worker; running inline');
    }
    if (marker !== null) releaseSessionEndWorkerMarker(projectRoot, marker.token);
  }

  const result = await snapshotAfterSessionEnd(projectRoot, inlineOpts);
  return { mode: 'inline', seenGeneration, result };
}
