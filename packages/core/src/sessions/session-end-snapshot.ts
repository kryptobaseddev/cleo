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
 * The request reads the current snapshot GENERATION (see
 * `store/snapshot-gate.ts`) and hands it to a detached, unref'd child process,
 * then returns — the command that ended the session never waits for a VACUUM.
 * The child runs the gate's `required` mode with that generation: it waits for
 * the project-wide lock, and it is satisfied by any snapshot that started
 * after the request. A burst of session ends therefore produces one snapshot
 * (plus at most one trailing snapshot for requests made while it ran). The
 * child appends its outcome as one JSON line to
 * `.cleo/logs/session-end-snapshot.log`.
 *
 * `CLEO_SESSION_END_SNAPSHOT=inline` runs the snapshot in-process instead
 * (bounded lock wait), as does a failure to spawn the child. Under vitest the
 * default is `inline`, so unit tests do not leave detached processes behind.
 *
 * @task T12508
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
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
 * A marker older than this is stale whatever its pid says. The worker drops
 * the marker as soon as it holds the gate lock, and it waits at most about
 * 90 s for that lock, so a live marker is always younger.
 */
export const SESSION_END_MARKER_STALE_MS = 2 * 60_000;

/** Content of the worker-pending marker. */
interface WorkerMarker {
  /** Random token handed to the worker; only that worker may remove the marker. */
  readonly token: string;
  /** PID of the queued worker (the requester's PID until the worker is spawned). */
  readonly pid: number;
}

/** How a session-end snapshot was requested. */
export interface SessionEndSnapshotRequest {
  /**
   * `detached`: a worker was spawned to take the snapshot. `coalesced`: a
   * worker was already queued and has not claimed its generation yet, so its
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
      ...(opts.onLockAcquired !== undefined && { onLockAcquired: opts.onLockAcquired }),
    });
    const miss = describeSnapshotMiss(result);
    if (miss) log.warn({ projectRoot, cause: miss }, 'Session-end snapshot not taken');
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

/** Whether a process with this pid exists (EPERM means it exists but is not ours). */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'EPERM';
  }
}

/** Read the marker, or `null` when it is missing or unreadable. */
function readWorkerMarker(path: string): WorkerMarker | null {
  try {
    const parsed: Partial<WorkerMarker> | null = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed.token === 'string' && typeof parsed.pid === 'number') {
      return { token: parsed.token, pid: parsed.pid };
    }
  } catch {
    // Missing, partially written, or corrupt.
  }
  return null;
}

/**
 * Whether the marker names a worker that is still queued: its pid is alive
 * and the marker is younger than {@link SESSION_END_MARKER_STALE_MS}. A
 * marker being written right now (unreadable, but brand new) counts as live.
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
  if (!marker) return ageMs < 5_000;
  return isPidAlive(marker.pid);
}

/** Create the marker with O_EXCL. Returns `false` when it already exists. */
function tryCreateMarker(path: string, marker: WorkerMarker): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'wx');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify(marker));
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * Reserve the right to spawn the session-end worker for this project.
 * Returns the reservation, or `null` when a live worker is already queued.
 * A stale marker (dead pid, or older than {@link SESSION_END_MARKER_STALE_MS})
 * is removed and the reservation retried once.
 */
function reserveWorkerMarker(path: string): WorkerMarker | null {
  const marker: WorkerMarker = { token: randomUUID(), pid: process.pid };
  if (tryCreateMarker(path, marker)) return marker;
  if (isMarkerLive(path)) return null;
  rmSync(path, { force: true });
  return tryCreateMarker(path, marker) ? marker : null;
}

/**
 * Rewrite the marker with the worker's pid, so it stays live after this
 * (short-lived) requester exits. Opens with `r+`, which fails if the file is
 * gone: if the worker has ALREADY dropped the marker (it holds the lock and is
 * about to claim), recreating it would make later requests coalesce onto a
 * worker whose snapshot no longer covers their writes.
 */
function handMarkerToWorker(path: string, marker: WorkerMarker): void {
  let fd: number;
  try {
    fd = openSync(path, 'r+');
  } catch {
    return; // Already released by the worker.
  }
  try {
    const body = JSON.stringify(marker);
    ftruncateSync(fd, 0);
    writeSync(fd, body, 0);
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove the worker-pending marker if it still carries `token` — i.e. it was
 * created for this worker and not replaced after being judged stale. Called by
 * the worker under the gate lock, before it claims its generation, and again
 * when it exits. Never throws.
 *
 * @param projectRoot - Project whose marker to release.
 * @param token - Token the worker was spawned with.
 * @task T12508
 */
export function releaseSessionEndWorkerMarker(projectRoot: string, token: string): void {
  try {
    const path = sessionEndWorkerMarkerPath(projectRoot);
    if (readWorkerMarker(path)?.token === token) rmSync(path, { force: true });
  } catch {
    // Best-effort: a leftover marker goes stale within minutes.
  }
}

/**
 * Request the session-end snapshot. Call it as the LAST step of ending a
 * session, after the session row is persisted as ended.
 *
 * Records the current snapshot generation, then — unless a worker is already
 * queued for this project — spawns a detached, unref'd worker that takes the
 * snapshot, and returns immediately. At most one worker is queued per
 * project: a per-project O_EXCL marker ({@link SESSION_END_WORKER_MARKER})
 * exists from spawn until the worker holds the gate lock. A request that
 * finds a live marker spawns nothing, because the queued worker has not
 * claimed its generation yet, so its snapshot will contain this request's
 * writes. A burst of session ends therefore keeps at most two workers alive
 * (one running, one queued). Falls back to an inline snapshot (bounded lock
 * wait) when the worker cannot be spawned. Never throws.
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
    // Unknown generation: the worker is then never considered covered.
  }
  const inlineOpts: SessionEndSnapshotOptions = seenGeneration === null ? {} : { seenGeneration };

  const entry = runInline() ? null : resolveWorkerEntry();
  if (entry !== null) {
    let markerPath: string | null = null;
    let marker: WorkerMarker | null = null;
    try {
      const backupDir = join(getCleoDir(projectRoot), 'backups', 'sqlite');
      mkdirSync(backupDir, { recursive: true });
      markerPath = sessionEndWorkerMarkerPath(projectRoot);
      marker = reserveWorkerMarker(markerPath);
      if (marker === null) return { mode: 'coalesced', seenGeneration };

      const logsDir = join(getCleoDir(projectRoot), 'logs');
      mkdirSync(logsDir, { recursive: true });
      const fd = openSync(join(logsDir, 'session-end-snapshot.log'), 'a');
      try {
        const child = spawn(
          process.execPath,
          [entry, projectRoot, seenGeneration === null ? '' : String(seenGeneration), marker.token],
          { detached: true, stdio: ['ignore', fd, fd], cwd: projectRoot, env: process.env },
        );
        // A spawn failure is emitted asynchronously; without a listener it
        // would be an uncaught error in the process ending the session.
        child.on('error', (err) =>
          log.warn({ err, projectRoot }, 'Session-end snapshot worker failed'),
        );
        child.unref();
        if (child.pid !== undefined) {
          handMarkerToWorker(markerPath, { token: marker.token, pid: child.pid });
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
