/**
 * Doc bytes on the sync stream (T13721). `docs_attachments` rows sync
 * (T12919), but their bodies live in `.cleo/blobs/blobs/<sha256>`, which no
 * segment carries. After a push, each doc body this store has not put on the
 * stream goes up as an encrypted content-addressed blob
 * ({@link Journal.pushAttachment}); after a pull, each synced row whose body is
 * missing here is downloaded, verified and written
 * ({@link Journal.pullAttachment}).
 *
 * A server without the stream-attachment routes (E32/E33) answers 404: the
 * rows still sync, `docs fetch` reports no-content, and one warning says why.
 *
 * @task T13721
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { CloudWarning } from '@cleocode/contracts';
import { NexusError } from './http.js';
import type { Journal } from './journal.js';

/** Most doc bodies moved per push or pull; the rest wait for the next run. */
const DOC_BYTES_PER_RUN = 100;
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

/** `_sync_meta` key marking a body as on `stream` (this machine's bookkeeping). */
const sentKey = (stream: string, sha256: string) => `doc_bytes_sent:${stream}:${sha256}`;

function markSent(db: DatabaseSync, stream: string, sha256: string): void {
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING',
  ).run(sentKey(stream, sha256), '1', new Date().toISOString());
}

/** The doc rows whose bodies are not yet known to be on `stream`. */
function unsentShas(db: DatabaseSync, stream: string): string[] {
  return (
    db
      .prepare(
        'SELECT sha256 FROM docs_attachments d WHERE NOT EXISTS ' +
          '(SELECT 1 FROM _sync_meta m WHERE m.key = ? || d.sha256) ORDER BY rowid',
      )
      .all(sentKey(stream, '')) as Array<{ sha256: string }>
  )
    .map((r) => r.sha256)
    .filter((s) => SHA256_HEX.test(s));
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

/**
 * Put each doc body this store holds, and has not put on the stream, on it.
 * A body some member already uploaded is recorded, not uploaded again.
 *
 * @param db - The project store.
 * @param journal - The stream's journal.
 * @param o - {@link DocBytesOptions}.
 * @returns What moved.
 */
export async function pushDocBytes(
  db: DatabaseSync,
  journal: Pick<Journal, 'pushAttachment'>,
  o: DocBytesOptions,
): Promise<DocBytesReport> {
  const { blobReadBySha } = await import('../store/blob-ops.js');
  let moved = 0;
  for (const sha256 of unsentShas(db, o.stream)) {
    if (moved >= DOC_BYTES_PER_RUN) break;
    // A body this store lacks (a row pulled before its bytes) is not ours to send.
    const bytes = await blobReadBySha(sha256, dirname(o.cleoDir)).catch(() => null);
    if (bytes === null) continue;
    try {
      if ((await journal.pushAttachment(sha256, Buffer.from(bytes))) === 'sent') moved++;
    } catch (err) {
      unavailable(o, err);
      break;
    }
    markSent(db, o.stream, sha256);
  }
  return { moved, refused: 0 };
}

/**
 * Download, verify and write each synced doc body missing from this store.
 * A body that fails verification is refused and nothing is written for it.
 *
 * @param db - The project store.
 * @param journal - The stream's journal.
 * @param o - {@link DocBytesOptions}.
 * @returns What moved, and how many bodies were refused.
 */
export async function pullDocBytes(
  db: DatabaseSync,
  journal: Pick<Journal, 'pullAttachment'>,
  o: DocBytesOptions,
): Promise<DocBytesReport> {
  const { writeFileAtomic } = await import('../tools/fs.js');
  const dir = join(o.cleoDir, 'blobs', 'blobs');
  let moved = 0;
  let refused = 0;
  let tried = 0;
  for (const sha256 of unsentShas(db, o.stream)) {
    const target = join(dir, sha256);
    if (existsSync(target)) continue;
    if (tried++ >= DOC_BYTES_PER_RUN) break;
    let bytes: Buffer | null;
    try {
      bytes = await journal.pullAttachment(sha256, MAX_DOC_BYTES);
    } catch (err) {
      // A refusal (tampered, wrong key, wrong size): skip it, keep the rest.
      if (err instanceof NexusError && typeof err.details?.reason === 'string') {
        refused++;
        o.warn({
          code: 'W_SYNC_DOC_BYTES_REFUSED',
          message: `${o.stream}: doc ${sha256.slice(0, 12)}… refused (${err.details.reason}): ${err.message}; nothing was written`,
        });
        continue;
      }
      unavailable(o, err);
      break;
    }
    if (bytes === null) continue; // not on the stream yet
    await writeFileAtomic({ path: target, content: bytes });
    markSent(db, o.stream, sha256);
    moved++;
  }
  return { moved, refused };
}
