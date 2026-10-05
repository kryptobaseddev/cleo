/**
 * The restore-in-progress marker of a store file (T13258).
 *
 * Replacing a live `cleo.db` (a `cleo restore backup` or a vault restore) has
 * a window between its last liveness check and the rename. An ordinary open
 * never takes the first-open lock, so a cleo process starting inside that
 * window would open the OLD file and, after the old sidecars were removed,
 * create a `-wal`/`-shm` BY NAME for it. The next open of the restored file
 * would then replay that WAL onto the wrong database.
 *
 * The restorer writes `<cleo.db>.restoring` (with `O_EXCL`) before its final
 * check and removes it after the swap. Every store open checks it with one
 * `existsSync`: while a live restorer holds it, the open waits briefly, then
 * refuses with `E_STORE_RESTORING`. A marker whose process is gone is stale
 * and ignored (the rename is atomic, so the file is whole either way).
 *
 * @task T13258
 * @module store/restore-marker
 */

import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { isPidAlive } from './pid-alive.js';

/** Suffix of the marker beside the store file. */
export const RESTORE_MARKER_SUFFIX = '.restoring';

/**
 * How long an open waits for a restore to finish before refusing;
 * `CLEO_RESTORE_WAIT_MS` overrides it.
 */
export const RESTORE_MARKER_WAIT_MS = 15_000;

/** The wait budget: `CLEO_RESTORE_WAIT_MS` when it is a non-negative integer, else the default. */
function waitBudget(): number {
  const raw = process.env['CLEO_RESTORE_WAIT_MS'];
  const n = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : RESTORE_MARKER_WAIT_MS;
}

/** What a marker records. */
export interface RestoreMarker {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  /** `restore` (`cleo restore backup` / `backup recover`) or `vault` (a vault restore). */
  readonly kind: 'restore' | 'vault';
}

/** The marker on `dbPath`, if any (unreadable counts as present, held by nobody known). */
function readMarker(dbPath: string): RestoreMarker | 'unreadable' | null {
  const file = dbPath + RESTORE_MARKER_SUFFIX;
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as RestoreMarker;
  } catch {
    return existsSync(file) ? 'unreadable' : null;
  }
}

/** Whether a marker blocks this process: held by another live process (or unreadable). */
function blocks(marker: RestoreMarker | 'unreadable' | null): boolean {
  if (marker === null) return false;
  if (marker === 'unreadable') return true;
  if (marker.host === hostname() && marker.pid === process.pid) return false;
  // Stale: the restorer is gone. A marker from another host is honoured.
  return !(marker.host === hostname() && !isPidAlive(marker.pid));
}

/** Block this thread for `ms` (an open is synchronous here). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Refuse to open `dbPath` while another process is replacing it. Waits up to
 * `waitMs` for the restore to finish first. Costs one `existsSync` when no
 * restore is running.
 *
 * @param dbPath - The store file about to be opened.
 * @param waitMs - How long to wait for a running restore (default {@link RESTORE_MARKER_WAIT_MS}, or `CLEO_RESTORE_WAIT_MS`).
 * @throws {CleoError} `E_STORE_RESTORING` while a restore still holds the marker.
 * @task T13258
 */
export function assertStoreNotRestoring(dbPath: string, waitMs = waitBudget()): void {
  let marker = readMarker(dbPath);
  if (!blocks(marker)) return;
  const deadline = Date.now() + waitMs;
  while (blocks(marker) && Date.now() < deadline) {
    sleepSync(100);
    marker = readMarker(dbPath);
  }
  if (!blocks(marker)) return;
  const who =
    marker === 'unreadable' || marker === null
      ? 'an unreadable marker'
      : `pid ${marker.pid} on ${marker.host} since ${marker.startedAt}`;
  // @sync-invariant none:local-only an open refused while the local store file is being replaced; nothing is written
  throw new CleoError(
    ExitCode.LOCK_TIMEOUT,
    `E_STORE_RESTORING: ${dbPath} is being replaced by a restore (${who}); opening it now could corrupt the restored store`,
    {
      fix: `wait for the restore to finish and run the command again. If no restore is running, remove ${dbPath}${RESTORE_MARKER_SUFFIX}`,
    },
  );
}

/**
 * Write the marker for a restore of `dbPath` (exclusive). Returns its release.
 *
 * @param dbPath - The store file about to be replaced.
 * @param kind - Who is replacing it.
 * @returns A function that removes the marker (idempotent).
 * @throws {CleoError} `E_STORE_RESTORING` when another live restore holds it.
 * @task T13258
 */
export function writeRestoreMarker(dbPath: string, kind: RestoreMarker['kind']): () => void {
  const file = dbPath + RESTORE_MARKER_SUFFIX;
  const marker: RestoreMarker = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    kind,
  };
  const existing = readMarker(dbPath);
  if (existing !== null && blocks(existing)) assertStoreNotRestoring(dbPath, 0);
  // A stale marker (its restorer is gone) is replaced.
  if (existing !== null) rmSync(file, { force: true });
  const fd = openSync(file, 'wx');
  try {
    writeSync(fd, `${JSON.stringify(marker)}\n`);
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(file, { force: true });
  };
}
