#!/usr/bin/env node

/**
 * heal-malformed-blob-attachments.mjs — One-shot heal for blob attachments
 * whose `attachment_json` does not satisfy the canonical {@link BlobAttachment}
 * contract.
 *
 * Per T11262 (Epic E9 of saga T11242), the writer at
 * `packages/core/src/docs/docs-update.ts` historically emitted a non-contract
 * shape `{ kind, name, mime, size, blobId }` instead of the canonical
 * `{ kind, sha256, storageKey, mime, size }` from
 * `packages/contracts/src/attachment.ts`. The `cleo docs fetch <slug>` and
 * `cleo docs list --type <kind>` paths call `extractBlobName(att)` →
 * `att.storageKey.split('/')` which throws `Cannot read properties of
 * undefined (reading 'split')` whenever a malformed row is encountered. A
 * single poisoned row in any task's attachment set is enough to break
 * project-scope list operations because the eager iterator in
 * `resolveAllFromTasksDb()` never recovers from per-row errors.
 *
 * The heal:
 *
 *   1. Open `.cleo/tasks.db` directly (read+write).
 *   2. SELECT rows WHERE `kind = 'blob'` AND `storageKey` is missing OR empty.
 *   3. For each row:
 *      - if a `blobId` field is present, use it as `sha256`
 *      - otherwise fall back to the `attachments.sha256` column
 *      - compute `storageKey = <sha[0..2]>/<sha[2..]>.<ext>` from the
 *        MIME-to-ext map (matches `packages/core/src/store/attachment-store.ts
 *        :extFromMime`).
 *      - drop the non-contract `name` + `blobId` fields.
 *      - keep `mime`, `size`, and any optional `description`/`labels`.
 *   4. UPDATE atomically inside a single transaction.
 *
 * Idempotent: a second run reports `Healed 0 rows` because all rows now have
 * a non-empty `storageKey`.
 *
 * Usage:
 *   node scripts/heal-malformed-blob-attachments.mjs           # heal in-place
 *   node scripts/heal-malformed-blob-attachments.mjs --dry-run # report only
 *   node scripts/heal-malformed-blob-attachments.mjs --db <path-to-tasks.db>
 *
 * @task T11262
 * @saga T11242
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite'; // db-open-allowed: one-shot heal script (T11262)

// Matches `packages/core/src/store/attachment-store.ts:extFromMime`. Kept
// inline so the script has no @cleocode/* package dependency and can be run
// against a fresh checkout before `pnpm install`.
const MIME_TO_EXT = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/html': '.html',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
};

function extFromMime(mime) {
  const base =
    String(mime ?? '')
      .split(';')[0]
      ?.trim() ?? '';
  return MIME_TO_EXT[base] ?? '.bin';
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbArgIndex = args.indexOf('--db');
const dbPath =
  dbArgIndex >= 0 && args[dbArgIndex + 1]
    ? resolve(args[dbArgIndex + 1])
    : resolve(process.cwd(), '.cleo/tasks.db');

if (!existsSync(dbPath)) {
  console.error(`tasks.db not found at: ${dbPath}`);
  console.error('Pass --db <path-to-tasks.db> or run from a CLEO project root.');
  process.exit(1);
}

console.log(`[heal-malformed-blob-attachments] db: ${dbPath}`);
console.log(`[heal-malformed-blob-attachments] mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}`);

const db = new DatabaseSync(dbPath);

// Select rows that need healing: storageKey is NULL — these are the rows
// that break `cleo docs fetch` / `cleo docs list` with the
// `Cannot read properties of undefined (reading 'split')` error.
//
// Rows with `storageKey: ''` (empty string) are also non-contract per
// `BlobAttachmentSchema`, but they do NOT break the read path because empty
// string has a `.split` method. They will be healed naturally by the next
// write-through-the-chokepoint (the canonical `AttachmentStore.put` now
// computes `storageKey` and validates the result against `attachmentSchema`).
// Per T11262, the heal script is intentionally scoped to the bug-causing
// rows only — broader migration is tracked separately if needed.
const selectStmt = db.prepare(
  `SELECT id, sha256 AS row_sha256, attachment_json
     FROM attachments
    WHERE json_extract(attachment_json, '$.kind') = 'blob'
      AND json_extract(attachment_json, '$.storageKey') IS NULL`,
);

const rows = selectStmt.all();
console.log(`[heal-malformed-blob-attachments] candidate rows: ${rows.length}`);

if (rows.length === 0) {
  console.log('Healed 0 rows');
  db.close();
  process.exit(0);
}

let updated = 0;
let skipped = 0;

const updateStmt = db.prepare(`UPDATE attachments SET attachment_json = ? WHERE id = ?`);

if (!dryRun) {
  db.exec('BEGIN IMMEDIATE');
}

try {
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row.attachment_json);
    } catch (err) {
      console.warn(
        `  [skip] id=${row.id} — attachment_json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
      skipped++;
      continue;
    }

    // Determine the canonical sha256. Priority:
    //   1. legacy `blobId` field (only present on the truly-malformed 16
    //      rows from docs-update.ts:529-535)
    //   2. existing `sha256` field on the parsed JSON (covers the
    //      storageKey:'' rows from changeset writer / ivtr-loop)
    //   3. `attachments.sha256` column as final fallback
    const sha256 =
      (typeof parsed.blobId === 'string' && parsed.blobId.length === 64 && parsed.blobId) ||
      (typeof parsed.sha256 === 'string' && parsed.sha256.length === 64 && parsed.sha256) ||
      (typeof row.row_sha256 === 'string' && row.row_sha256.length === 64 && row.row_sha256) ||
      null;

    if (!sha256) {
      console.warn(`  [skip] id=${row.id} — cannot resolve sha256 from row`);
      skipped++;
      continue;
    }

    const mime =
      typeof parsed.mime === 'string' && parsed.mime.length > 0
        ? parsed.mime
        : 'application/octet-stream';
    const size = typeof parsed.size === 'number' ? parsed.size : 0;
    const storageKey = `${sha256.slice(0, 2)}/${sha256.slice(2)}${extFromMime(mime)}`;

    // Contract-compliant shape from `packages/contracts/src/attachment.ts`.
    const healed = {
      kind: 'blob',
      sha256,
      storageKey,
      mime,
      size,
    };
    // Preserve optional contract-recognised fields if present.
    if (typeof parsed.description === 'string') healed.description = parsed.description;
    if (Array.isArray(parsed.labels)) healed.labels = parsed.labels;

    if (dryRun) {
      console.log(
        `  [dry-run] id=${row.id} sha=${sha256.slice(0, 12)}… → storageKey=${storageKey}`,
      );
    } else {
      updateStmt.run(JSON.stringify(healed), row.id);
    }
    updated++;
  }

  if (!dryRun) {
    db.exec('COMMIT');
  }
} catch (err) {
  if (!dryRun) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignored */
    }
  }
  console.error(
    `[heal-malformed-blob-attachments] failed: ${err instanceof Error ? err.stack : String(err)}`,
  );
  db.close();
  process.exit(2);
}

db.close();

console.log(`Healed ${updated} rows${skipped > 0 ? ` (skipped ${skipped})` : ''}`);
if (dryRun) {
  console.log('Dry-run: no rows were modified. Re-run without --dry-run to apply.');
}
