/**
 * Viewer pidfile helpers — track a detached `cleo docs serve` instance so
 * `cleo docs open` can reuse it and `cleo docs stop` can shut it down.
 *
 * Pidfile location: `${getCleoHome()}/viewer.pid` (per ADR-013 §9 / D029
 * env-paths layout, e.g. `~/.local/share/cleo/viewer.pid` on Linux).
 *
 * @epic T9631
 * @task T9646 — `cleo docs serve` local viewer
 * @task T9721 — `cleo docs open` / `cleo docs stop` + pidfile lifecycle
 */

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getCleoHome } from '@cleocode/core/internal';

/** Shape of the JSON document persisted on disk. */
export interface ViewerPidRecord {
  /** Process id of the detached viewer server. */
  pid: number;
  /** Bound TCP port (resolved by port-allocator). */
  port: number;
  /** Bind host (default 127.0.0.1). */
  host: string;
  /** Project root that owns the docs the viewer is serving. */
  projectRoot: string;
  /** Epoch ms when this record was written. */
  startedAt: number;
}

/** Absolute path to the pidfile. */
export function viewerPidFilePath(): string {
  return join(getCleoHome(), 'viewer.pid');
}

/** Persist `record` to disk, creating parent dirs as needed. */
export async function writeViewerPidFile(record: ViewerPidRecord): Promise<string> {
  const path = viewerPidFilePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2), 'utf8');
  return path;
}

/**
 * Read + parse the pidfile. Returns `null` when the file is absent or
 * malformed (a stale record from a partial crash is treated the same as
 * "no pidfile" — caller should re-spawn).
 */
export async function readViewerPidFile(): Promise<ViewerPidRecord | null> {
  try {
    const raw = await readFile(viewerPidFilePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ViewerPidRecord>;
    if (
      typeof parsed.pid === 'number' &&
      typeof parsed.port === 'number' &&
      typeof parsed.host === 'string' &&
      typeof parsed.projectRoot === 'string' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as ViewerPidRecord;
    }
    return null;
  } catch {
    return null;
  }
}

/** Best-effort removal of the pidfile; never throws. */
export async function removeViewerPidFile(): Promise<void> {
  try {
    await unlink(viewerPidFilePath());
  } catch {
    /* already gone */
  }
}

/**
 * Test if `pid` is currently running (alive AND owned by current uid). Uses
 * `process.kill(pid, 0)` — signal 0 is the conventional liveness probe and
 * never delivers a real signal to the target.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM means the process exists but is owned by another user — for our
    // purposes treat it as "alive but unreachable".
    if (e.code === 'EPERM') return true;
    return false;
  }
}
