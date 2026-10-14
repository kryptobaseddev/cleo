/**
 * Blob keep-links: attachment blobs outlive a stale-reading older build
 * (T12535, mixed-version defence).
 *
 * ## Why
 *
 * After the twin collapse this build reads and writes `docs_attachments`,
 * while the 2026.9.20 build still reads and writes the bare `attachments`
 * table. Both keep blob bytes at the same content-addressed path
 * (`.cleo/attachments/sha256/<aa>/<rest><ext>`). The older build deletes a blob
 * when ITS last bare ref goes (and its janitor deletes blobs no BARE row
 * names), unaware that this build's twin may still reference the content.
 *
 * ## How
 *
 * Every blob this build stores, references or carries in the collapse gets a
 * hard link under `.cleo/attachments/keep/<aa>/<rest>` (a copy where hard
 * links are not possible). The older build only ever unlinks the primary path,
 * so the bytes survive in the keep-link, and this build restores the primary
 * path from it on read, on every merge and in the repair.
 *
 * This build never deletes a blob straight away: its last deref leaves a
 * tombstone (`<keep-link>.tomb`, holding the time). The repair (`cleo doctor`,
 * the janitor) removes the primary file and the keep-link only after the grace
 * period, and only when neither table names the content.
 *
 * @module
 * @task T12535
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Minimal MIME-to-extension map for common attachment types.
 *
 * Fallback for all unrecognised MIME types is `.bin`.
 */
const MIME_TO_EXT: Record<string, string> = {
  'text/markdown': '.md',
  'text/plain': '.txt',
  'text/html': '.html',
  'text/css': '.css',
  'text/javascript': '.js',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/octet-stream': '.bin',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
};

/**
 * Resolve a file extension from a MIME type.
 *
 * @param mime - IANA MIME type string
 * @returns Extension string including the leading dot (e.g., `".md"`)
 */
export function extFromMime(mime: string): string {
  // Normalise: strip parameters (e.g., "text/plain; charset=utf-8")
  const base = mime.split(';')[0]?.trim() ?? mime;
  return MIME_TO_EXT[base] ?? '.bin';
}

/**
 * The primary on-disk path of a blob.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 * @param mime - The blob's MIME type (gives the extension).
 * @returns `.cleo/attachments/sha256/<aa>/<rest><ext>`.
 */
export function blobFilePath(cleoDir: string, sha256: string, mime: string): string {
  return join(
    cleoDir,
    'attachments',
    'sha256',
    sha256.slice(0, 2),
    `${sha256.slice(2)}${extFromMime(mime)}`,
  );
}

/**
 * The primary path of the blob an attachment row stores bytes for, or `null`
 * for kinds kept by reference (url, llms-txt, llmtxt-doc) or malformed JSON.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The row's content hash.
 * @param attachmentJson - The row's `attachment_json`.
 * @returns The primary blob path, or `null`.
 */
export function blobFileForRow(
  cleoDir: string,
  sha256: string,
  attachmentJson: string,
): string | null {
  let attachment: { kind?: unknown; mime?: unknown };
  try {
    attachment = JSON.parse(attachmentJson) as { kind?: unknown; mime?: unknown };
  } catch {
    return null;
  }
  if (attachment.kind !== 'blob' && attachment.kind !== 'local-file') return null;
  const mime = typeof attachment.mime === 'string' ? attachment.mime : 'application/octet-stream';
  return blobFilePath(cleoDir, sha256, mime);
}

/** The keep-link of a blob. */
function keepPath(cleoDir: string, sha256: string): string {
  return join(cleoDir, 'attachments', 'keep', sha256.slice(0, 2), sha256.slice(2));
}

/**
 * Read-only probe: whether a blob's bytes are retrievable right now.
 *
 * True when the primary file exists or a live (non-tombstoned) keep-link
 * holds the bytes. Unlike {@link restoreBlob} this never writes — the primary
 * file is NOT re-created from the keep-link — so callers running in a
 * dry-run/planning pass can use it without side effects.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 * @param mime - The blob's MIME type (gives the primary file's extension).
 * @returns Whether the content is on disk (primary or keep-link).
 * @task T13562
 */
export function blobContentExists(cleoDir: string, sha256: string, mime: string): boolean {
  if (existsSync(blobFilePath(cleoDir, sha256, mime))) return true;
  const keep = keepPath(cleoDir, sha256);
  return existsSync(keep) && !existsSync(`${keep}.tomb`);
}

/**
 * Hard-link (or copy) a blob's primary file to its keep-link. Idempotent and
 * best effort: a missing primary file or an unwritable keep directory is not
 * an error (the blob is then simply not protected).
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 * @param primary - The blob's primary path.
 */
export function pinBlob(cleoDir: string, sha256: string, primary: string): void {
  const keep = keepPath(cleoDir, sha256);
  try {
    if (existsSync(keep) || !existsSync(primary)) return;
    mkdirSync(dirname(keep), { recursive: true });
    try {
      linkSync(primary, keep);
    } catch {
      copyFileSync(primary, keep);
    }
  } catch {
    // best effort
  }
}

/**
 * Put a blob's primary file back from its keep-link when the primary is
 * missing (an older build unlinked it). Clears a pending tombstone: a restore
 * means something still needs the bytes.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 * @param primary - The blob's primary path.
 * @returns Whether the primary file exists afterwards.
 */
export function restoreBlob(cleoDir: string, sha256: string, primary: string): boolean {
  if (existsSync(primary)) return true;
  const keep = keepPath(cleoDir, sha256);
  if (!existsSync(keep)) return false;
  try {
    mkdirSync(dirname(primary), { recursive: true });
    try {
      linkSync(keep, primary);
    } catch {
      copyFileSync(keep, primary);
    }
    rmSync(`${keep}.tomb`, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Mark a blob this build no longer references: the repair deletes it after the
 * grace period if neither table names the content then. The primary file and
 * the keep-link stay until then.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 * @param primary - The blob's primary path (pinned first, so the tombstone has
 *   a keep-link to guard).
 * @param now - The tombstone time (ms since the epoch).
 */
export function tombstoneBlob(cleoDir: string, sha256: string, primary: string, now: number): void {
  pinBlob(cleoDir, sha256, primary);
  const keep = keepPath(cleoDir, sha256);
  try {
    mkdirSync(dirname(keep), { recursive: true });
    writeFileSync(`${keep}.tomb`, JSON.stringify({ primary, at: now }));
  } catch {
    // best effort: without a tombstone the blob is simply kept
  }
}

/** What {@link collectBlobGarbage} did. */
export interface BlobGarbageResult {
  /** Content hashes whose keep-link (and primary file) were deleted. */
  readonly deleted: string[];
  /** Tombstones or unreferenced keep-links still inside the grace period. */
  readonly waiting: number;
  /** Tombstones dropped because a table names the content again. */
  readonly revived: number;
}

/**
 * Collect keep-links nobody needs. For each keep-link:
 *
 * - referenced by a row in either table: kept; a tombstone on it is dropped
 *   and its primary file restored if it is gone;
 * - not referenced, tombstoned (this build's last deref): the primary file
 *   and the keep-link are deleted once the tombstone is older than the grace
 *   period;
 * - not referenced, no tombstone (an older build deleted the row): the
 *   keep-link (and any primary file) is deleted once the file is older than
 *   the grace period.
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param isReferenced - Whether a row in either table names the content.
 * @param graceMs - How long a tombstone (or an unreferenced keep-link) must age.
 * @param now - The current time (ms since the epoch).
 * @param dryRun - Report only.
 * @returns What was deleted, kept waiting, or revived.
 */
export function collectBlobGarbage(
  cleoDir: string,
  isReferenced: (sha256: string) => boolean,
  graceMs: number,
  now: number,
  dryRun: boolean,
): BlobGarbageResult {
  const root = join(cleoDir, 'attachments', 'keep');
  const result = { deleted: [] as string[], waiting: 0, revived: 0 };
  if (!existsSync(root)) return result;
  for (const prefix of readdirSync(root)) {
    let names: string[];
    try {
      names = readdirSync(join(root, prefix));
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.endsWith('.tomb')) continue;
      const sha256 = `${prefix}${name}`;
      const keep = join(root, prefix, name);
      const tomb = `${keep}.tomb`;
      let primary = '';
      let at: number;
      try {
        if (existsSync(tomb)) {
          const parsed = JSON.parse(readFileSync(tomb, 'utf8')) as {
            primary?: unknown;
            at?: unknown;
          };
          primary = typeof parsed.primary === 'string' ? parsed.primary : '';
          at = typeof parsed.at === 'number' ? parsed.at : statSync(tomb).mtimeMs;
        } else {
          at = statSync(keep).mtimeMs;
        }
      } catch {
        continue;
      }
      if (isReferenced(sha256)) {
        if (existsSync(tomb)) {
          result.revived++;
          if (!dryRun) {
            if (primary) restoreBlob(cleoDir, sha256, primary);
            rmSync(tomb, { force: true });
          }
        }
        continue;
      }
      if (now - at < graceMs) {
        result.waiting++;
        continue;
      }
      result.deleted.push(sha256);
      if (!dryRun) {
        if (primary) rmSync(primary, { force: true });
        rmSync(keep, { force: true });
        rmSync(tomb, { force: true });
      }
    }
  }
  return result;
}

/**
 * Whether a blob has a pending tombstone (its deletion waits for the grace
 * period, so other sweeps leave it alone).
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 * @returns `true` when tombstoned.
 */
export function isTombstoned(cleoDir: string, sha256: string): boolean {
  return existsSync(`${keepPath(cleoDir, sha256)}.tomb`);
}

/**
 * Delete a blob's keep-link (the primary file was deleted by a sweep that
 * checked both tables).
 *
 * @param cleoDir - The project's `.cleo` directory.
 * @param sha256 - The content hash.
 */
export function unpinBlob(cleoDir: string, sha256: string): void {
  rmSync(keepPath(cleoDir, sha256), { force: true });
  rmSync(`${keepPath(cleoDir, sha256)}.tomb`, { force: true });
}

/**
 * True when `target` exists AND its bytes re-hash to `sha256` (T13657).
 *
 * Existence alone is never proof that a content-addressed file holds the
 * bytes its name claims: a truncated leftover from an interrupted
 * pre-atomic write must be replaced from verified bytes, not trusted. Any
 * read failure (absent, unreadable) returns false.
 *
 * @param target - Absolute path of the content-addressed file.
 * @param sha256 - Lowercase hex SHA-256 the bytes must match.
 */
export function fileBytesMatchSha256(target: string, sha256: string): boolean {
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex') === sha256;
  } catch {
    return false;
  }
}

/**
 * Locate the on-disk source of a sha's legacy bytes for the blob-store
 * backfill (T13653). Tries, in order:
 *
 *   1. the primary legacy path (`.cleo/attachments/sha256/<2>/<62><ext>`,
 *      extension from the row's mime);
 *   2. ANY file in the sha's prefix directory whose stem equals the sha's
 *      remaining 62 chars (the recorded mime may disagree with the extension
 *      a historical writer used);
 *   3. a live keep-link (`.cleo/attachments/keep/<2>/<62>` — not tombstoned).
 *
 * Returns the first existing candidate, or null when the bytes are gone.
 * Read-only — verification happens in {@link backfillBlobStoreBytes}.
 *
 * @param cleoDir - Absolute `.cleo` directory.
 * @param sha256 - Recorded content hash.
 * @param mime - Recorded mime (picks the primary path's extension).
 * @returns The first existing candidate path, or null.
 * @internal
 */
export function resolveLegacyByteSource(
  cleoDir: string,
  sha256: string,
  mime: string,
): string | null {
  const primary = blobFilePath(cleoDir, sha256, mime);
  if (existsSync(primary)) return primary;

  try {
    for (const name of readdirSync(join(cleoDir, 'attachments', 'sha256', sha256.slice(0, 2)))) {
      const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
      if (stem === sha256.slice(2))
        return join(cleoDir, 'attachments', 'sha256', sha256.slice(0, 2), name);
    }
  } catch {
    /* prefix dir unreadable — fall through to the keep-link */
  }

  const keep = join(cleoDir, 'attachments', 'keep', sha256.slice(0, 2), sha256.slice(2));
  if (existsSync(keep) && !existsSync(`${keep}.tomb`)) return keep;
  return null;
}

/**
 * Backfill outcome for one sha (T13653).
 *
 * - `written`   — bytes verified and mirrored into the blob store (also
 *                 returned when a corrupt/truncated existing target was
 *                 replaced from the verified source, T13654).
 * - `present`   — blob-store file already existed AND re-hashes to the
 *                 recorded sha (idempotent re-run; left untouched).
 * - `unverified`— the source bytes' SHA-256 does not match the recorded hash;
 *                 nothing was written (writing unverified bytes would poison
 *                 the content-addressed store).
 * - `unreadable`— the source could not be read; nothing was written.
 */
export type BlobBackfillOutcome = 'written' | 'present' | 'unverified' | 'unreadable';

/**
 * Mirror one sha's legacy bytes into the blob store (`.cleo/blobs/blobs/<sha>`).
 *
 * Hash-verified: the source bytes are SHA-256-hashed before any write and
 * must equal the recorded sha256. Crash-safe (T13654): bytes are written to
 * a tmp file and renamed into place — an interrupted write never leaves a
 * truncated file at the final content address (which later runs would count
 * as present and `blobReadBySha` would then reject as corrupt with no heal
 * path). An existing target is RE-HASHED rather than assumed good: when its
 * bytes mismatch the recorded hash (truncation/corruption), it is replaced
 * from the verified source; a matching target is left untouched.
 *
 * @internal
 */
export async function backfillBlobStoreBytes(
  cleoDir: string,
  sha256: string,
  sourcePath: string,
): Promise<BlobBackfillOutcome> {
  const target = join(cleoDir, 'blobs', 'blobs', sha256);

  let bytes: Buffer;
  try {
    bytes = await readFile(sourcePath);
  } catch {
    return 'unreadable';
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256) return 'unverified';

  if (fileBytesMatchSha256(target, sha256)) return 'present';

  // Crash-safe via the shared atomic writer (T13657): a unique tmp file
  // renamed into place — an interrupted write never leaves a truncated blob
  // at the final content address (which later runs would count as present
  // and `blobReadBySha` would then reject as corrupt with no heal path).
  // Lazy: blob-keep loads on CLI paths that never write a blob (gate 39).
  const { writeFileAtomic } = await import('../tools/fs.js');
  await writeFileAtomic({ path: target, content: bytes });
  return 'written';
}

/**
 * Self-heal one blob-store miss from hash-verified legacy bytes (T13705).
 *
 * Docs written before the blob store held every body keep their bytes only in
 * the legacy attachment tree, which the read paths no longer consult (#2210).
 * When those bytes exist and hash to the recorded sha, they are mirrored into
 * the blob store exactly as `cleo docs doctor --repair` would ({@link
 * backfillBlobStoreBytes}: atomic write, only ever adds an absent content-addressed
 * file), so the first read heals the doc. Missing or mismatched bytes write
 * nothing.
 *
 * @param cleoDir - Absolute `.cleo` directory the blob store lives under.
 * @param sha256 - The content hash the doc row records.
 * @returns True when the blob store now holds verified bytes for `sha256`.
 * @task T13705
 */
export async function healBlobFromLegacy(cleoDir: string, sha256: string): Promise<boolean> {
  const source = resolveLegacyByteSource(cleoDir, sha256, 'application/octet-stream');
  if (source === null) return false;
  const outcome = await backfillBlobStoreBytes(cleoDir, sha256, source);
  return outcome === 'written' || outcome === 'present';
}
