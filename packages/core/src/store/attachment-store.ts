/**
 * Content-addressed attachment storage for CLEO tasks.db.
 *
 * Blobs are stored on disk at:
 *   `.cleo/attachments/sha256/<sha256[0..2]>/<sha256[2..]>.<ext>`
 *
 * The SQLite `attachments` + `attachment_refs` tables (tasks.db) act as the
 * registry and ref-count ledger.  Two `put` calls with identical bytes produce
 * one row and one file — the ref-count increments rather than duplicating.
 *
 * This module has NO dependency on the `llmtxt` npm package — it uses Node's
 * built-in `crypto.createHash('sha256')` for hashing and plain `node:fs`
 * for storage.
 *
 * @epic T760
 * @task T796
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment, AttachmentMetadata, AttachmentRef } from '@cleocode/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { getCleoDirAbsolute } from '../paths.js';
import { getDb, getNativeTasksDb } from './sqlite.js';
import { attachmentRefs, attachments } from './tasks-schema.js';

// ─── Error types ──────────────────────────────────────────────────────────────

/**
 * Error thrown when a retrieved blob's SHA-256 hash does not match
 * the expected value stored in metadata.
 *
 * This indicates possible disk corruption or that the wrong file
 * was stored at the expected path.
 */
export class AttachmentIntegrityError extends Error {
  /**
   * @param expectedSha256 - The SHA-256 stored in the attachment metadata
   * @param actualSha256   - The SHA-256 computed from the retrieved bytes
   * @param path           - The file path where the mismatch was detected
   */
  constructor(
    public readonly expectedSha256: string,
    public readonly actualSha256: string,
    public readonly path: string,
  ) {
    super(
      `Attachment integrity check failed at ${path}: expected sha256=${expectedSha256}, actual=${actualSha256}`,
    );
    this.name = 'AttachmentIntegrityError';
  }
}

/**
 * Discriminated union for the result of a `deref` operation.
 */
export type DerefResult =
  | { status: 'not-found' }
  | { status: 'derefd'; refCountAfter: number }
  | { status: 'removed' };

// ─── MIME → extension map ──────────────────────────────────────────────────────

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
function extFromMime(mime: string): string {
  // Normalise: strip parameters (e.g., "text/plain; charset=utf-8")
  const base = mime.split(';')[0]?.trim() ?? mime;
  return MIME_TO_EXT[base] ?? '.bin';
}

// ─── Storage path helpers ──────────────────────────────────────────────────────

/**
 * Resolve the root `.cleo/attachments/sha256/` directory.
 *
 * @param cwd - Optional working directory for path resolution
 */
function getAttachmentSha256Dir(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'attachments', 'sha256');
}

/**
 * Derive the on-disk storage path for a blob from its SHA-256 hash and MIME type.
 *
 * Layout: `.cleo/attachments/sha256/<hash[0..2]>/<hash[2..]>.<ext>`
 *
 * The two-character prefix shard keeps any individual directory under ~1 000
 * entries at realistic project scales (16² = 256 buckets).
 *
 * @param sha256 - 64-character hex SHA-256 digest
 * @param mime   - IANA MIME type used to derive the file extension
 * @param cwd    - Optional working directory for path resolution
 */
function blobPath(sha256: string, mime: string, cwd?: string): string {
  const prefix = sha256.slice(0, 2);
  const rest = sha256.slice(2);
  const ext = extFromMime(mime);
  return join(getAttachmentSha256Dir(cwd), prefix, `${rest}${ext}`);
}

// ─── SHA-256 helper ────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hex digest of a Buffer or string.
 *
 * @param content - Bytes or UTF-8 string to hash
 * @returns 64-character lowercase hex string
 */
function sha256Of(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ─── MIME extraction from Attachment union ────────────────────────────────────

/**
 * Extract the MIME type from an `Attachment` value.
 *
 * Returns `"application/octet-stream"` for kinds that do not carry a MIME
 * field (`llmtxt-doc`, unset `url` attachments).
 *
 * @param attachment - Any `Attachment` discriminated union value
 */
function mimeFromAttachment(attachment: Attachment): string {
  switch (attachment.kind) {
    case 'local-file':
    case 'blob':
      return attachment.mime;
    case 'url':
      return attachment.mime ?? 'application/octet-stream';
    case 'llms-txt':
      return 'text/plain';
    case 'llmtxt-doc':
      return 'application/octet-stream';
    default:
      return 'application/octet-stream';
  }
}

// ─── Public interface ──────────────────────────────────────────────────────────

/**
 * Content-addressed attachment store backed by tasks.db + the filesystem.
 *
 * All methods accept an optional `cwd` parameter for path resolution — the
 * same convention used throughout `@cleocode/core`.
 */
export interface AttachmentStore {
  /**
   * Store bytes and register the attachment in tasks.db.
   *
   * If an attachment with the same SHA-256 already exists, the existing row is
   * returned unchanged (content-addressed deduplication).  A new
   * `attachment_refs` row is created for each call so that the caller's owning
   * entity receives its own ref even when the blob is shared.
   *
   * @param bytes      - Content to store (Buffer or UTF-8 string)
   * @param attachment - Attachment descriptor **without** `sha256` pre-filled
   * @param ownerType  - Entity type for the initial ref (e.g., `"task"`)
   * @param ownerId    - Entity ID for the initial ref (e.g., `"T766"`)
   * @param attachedBy - Optional agent identity that created the ref
   * @param cwd        - Optional working directory for path resolution
   * @returns Resolved {@link AttachmentMetadata} (with `sha256` and `id` set)
   */
  put(
    bytes: Buffer | string,
    attachment: Omit<Attachment, 'sha256'>,
    ownerType: AttachmentRef['ownerType'],
    ownerId: string,
    attachedBy?: string,
    cwd?: string,
  ): Promise<AttachmentMetadata>;

  /**
   * Retrieve a blob's bytes and metadata by SHA-256 hash.
   *
   * @param sha256 - 64-character hex SHA-256 digest
   * @param cwd    - Optional working directory for path resolution
   * @returns `{ bytes, metadata }` or `null` if not found
   */
  get(
    sha256: string,
    cwd?: string,
  ): Promise<{ bytes: Buffer; metadata: AttachmentMetadata } | null>;

  /**
   * Retrieve attachment metadata by attachment ID.
   *
   * @param attachmentId - The `att_<...>` or UUID attachment ID
   * @param cwd          - Optional working directory for path resolution
   * @returns {@link AttachmentMetadata} or `null` if not found
   */
  getMetadata(attachmentId: string, cwd?: string): Promise<AttachmentMetadata | null>;

  /**
   * List all attachments associated with a given owner entity.
   *
   * @param ownerType - Entity type (e.g., `"task"`)
   * @param ownerId   - Entity ID (e.g., `"T766"`)
   * @param cwd       - Optional working directory for path resolution
   * @returns Array of {@link AttachmentMetadata} (may be empty)
   */
  listByOwner(ownerType: string, ownerId: string, cwd?: string): Promise<AttachmentMetadata[]>;

  /**
   * Create an `attachment_refs` row linking an attachment to an owner.
   *
   * Also increments `attachments.ref_count`.
   *
   * @param attachmentId - ID of the attachment to reference
   * @param ownerType    - Entity type for the ref
   * @param ownerId      - Entity ID for the ref
   * @param attachedBy   - Optional agent identity
   * @param cwd          - Optional working directory for path resolution
   */
  ref(
    attachmentId: string,
    ownerType: AttachmentRef['ownerType'],
    ownerId: string,
    attachedBy?: string,
    cwd?: string,
  ): Promise<void>;

  /**
   * Remove an `attachment_refs` row and decrement `attachments.ref_count`.
   *
   * When `ref_count` reaches zero the blob file is deleted from disk and the
   * `attachments` row is removed.
   *
   * @param attachmentId - ID of the attachment to dereference
   * @param ownerType    - Entity type of the ref to remove
   * @param ownerId      - Entity ID of the ref to remove
   * @param cwd          - Optional working directory for path resolution
   * @returns Discriminated union:
   *   - `{ status: 'not-found' }` if the attachment does not exist
   *   - `{ status: 'derefd', refCountAfter: N }` when refCount decreased but blob remains
   *   - `{ status: 'removed' }` when the blob was purged (refCount → 0)
   */
  deref(
    attachmentId: string,
    ownerType: string,
    ownerId: string,
    cwd?: string,
  ): Promise<DerefResult>;
}

// ─── Write-lock mutex ─────────────────────────────────────────────────────────

/**
 * Module-level promise chain used as an async mutex for all write operations
 * (put, ref, deref).  Serialises concurrent callers so that only one
 * `BEGIN IMMEDIATE` transaction is in flight at a time, preventing
 * SQLITE_BUSY errors when two `put` calls race on the same content hash.
 */
let writeLock: Promise<void> = Promise.resolve();

/**
 * Acquire the write lock, run `fn`, then release.
 *
 * @param fn - Async function to execute exclusively.
 * @returns Whatever `fn` returns.
 */
async function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = writeLock;
  let release!: () => void;
  writeLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// ─── Implementation ────────────────────────────────────────────────────────────

/**
 * Deserialise a DB row into an {@link AttachmentMetadata} value.
 *
 * @param row - Raw row from the `attachments` table
 */
function rowToMetadata(row: {
  id: string;
  sha256: string;
  attachmentJson: string;
  createdAt: string;
  refCount: number;
}): AttachmentMetadata {
  return {
    id: row.id,
    sha256: row.sha256,
    attachment: JSON.parse(row.attachmentJson) as Attachment,
    createdAt: row.createdAt,
    refCount: row.refCount,
  };
}

/**
 * Validate and coerce ownerType to the allowed enum.
 *
 * Throws if the value is not one of the six supported entity types.
 *
 * @param ownerType - Raw string from caller
 */
function assertOwnerType(ownerType: string): AttachmentRef['ownerType'] {
  const allowed: AttachmentRef['ownerType'][] = [
    'task',
    'observation',
    'session',
    'decision',
    'learning',
    'pattern',
  ];
  if (!allowed.includes(ownerType as AttachmentRef['ownerType'])) {
    throw new Error(`Invalid ownerType "${ownerType}". Must be one of: ${allowed.join(', ')}`);
  }
  return ownerType as AttachmentRef['ownerType'];
}

/**
 * Create a concrete {@link AttachmentStore} instance.
 *
 * The store is stateless — each method opens the tasks.db singleton via
 * `getDb(cwd)` for consistency with the rest of `@cleocode/core`.
 *
 * @example
 * ```ts
 * const store = createAttachmentStore();
 * const meta = await store.put(
 *   Buffer.from('# Hello'),
 *   { kind: 'blob', storageKey: '', mime: 'text/markdown', size: 7 },
 *   'task', 'T796',
 * );
 * ```
 */
export function createAttachmentStore(): AttachmentStore {
  return {
    async put(bytes, attachment, ownerType, ownerId, attachedBy, cwd) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf-8');
      const hash = sha256Of(buf);
      const mime = mimeFromAttachment({ sha256: hash, ...attachment } as Attachment);
      const filePath = blobPath(hash, mime, cwd);
      const fullAttachment: Attachment = { sha256: hash, ...attachment } as Attachment;

      return withWriteLock(async () => {
        const db = await getDb(cwd);
        const nativeDb = getNativeTasksDb();
        if (!nativeDb) throw new Error('Database not initialized');

        // Transaction: check for existing blob, insert if needed, create ref, increment refCount.
        let wasNew = false;
        try {
          nativeDb.prepare('BEGIN IMMEDIATE').run();

          // Check for existing blob inside transaction.
          const existing = await db
            .select()
            .from(attachments)
            .where(eq(attachments.sha256, hash))
            .get();

          let attachmentId: string;
          let createdAt: string;

          if (existing) {
            attachmentId = existing.id;
            createdAt = existing.createdAt;
          } else {
            // New blob: allocate ID and row.
            attachmentId = randomUUID();
            createdAt = new Date().toISOString();
            wasNew = true;

            await db
              .insert(attachments)
              .values({
                id: attachmentId,
                sha256: hash,
                attachmentJson: JSON.stringify(fullAttachment),
                createdAt,
                refCount: 0,
              })
              .run();
          }

          // Insert ref.
          await db
            .insert(attachmentRefs)
            .values({
              attachmentId,
              ownerType: assertOwnerType(ownerType),
              ownerId,
              attachedAt: new Date().toISOString(),
              attachedBy: attachedBy ?? null,
            })
            .run();

          // Use SQL arithmetic to avoid TOCTOU: ref_count = ref_count + 1
          await db
            .update(attachments)
            .set({ refCount: sql`ref_count + 1` })
            .where(eq(attachments.id, attachmentId))
            .run();

          nativeDb.prepare('COMMIT').run();

          // Write file AFTER transaction (only if blob was new).
          if (wasNew) {
            try {
              await mkdir(join(filePath, '..'), { recursive: true });
              await writeFile(filePath, buf);
            } catch (err) {
              // File write failed after commit — this is bad but db is committed.
              // The blob row exists with refCount but no file. Future get() will return null.
              // This should rarely happen (permission issues, disk full, etc).
              throw err;
            }
          }

          const finalRow = await db
            .select()
            .from(attachments)
            .where(eq(attachments.id, attachmentId))
            .get();

          return rowToMetadata(finalRow!);
        } catch (err) {
          try {
            nativeDb.prepare('ROLLBACK').run();
          } catch {
            // ROLLBACK itself failed — transaction may be auto-rolled back.
          }
          throw err;
        }
      });
    },

    async get(sha256, cwd) {
      const db = await getDb(cwd);
      const row = await db.select().from(attachments).where(eq(attachments.sha256, sha256)).get();
      if (!row) return null;

      const meta = rowToMetadata(row);
      const mime = mimeFromAttachment(meta.attachment);
      const filePath = blobPath(sha256, mime, cwd);

      let buf: Buffer;
      try {
        buf = await readFile(filePath);
      } catch {
        return null;
      }

      // Verify integrity: compute SHA-256 of retrieved bytes.
      const actualSha256 = sha256Of(buf);
      if (actualSha256 !== sha256) {
        throw new AttachmentIntegrityError(sha256, actualSha256, filePath);
      }

      return { bytes: buf, metadata: meta };
    },

    async getMetadata(attachmentId, cwd) {
      const db = await getDb(cwd);
      const row = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).get();
      return row ? rowToMetadata(row) : null;
    },

    async listByOwner(ownerType, ownerId, cwd) {
      const db = await getDb(cwd);
      const refs = await db
        .select()
        .from(attachmentRefs)
        .where(
          and(
            eq(attachmentRefs.ownerType, assertOwnerType(ownerType)),
            eq(attachmentRefs.ownerId, ownerId),
          ),
        )
        .all();

      if (refs.length === 0) return [];

      const results: AttachmentMetadata[] = [];
      for (const ref of refs) {
        const row = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, ref.attachmentId))
          .get();
        if (row) results.push(rowToMetadata(row));
      }
      return results;
    },

    async ref(attachmentId, ownerType, ownerId, attachedBy, cwd) {
      return withWriteLock(async () => {
        const db = await getDb(cwd);
        const nativeDb = getNativeTasksDb();
        if (!nativeDb) throw new Error('Database not initialized');

        try {
          nativeDb.prepare('BEGIN IMMEDIATE').run();

          // Verify attachment exists.
          const existing = await db
            .select()
            .from(attachments)
            .where(eq(attachments.id, attachmentId))
            .get();
          if (!existing) {
            throw new Error(`Attachment not found: ${attachmentId}`);
          }

          await db
            .insert(attachmentRefs)
            .values({
              attachmentId,
              ownerType: assertOwnerType(ownerType),
              ownerId,
              attachedAt: new Date().toISOString(),
              attachedBy: attachedBy ?? null,
            })
            .run();

          // Use SQL arithmetic to avoid TOCTOU: ref_count = ref_count + 1
          await db
            .update(attachments)
            .set({ refCount: sql`ref_count + 1` })
            .where(eq(attachments.id, attachmentId))
            .run();

          nativeDb.prepare('COMMIT').run();
        } catch (err) {
          try {
            nativeDb.prepare('ROLLBACK').run();
          } catch {
            // ROLLBACK itself failed — transaction may be auto-rolled back.
          }
          throw err;
        }
      });
    },

    async deref(attachmentId, ownerType, ownerId, cwd): Promise<DerefResult> {
      return withWriteLock(async () => {
        const db = await getDb(cwd);
        const nativeDb = getNativeTasksDb();
        if (!nativeDb) throw new Error('Database not initialized');

        // Verify attachment exists (inside the lock so read is consistent).
        const existing = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, attachmentId))
          .get();
        if (!existing) return { status: 'not-found' };

        try {
          nativeDb.prepare('BEGIN IMMEDIATE').run();

          // Delete the ref row.
          await db
            .delete(attachmentRefs)
            .where(
              and(
                eq(attachmentRefs.attachmentId, attachmentId),
                eq(attachmentRefs.ownerType, assertOwnerType(ownerType)),
                eq(attachmentRefs.ownerId, ownerId),
              ),
            )
            .run();

          const newCount = Math.max(0, existing.refCount - 1);

          if (newCount === 0) {
            // No refs remain — delete the registry row (file delete is best-effort).
            await db.delete(attachments).where(eq(attachments.id, attachmentId)).run();

            nativeDb.prepare('COMMIT').run();

            // Delete file after commit (can fail independently).
            const parsedAttachment = JSON.parse(existing.attachmentJson) as Attachment;
            const fileMime = mimeFromAttachment(parsedAttachment);
            const filePath = blobPath(existing.sha256, fileMime, cwd);
            try {
              await rm(filePath, { force: true });
            } catch {
              // Best-effort — file may already be gone.
            }

            return { status: 'removed' };
          }

          // Still has refs — use SQL arithmetic to decrement ref_count.
          await db
            .update(attachments)
            .set({ refCount: sql`ref_count - 1` })
            .where(eq(attachments.id, attachmentId))
            .run();

          nativeDb.prepare('COMMIT').run();

          return { status: 'derefd', refCountAfter: newCount };
        } catch (err) {
          try {
            nativeDb.prepare('ROLLBACK').run();
          } catch {
            // ROLLBACK itself failed — transaction may be auto-rolled back.
          }
          throw err;
        }
      });
    },
  };
}
