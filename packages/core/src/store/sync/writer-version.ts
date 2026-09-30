/**
 * The store-level minimum writer version (S2 ruling (c), T12343).
 *
 * A released binary older than S2 writes without frames; its captures are
 * sealed as singleton transactions flagged `unframed` (S3), never claimed
 * atomic. To bound that mixed-version window, turning capture on records
 * `min_writer_version` in `_sync_meta` (this build's version, never lowered).
 * Every build from S2 on checks it at open, before any write, and refuses to
 * write a store that requires a newer writer. Builds released before S2 do
 * not know the marker: that is the window the release notes name.
 *
 * @task T12343
 * @module store/sync/writer-version
 */

import type { DatabaseSync } from 'node:sqlite';
import { getCleoVersion } from '../../scaffold/ensure-config.js';
import { hasTable } from './schema.js';

/** `_sync_meta` key of the marker. */
export const MIN_WRITER_VERSION_KEY = 'min_writer_version';

/** A writer older than the store's `min_writer_version`. */
export class StoreWriterTooOldError extends Error {
  readonly code = 'E_STORE_WRITER_TOO_OLD';

  constructor(
    readonly required: string,
    readonly actual: string,
  ) {
    super(
      `E_STORE_WRITER_TOO_OLD: this store has sync capture on and requires cleo >= ${required} to write; this is cleo ${actual}. Upgrade cleo.`,
    );
    this.name = 'StoreWriterTooOldError';
  }
}

/** The numeric parts of a version (`2026.9.25`, `2026.9.25-rc.1`), or null. */
function parts(version: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Compare two versions by their numeric parts; null when either is unparseable. */
export function compareWriterVersions(a: string, b: string): number | null {
  const x = parts(a);
  const y = parts(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/** The store's marker, or undefined. Read-only. */
export function readMinWriterVersion(db: DatabaseSync): string | undefined {
  if (!hasTable(db, '_sync_meta')) return undefined;
  const row = db
    .prepare('SELECT value FROM _sync_meta WHERE key = ?')
    .get(MIN_WRITER_VERSION_KEY) as { value: string } | undefined;
  return row?.value;
}

/**
 * Record `version` as the store's minimum writer version, unless the marker
 * already requires as much or more. Call inside the capture-on transaction.
 *
 * @returns Whether the marker changed.
 */
export function raiseMinWriterVersion(
  db: DatabaseSync,
  version: string = getCleoVersion(),
): boolean {
  if (!parts(version)) return false;
  const current = readMinWriterVersion(db);
  if (current !== undefined && (compareWriterVersions(current, version) ?? -1) >= 0) return false;
  const stamp = new Date().toISOString();
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(MIN_WRITER_VERSION_KEY, version, stamp);
  return true;
}

/**
 * Refuse to write a store whose marker requires a newer writer. Call at open,
 * before any write. An unparseable version on either side never refuses.
 *
 * @throws {StoreWriterTooOldError}
 */
export function assertWriterVersion(db: DatabaseSync, version: string = getCleoVersion()): void {
  const required = readMinWriterVersion(db);
  if (required === undefined) return;
  const cmp = compareWriterVersions(version, required);
  if (cmp !== null && cmp < 0) throw new StoreWriterTooOldError(required, version);
}
