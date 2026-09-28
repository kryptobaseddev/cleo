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
import { closeSync, mkdirSync, openSync } from 'node:fs';
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

/** How a session-end snapshot was requested. */
export interface SessionEndSnapshotRequest {
  /** `detached`: a child process takes the snapshot; `inline`: this process did. */
  readonly mode: 'detached' | 'inline';
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

/**
 * Request the session-end snapshot. Call it as the LAST step of ending a
 * session, after the session row is persisted as ended.
 *
 * Records the current snapshot generation, then spawns a detached, unref'd
 * worker that takes the snapshot and returns immediately. Falls back to an
 * inline snapshot (bounded lock wait) when the worker cannot be spawned.
 * Never throws.
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
    try {
      const logsDir = join(getCleoDir(projectRoot), 'logs');
      mkdirSync(logsDir, { recursive: true });
      const fd = openSync(join(logsDir, 'session-end-snapshot.log'), 'a');
      try {
        const child = spawn(
          process.execPath,
          [entry, projectRoot, seenGeneration === null ? '' : String(seenGeneration)],
          { detached: true, stdio: ['ignore', fd, fd], cwd: projectRoot, env: process.env },
        );
        // A spawn failure is emitted asynchronously; without a listener it
        // would be an uncaught error in the process ending the session.
        child.on('error', (err) =>
          log.warn({ err, projectRoot }, 'Session-end snapshot worker failed'),
        );
        child.unref();
        if (child.pid !== undefined) {
          return { mode: 'detached', seenGeneration, pid: child.pid };
        }
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      log.warn({ err, projectRoot }, 'Could not spawn session-end snapshot worker; running inline');
    }
  }

  const result = await snapshotAfterSessionEnd(projectRoot, inlineOpts);
  return { mode: 'inline', seenGeneration, result };
}
