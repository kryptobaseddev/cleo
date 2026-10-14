/**
 * Back up and restore the docs byte surfaces (T13704): the content a project
 * store backup alone cannot serve `docs fetch` from.
 *
 *   - `.cleo/blobs/manifest.db` (blob-store metadata) and
 *     `.cleo/blobs/blobs/<sha256>` (the bytes);
 *   - `.cleo/attachments/index.db` and the legacy byte tree under
 *     `.cleo/attachments/` (`sha256/<2>/<62><ext>`, `keep/...`).
 *
 * The two databases are snapshotted per backup with `VACUUM INTO`, checked
 * with `PRAGMA integrity_check`, and stored as flat `<label>.<backupId>`
 * payloads beside the store snapshot. The byte files go into ONE shared
 * content-addressed pool, `.cleo/backups/blobs/<sha256>`, written once and
 * shared by every backup (T13710: a real store holds ~10k files, so per-backup
 * copies made rotation delete the backups themselves). Each backup lists what
 * it references in a `docs-bytes.json.<backupId>` sidecar; rotation removes a
 * whole backup, sidecar included, and {@link sweepDocsBytePool} then unlinks
 * only pool files no surviving sidecar references.
 *
 * Restore verifies every byte before placing it: each pool file must hash to
 * its recorded sha256, each database snapshot must match its recorded sha256
 * and pass `integrity_check` on the staged copy that is then renamed into
 * place. Anything that fails is listed; a restore with failures is partial,
 * never clean (T13709).
 *
 * Synchronous on purpose: callers hold no async lock across it, and the pool
 * lock is a {@link withLockSync} lock whose stale age covers a full pass.
 *
 * @module store/docs-bytes-backup
 * @task T13704
 * @task T13708
 * @task T13709
 * @task T13710
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { StoreRestoreDocsBytes } from '@cleocode/contracts';
import { z } from 'zod';
import { getLogger } from '../logger.js';
import { withLockSync } from './lock.js';
import { integrityCheck, vacuumSnapshot } from './portable-bundle-scan.js';
import { storeOpenElsewhere } from './writer-lease.js';

/** Label of the per-backup sidecar listing the docs bytes it references (`<label>.<backupId>`). */
export const DOCS_BYTES_SIDECAR_LABEL = 'docs-bytes.json';

/** The docs databases, snapshotted per backup as `<label>.<backupId>`. Paths relative to `.cleo/`. */
const DOCS_DBS = [
  { label: 'blobs.manifest.db', path: 'blobs/manifest.db' },
  { label: 'attachments.index.db', path: 'attachments/index.db' },
] as const;

/** The byte trees pooled by content address. Paths relative to `.cleo/`. */
const DOCS_BYTE_TREES = ['blobs/blobs', 'attachments'] as const;

/** SQLite sidecars of a live database: never copied as bytes. */
const DB_SIDECARS = ['-wal', '-shm', '-journal'] as const;

/** A full pass over ~10k files blocks for seconds; the pool lock is never taken as stale before this. */
const POOL_LOCK_STALE_MS = 10 * 60_000;

const sha256Hex = /^[0-9a-f]{64}$/;

const sidecarSchema = z.object({
  version: z.literal(1),
  dbs: z.array(
    z.object({ label: z.string(), path: z.string(), sha256: z.string().regex(sha256Hex) }),
  ),
  files: z.array(z.object({ path: z.string(), sha256: z.string().regex(sha256Hex) })),
});

/** The `docs-bytes.json.<backupId>` sidecar: what one backup references. */
type DocsBytesSidecar = z.infer<typeof sidecarSchema>;

/** What {@link backupDocsBytes} captured. */
export interface DocsBytesBackupSummary {
  /** Database labels snapshotted and verified (`blobs.manifest.db`, `attachments.index.db`). */
  readonly dbs: readonly string[];
  /** Byte files referenced from the pool. */
  readonly files: number;
  /** Byte files newly written to the pool (the rest were already there). */
  readonly pooled: number;
  /** What could not be captured. */
  readonly skipped: readonly string[];
}

/** The shared byte pool of a backup directory (`.cleo/backups/sqlite` -> `.cleo/backups/blobs`). */
export function docsBytePoolDir(backupDir: string): string {
  return join(dirname(backupDir), 'blobs');
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * The sha256 a byte file's path claims, or `null` when the path is not
 * content-addressed: `blobs/blobs/<sha>`, or `attachments/{sha256,keep}/<2>/<62>[.ext]`.
 */
function contentAddress(rel: string): string | null {
  const parts = rel.split('/');
  if (parts[0] === 'blobs' && parts.length === 3) {
    return sha256Hex.test(parts[2] ?? '') ? (parts[2] ?? null) : null;
  }
  if (parts[0] !== 'attachments' || parts.length !== 4) return null;
  if (parts[1] !== 'sha256' && parts[1] !== 'keep') return null;
  const name = parts[3] ?? '';
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  const sha = `${parts[2]}${stem}`;
  return sha256Hex.test(sha) ? sha : null;
}

/** Every regular file under `dir`, as paths relative to `cleoDir` with `/` separators. */
function walkFiles(cleoDir: string, dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(cleoDir, abs, out);
    else if (entry.isFile())
      out.push(
        abs
          .slice(cleoDir.length + 1)
          .split('\\')
          .join('/'),
      );
  }
}

/** Whether `rel` is one of the docs databases or a sidecar of one (snapshotted, never copied raw). */
function isDocsDbFile(rel: string): boolean {
  return DOCS_DBS.some(
    (db) => rel === db.path || DB_SIDECARS.some((suffix) => rel === `${db.path}${suffix}`),
  );
}

/** Copy `from` to a private name beside `to`, then rename it into place. */
function copyAtomic(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  const tmp = `${to}.tmp-${process.pid}-${Date.now()}`;
  try {
    copyFileSync(from, tmp);
    renameSync(tmp, to);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function withPoolLock<T>(backupDir: string, fn: () => T): T {
  const pool = docsBytePoolDir(backupDir);
  mkdirSync(pool, { recursive: true });
  return withLockSync(pool, fn, {
    waitMs: 60_000,
    stale: POOL_LOCK_STALE_MS,
    label: 'the backup blob pool',
  });
}

/**
 * Snapshot the docs byte surfaces of `cleoDir` into backup `backupId` (T13704):
 * VACUUM INTO + integrity_check for each docs database, every byte file into
 * the shared pool (written once), and the `docs-bytes.json.<backupId>`
 * sidecar listing what the backup references. Best effort per file: what
 * fails is reported in `skipped`, never silently dropped.
 *
 * @param cleoDir - The project's `.cleo/` directory.
 * @param backupDir - `.cleo/backups/sqlite`.
 * @param backupId - The backup the snapshot belongs to.
 * @returns What was captured, or `null` when there are no docs byte surfaces.
 */
export function backupDocsBytes(
  cleoDir: string,
  backupDir: string,
  backupId: string,
): DocsBytesBackupSummary | null {
  if (!existsSync(join(cleoDir, 'blobs')) && !existsSync(join(cleoDir, 'attachments'))) return null;
  return withPoolLock(backupDir, () => {
    const pool = docsBytePoolDir(backupDir);
    const skipped: string[] = [];
    const sidecar: DocsBytesSidecar = { version: 1, dbs: [], files: [] };

    for (const db of DOCS_DBS) {
      const src = join(cleoDir, db.path);
      if (!existsSync(src)) continue;
      const dest = join(backupDir, `${db.label}.${backupId}`);
      const tmp = `${dest}.tmp`;
      try {
        rmSync(tmp, { force: true });
        vacuumSnapshot(src, tmp);
        const integrity = integrityCheck(tmp);
        // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
        if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
        const sha256 = sha256OfFile(tmp);
        renameSync(tmp, dest);
        sidecar.dbs.push({ label: db.label, path: db.path, sha256 });
      } catch (err) {
        rmSync(tmp, { force: true });
        skipped.push(`${db.path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const files: string[] = [];
    for (const tree of DOCS_BYTE_TREES) walkFiles(cleoDir, join(cleoDir, tree), files);
    let pooled = 0;
    for (const rel of files) {
      if (isDocsDbFile(rel)) continue;
      try {
        // A content-addressed name already in the pool was verified when it
        // was written: reference it without reading the live file again.
        const claimed = contentAddress(rel);
        if (claimed !== null && existsSync(join(pool, claimed))) {
          sidecar.files.push({ path: rel, sha256: claimed });
          continue;
        }
        const abs = join(cleoDir, rel);
        const sha256 = sha256OfFile(abs);
        if (!existsSync(join(pool, sha256))) {
          copyAtomic(abs, join(pool, sha256));
          pooled++;
        }
        sidecar.files.push({ path: rel, sha256 });
      } catch (err) {
        skipped.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (sidecar.dbs.length === 0 && sidecar.files.length === 0) return null;
    const dest = join(backupDir, `${DOCS_BYTES_SIDECAR_LABEL}.${backupId}`);
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify(sidecar));
    renameSync(tmp, dest);
    if (skipped.length > 0) {
      getLogger('backup').warn({ backupId, skipped }, 'docs byte surfaces partly captured');
    }
    return {
      dbs: sidecar.dbs.map((d) => d.label),
      files: sidecar.files.length,
      pooled,
      skipped,
    };
  });
}

/**
 * Unlink every pool file that no `docs-bytes.json.<backupId>` sidecar left in
 * `backupDir` references (T13710); run after rotation. When any sidecar
 * cannot be read, what it references is unknown, so nothing is removed.
 *
 * @param backupDir - `.cleo/backups/sqlite`.
 * @returns The pool files removed.
 */
export function sweepDocsBytePool(backupDir: string): string[] {
  const pool = docsBytePoolDir(backupDir);
  if (!existsSync(pool)) return [];
  return withPoolLock(backupDir, () => {
    const referenced = new Set<string>();
    for (const name of readdirSync(backupDir)) {
      if (!name.startsWith(`${DOCS_BYTES_SIDECAR_LABEL}.`) || name.endsWith('.tmp')) continue;
      const sidecar = readSidecarFile(join(backupDir, name));
      if (sidecar === null) {
        getLogger('backup').warn({ sidecar: name }, 'unreadable docs-bytes sidecar: pool kept');
        return [];
      }
      for (const f of sidecar.files) referenced.add(f.sha256);
    }
    const removed: string[] = [];
    for (const name of readdirSync(pool)) {
      if (referenced.has(name) || !sha256Hex.test(name)) continue;
      try {
        unlinkSync(join(pool, name));
        removed.push(name);
      } catch {
        // non-fatal: an unreferenced pool file only costs space
      }
    }
    return removed;
  });
}

function readSidecarFile(path: string): DocsBytesSidecar | null {
  try {
    const parsed = sidecarSchema.safeParse(JSON.parse(readFileSync(path, 'utf-8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Whether backup `backupId` carries docs byte surfaces (a `docs-bytes.json` sidecar).
 *
 * @param backupDir - `.cleo/backups/sqlite`.
 * @param backupId - The backup.
 */
export function hasDocsBytes(backupDir: string, backupId: string): boolean {
  return existsSync(join(backupDir, `${DOCS_BYTES_SIDECAR_LABEL}.${backupId}`));
}

/**
 * The live docs databases another connection holds open (a restore over
 * them would be lost to that connection's writes).
 *
 * @param cleoDir - The project's `.cleo/` directory.
 * @returns Absolute paths of the busy databases.
 */
export function docsDbsOpenElsewhere(cleoDir: string): string[] {
  return DOCS_DBS.map((db) => join(cleoDir, db.path)).filter((p) => storeOpenElsewhere(p));
}

/**
 * Restore the docs byte surfaces of backup `backupId` into `cleoDir`, placing
 * only verified bytes (T13708, T13709). Each database snapshot must match its
 * recorded sha256 and pass `integrity_check` on the staged copy, and its live
 * file must not be open elsewhere; each pool file must hash to its recorded
 * sha256. Failures are listed in `failed`, and `complete` is `false` when
 * there are any.
 *
 * @param cleoDir - The project's `.cleo/` directory.
 * @param backupDir - `.cleo/backups/sqlite`.
 * @param backupId - The backup to restore from.
 * @returns What was placed and what failed, or `null` when the backup holds no docs bytes.
 */
export function restoreDocsBytes(
  cleoDir: string,
  backupDir: string,
  backupId: string,
): StoreRestoreDocsBytes | null {
  const sidecarPath = join(backupDir, `${DOCS_BYTES_SIDECAR_LABEL}.${backupId}`);
  if (!existsSync(sidecarPath)) return null;
  const sidecar = readSidecarFile(sidecarPath);
  if (sidecar === null) {
    return {
      complete: false,
      dbsRestored: [],
      filesRestored: 0,
      failed: [`${DOCS_BYTES_SIDECAR_LABEL}.${backupId}: unreadable sidecar`],
    };
  }
  const dbsRestored: string[] = [];
  const failed: string[] = [];

  for (const db of sidecar.dbs) {
    const dest = join(cleoDir, db.path);
    const staged = `${dest}.restore-${process.pid}-${Date.now()}`;
    try {
      const from = join(backupDir, `${db.label}.${backupId}`);
      // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
      if (!existsSync(from)) throw new Error('snapshot missing from the backup');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(from, staged);
      // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
      if (sha256OfFile(staged) !== db.sha256) throw new Error('sha256 mismatch');
      const integrity = integrityCheck(staged);
      // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
      if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`);
      // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
      if (storeOpenElsewhere(dest)) throw new Error('open in another process');
      for (const suffix of DB_SIDECARS) rmSync(`${dest}${suffix}`, { force: true });
      renameSync(staged, dest);
      dbsRestored.push(db.path);
    } catch (err) {
      failed.push(`${db.path}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      for (const p of [staged, ...DB_SIDECARS.map((s) => `${staged}${s}`)]) {
        rmSync(p, { force: true });
      }
    }
  }

  const pool = docsBytePoolDir(backupDir);
  let filesRestored = 0;
  for (const file of sidecar.files) {
    // The sidecar is data read from disk: place bytes only inside the two trees.
    const inTree =
      (file.path.startsWith('blobs/blobs/') || file.path.startsWith('attachments/')) &&
      !file.path.split('/').includes('..') &&
      !isDocsDbFile(file.path);
    if (!inTree) {
      failed.push(`${file.path}: not a docs byte path`);
      continue;
    }
    const dest = join(cleoDir, file.path);
    const staged = `${dest}.restore-${process.pid}-${Date.now()}`;
    try {
      const from = join(pool, file.sha256);
      // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
      if (!existsSync(from)) throw new Error('missing from the backup pool');
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(from, staged);
      // @sync-invariant none:local-only caught below and listed; a local backup/restore file, no synced row
      if (sha256OfFile(staged) !== file.sha256) throw new Error('sha256 mismatch');
      renameSync(staged, dest);
      filesRestored++;
    } catch (err) {
      failed.push(`${file.path}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      rmSync(staged, { force: true });
    }
  }

  return { complete: failed.length === 0, dbsRestored, filesRestored, failed };
}
