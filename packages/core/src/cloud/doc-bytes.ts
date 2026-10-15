/**
 * Doc bytes on the sync stream (T13721). `docs_attachments` rows sync
 * (T12919), but their bodies live in `.cleo/blobs/blobs/<sha256>`, which no
 * segment carries. After a push, each doc body this store has not put on the
 * stream goes up as an encrypted content-addressed blob
 * ({@link Journal.pushAttachment}); after a pull, each synced row whose body is
 * missing here is downloaded, verified and written
 * ({@link Journal.pullAttachment}).
 *
 * Healing a junk record (first writer wins on the server): a pull that refuses
 * a body clears its record when it may (E34); a push checks a recorded blob
 * before it trusts it, and re-checks a few bodies it already marked sent each
 * run, so a record cleared after it was marked is recorded again.
 *
 * Both legs walk the doc rows in sha256 order from a cursor kept in
 * `_sync_meta`, so rows that cannot move (no bytes anywhere yet, refused)
 * never starve the ones behind them. A server without the stream-attachment
 * routes answers 404: rows still sync, `docs fetch` reports no-content, and
 * one warning says why. No failure here fails the sync: it becomes a warning.
 *
 * @task T13721
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudWarning } from '@cleocode/contracts';
import { NexusError } from './http.js';
import { isClientRefusal, type Journal } from './journal.js';

/** Most network attempts per push or pull; the rest wait for the next run. */
const DOC_BYTES_PER_RUN = 100;
/** Of those, most bodies already marked sent that a push re-checks. */
const RECHECKS_PER_RUN = 10;
/** The largest doc ciphertext a pull downloads. */
const MAX_DOC_BYTES = 64 * 1024 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** What one run moved. */
export interface DocBytesReport {
  /** Bodies uploaded (push) or downloaded and written (pull). */
  readonly moved: number;
  /** Bodies refused because they failed verification; nothing was written for them. */
  readonly refused: number;
}

/** Options shared by {@link pushDocBytes} and {@link pullDocBytes}. */
export interface DocBytesOptions {
  /** The stream the bodies travel on. */
  readonly stream: string;
  /** The store's `.cleo` directory (its blob store is `blobs/blobs/`). */
  readonly cleoDir: string;
  /** Where warnings go. */
  readonly warn: (w: CloudWarning) => void;
}

// `_sync_meta` keys: this machine's bookkeeping, never synced.
const sentKey = (stream: string, sha256: string) => `doc_bytes_sent:${stream}:${sha256}`;
const cursorKey = (leg: 'push' | 'recheck' | 'pull', stream: string) =>
  `doc_bytes_cursor:${leg}:${stream}`;

function readMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, new Date().toISOString());
}

/**
 * Every doc row's sha256 in order, starting after the leg's cursor and
 * wrapping around, so each run resumes where the last one stopped.
 */
function docShasFrom(db: DatabaseSync, cursor: string | null): string[] {
  const shas = (
    db.prepare('SELECT DISTINCT sha256 FROM docs_attachments ORDER BY sha256').all() as Array<{
      sha256: string;
    }>
  )
    .map((r) => r.sha256)
    .filter((s) => SHA256_HEX.test(s));
  const at = cursor ? shas.findIndex((s) => s > cursor) : 0;
  return at <= 0 ? shas : [...shas.slice(at), ...shas.slice(0, at)];
}

/**
 * Visit the doc rows from `key`'s cursor, at most `cap` of them doing work.
 * The cursor moves past every row visited, whatever became of it, so rows
 * that cannot move give up their place; a full pass starts over next run.
 * `stop` (a network failure) keeps the cursor before the failing row.
 */
async function walk(
  db: DatabaseSync,
  key: string,
  cap: number,
  visit: (sha256: string) => Promise<'skip' | 'done' | 'stop'>,
): Promise<void> {
  const from = readMeta(db, key) || null;
  let tried = 0;
  let last: string | null = null;
  let stopped = false;
  for (const sha256 of docShasFrom(db, from)) {
    if (tried >= cap) {
      stopped = true;
      break;
    }
    const r = await visit(sha256);
    if (r === 'skip') continue;
    if (r === 'stop') {
      stopped = true;
      break;
    }
    tried++;
    last = sha256;
  }
  writeMeta(db, key, stopped ? (last ?? from ?? '') : '');
}

/** A 404: the server has no stream-attachment route (an unknown ref answers `download: null`). */
const routeMissing = (err: unknown): boolean => err instanceof NexusError && err.status === 404;

function unavailable(o: DocBytesOptions, err: unknown): void {
  o.warn({
    code: 'W_SYNC_DOC_BYTES_UNAVAILABLE',
    message: routeMissing(err)
      ? `${o.stream}: the server does not carry doc bytes yet; synced docs fetch as no-content until it does`
      : `${o.stream}: doc bytes did not move this run (${err instanceof Error ? err.message : String(err)}); the next sync retries`,
  });
}

/** Run one leg; any failure (disk, store, network) is a warning, never a failed sync. */
async function guarded(
  o: DocBytesOptions,
  leg: () => Promise<DocBytesReport>,
): Promise<DocBytesReport> {
  try {
    return await leg();
  } catch (err) {
    unavailable(o, err);
    return { moved: 0, refused: 0 };
  }
}

/**
 * Put each doc body this store holds, and has not put on the stream, on it.
 * A body some member already recorded is checked, not uploaded again; a junk
 * record is cleared and replaced. Then a few bodies already marked sent are
 * re-checked, and recorded again when their record is gone.
 *
 * @param db - The project store.
 * @param journal - The stream's journal.
 * @param o - {@link DocBytesOptions}.
 * @returns What moved.
 */
export function pushDocBytes(
  db: DatabaseSync,
  journal: Pick<Journal, 'pushAttachment' | 'attachmentRecorded'>,
  o: DocBytesOptions,
): Promise<DocBytesReport> {
  return guarded(o, async () => {
    const { blobReadBySha } = await import('../store/blob-ops.js');
    let moved = 0;
    let failed = false;
    const isSent = (sha256: string) => readMeta(db, sentKey(o.stream, sha256)) === '1';
    // A body this store lacks (a row pulled before its bytes) is not ours to send.
    const bytesOf = (sha256: string) => blobReadBySha(sha256, dirname(o.cleoDir)).catch(() => null);
    const put = async (sha256: string, bytes: Uint8Array): Promise<'done' | 'stop'> => {
      let outcome: Awaited<ReturnType<Journal['pushAttachment']>>;
      try {
        outcome = await journal.pushAttachment(sha256, Buffer.from(bytes));
      } catch (err) {
        unavailable(o, err);
        failed = true;
        return 'stop';
      }
      if (outcome === 'contested') {
        // Not marked: the next push checks the ref again, and heals it once it may.
        o.warn({
          code: 'W_SYNC_DOC_BYTES_CONTESTED',
          message: `${o.stream}: doc ${sha256.slice(0, 12)}… is recorded with a blob that is not these bytes and that this device may not clear; a project owner can clear it, then the next sync re-records it`,
        });
        return 'done';
      }
      if (outcome === 'sent') moved++;
      writeMeta(db, sentKey(o.stream, sha256), '1');
      return 'done';
    };
    await walk(db, cursorKey('push', o.stream), DOC_BYTES_PER_RUN, async (sha256) => {
      if (isSent(sha256)) return 'skip';
      const bytes = await bytesOf(sha256);
      return bytes === null ? 'skip' : put(sha256, bytes);
    });
    if (failed) return { moved, refused: 0 };
    // A record cleared after this store marked it sent (a refused pull, an owner's clear).
    await walk(db, cursorKey('recheck', o.stream), RECHECKS_PER_RUN, async (sha256) => {
      if (!isSent(sha256)) return 'skip';
      const bytes = await bytesOf(sha256);
      if (bytes === null) return 'skip';
      try {
        if (await journal.attachmentRecorded(sha256)) return 'done';
      } catch (err) {
        unavailable(o, err);
        return 'stop';
      }
      writeMeta(db, sentKey(o.stream, sha256), '0');
      return put(sha256, bytes);
    });
    return { moved, refused: 0 };
  });
}

/**
 * Download, verify and write each synced doc body missing from this store.
 * A body that fails verification is refused, nothing is written for it, and
 * its record is cleared when this device may (so a holder records it again).
 *
 * @param db - The project store.
 * @param journal - The stream's journal.
 * @param o - {@link DocBytesOptions}.
 * @returns What moved, and how many bodies were refused.
 */
export function pullDocBytes(
  db: DatabaseSync,
  journal: Pick<Journal, 'pullAttachment' | 'clearAttachment'>,
  o: DocBytesOptions,
): Promise<DocBytesReport> {
  return guarded(o, async () => {
    const { writeFileAtomic } = await import('../tools/fs.js');
    const dir = join(o.cleoDir, 'blobs', 'blobs');
    let moved = 0;
    let refused = 0;
    await walk(db, cursorKey('pull', o.stream), DOC_BYTES_PER_RUN, async (sha256) => {
      const target = join(dir, sha256);
      if (existsSync(target)) return 'skip';
      let bytes: Buffer | null;
      try {
        bytes = await journal.pullAttachment(sha256, MAX_DOC_BYTES);
      } catch (err) {
        if (!isClientRefusal(err)) {
          unavailable(o, err);
          return 'stop';
        }
        // Tampered, a squat, the wrong size: skip it, keep the rest.
        refused++;
        const cleared = await journal.clearAttachment(sha256).catch(() => false);
        o.warn({
          code: 'W_SYNC_DOC_BYTES_REFUSED',
          message: `${o.stream}: doc ${sha256.slice(0, 12)}… refused (${String(err.details?.reason)}): ${err.message}; nothing was written; ${cleared ? 'its record was cleared, so a device holding the bytes records them again on its next sync' : 'a device holding the bytes replaces the record on its next sync'}`,
        });
        return 'done';
      }
      if (bytes === null) return 'done'; // not on the stream yet
      await writeFileAtomic({ path: target, content: bytes });
      writeMeta(db, sentKey(o.stream, sha256), '1');
      moved++;
      return 'done';
    });
    return { moved, refused };
  });
}
