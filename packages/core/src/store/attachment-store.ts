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
import { resolveCanonicalCleoDir, resolveProjectByCwd } from '../paths.js';
import type { CleoBlobStore as CleoBlobStoreType } from './llmtxt-blob-adapter.js';
import { getDb, getNativeTasksDb } from './sqlite.js';
import { type AttachmentLifecycleStatus, attachmentRefs, attachments } from './tasks-schema.js';

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

/**
 * Error thrown by {@link AttachmentStore.put} when an attempt is made to
 * assign a slug that is already in use elsewhere in the project DB.
 *
 * Carries `suggestions` so callers (CLI dispatch) can surface alternative
 * slugs without re-deriving them. The list is always exactly 3 candidates.
 *
 * @task T9636
 */
export class SlugCollisionError extends Error {
  constructor(
    public readonly slug: string,
    public readonly suggestions: readonly string[],
  ) {
    super(`Slug '${slug}' is already in use in this project`);
    this.name = 'SlugCollisionError';
  }
}

/**
 * Error thrown by {@link AttachmentStore.put} when a writer attempts to
 * assign a slug that was NOT first reserved through the central
 * {@link import('../docs/slug-allocator.js').reserveSlug} chokepoint.
 *
 * This is a PROGRAMMER ERROR — production CLI verbs must always call
 * `reserveSlug` before `put({ slug })`. Surfacing the bypass at the
 * write call protects against dual-writer drift (the bug class
 * described in T10294 RCA and tracked under Saga T10288 / Epic T10289).
 *
 * @task T10392
 * @epic T10289
 * @saga T10288
 */
export class SlugNotReservedByAllocatorError extends Error {
  constructor(public readonly slug: string) {
    super(
      `Slug '${slug}' was passed to attachmentStore.put() without first being reserved by ` +
        `reserveSlug(). The slug allocator chokepoint MUST be called before any write — ` +
        `see packages/core/src/docs/slug-allocator.ts (T10392).`,
    );
    this.name = 'SlugNotReservedByAllocatorError';
  }
}

/**
 * Side-table extension for {@link AttachmentStore.put} carrying optional
 * project-scoped metadata (slug, type) that lives directly on the
 * `attachments` row rather than inside the discriminated-union JSON blob.
 *
 * @task T9636 (slug) / T9637 (type)
 */
export interface PutAttachmentExtras {
  /** Optional kebab-case slug; uniqueness is enforced at the DB layer. */
  slug?: string;
  /** Optional taxonomy classification; validated upstream. */
  type?: string;
}

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
  const projectId = resolveProjectByCwd(cwd);
  return join(resolveCanonicalCleoDir(projectId), 'attachments', 'sha256');
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
   * When `extras.slug` is provided it is assigned to the underlying row;
   * collision with another row's slug throws {@link SlugCollisionError} after
   * rolling back. When the same SHA-256 is re-put with a slug, the slug is
   * applied to the existing row (no-op if equal, collision-checked otherwise).
   *
   * @param bytes      - Content to store (Buffer or UTF-8 string)
   * @param attachment - Attachment descriptor **without** `sha256` pre-filled
   * @param ownerType  - Entity type for the initial ref (e.g., `"task"`)
   * @param ownerId    - Entity ID for the initial ref (e.g., `"T766"`)
   * @param attachedBy - Optional agent identity that created the ref
   * @param cwd        - Optional working directory for path resolution
   * @param extras     - Optional per-row metadata (slug, type) — T9636/T9637
   * @returns Resolved {@link AttachmentMetadata} (with `sha256` and `id` set)
   */
  put(
    bytes: Buffer | string,
    attachment: Omit<Attachment, 'sha256'>,
    ownerType: AttachmentRef['ownerType'],
    ownerId: string,
    attachedBy?: string,
    cwd?: string,
    extras?: PutAttachmentExtras,
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
   * Retrieve attachment metadata + slug + type by slug.
   *
   * Returns `null` if no attachment in this project carries the slug.
   *
   * `summary` and `lifecycleStatus` (T10158 provenance columns) are
   * surfaced here so similarity-style callers (T10163) do not have to
   * round-trip the DB a second time.
   *
   * @task T9636
   */
  findBySlug(
    slug: string,
    cwd?: string,
  ): Promise<{
    metadata: AttachmentMetadata;
    slug: string;
    type: string | null;
    summary: string | null;
    lifecycleStatus: AttachmentLifecycleStatus;
  } | null>;

  /**
   * List ALL attachments in the project DB, optionally filtered by `type`.
   *
   * Returns one row per `attachment_refs` entry so callers see how the
   * attachment was bound to its owner. Use this for `cleo docs list --project`.
   *
   * `summary` and `lifecycleStatus` (T10158 provenance columns) are
   * surfaced as additive fields for callers that need them (T10163).
   *
   * @task T9638
   */
  listAllInProject(
    cwd?: string,
    filter?: { type?: string },
  ): Promise<
    Array<{
      metadata: AttachmentMetadata;
      slug: string | null;
      type: string | null;
      ownerType: AttachmentRef['ownerType'];
      ownerId: string;
      summary: string | null;
      lifecycleStatus: AttachmentLifecycleStatus;
    }>
  >;

  /**
   * Read the slug + type columns for an attachment ID.
   *
   * Returns `null` when the row doesn't exist; otherwise returns the raw
   * column values (each independently nullable).
   *
   * @task T9636 / T9637
   */
  getExtras(
    attachmentId: string,
    cwd?: string,
  ): Promise<{ slug: string | null; type: string | null } | null>;

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
 * Drizzle DB type used internally — matches the singleton returned by getDb().
 * Declared loosely (`Awaited<ReturnType<typeof getDb>>`) so the helper stays
 * forward-compatible if the schema-strictness option changes upstream.
 */
type DrizzleDb = Awaited<ReturnType<typeof getDb>>;

/**
 * Derive 3 alternative slug candidates that are NOT currently in use.
 *
 * Strategy (per Epic T9627 design guidance):
 *   1. `<slug>-N` where N is the count-of-existing-rows + 1
 *   2. `<slug>-v2`
 *   3. `<slug>-new` (or `-alt` if `-new` is also taken)
 *
 * If a primary candidate is also taken, walk forward until a free one is
 * found. The lookup is bounded by a maximum of 32 probes per candidate so
 * a pathological dataset can never block the request.
 *
 * Re-exported under {@link deriveSlugSuggestionsForAllocator} for the
 * central slug allocator (T10392) so both the late-bound
 * `SlugCollisionError` path and the early-bound `reserveSlug` path emit
 * the SAME suggestion shape.
 *
 * @task T9636
 */
async function deriveSlugSuggestions(db: DrizzleDb, base: string): Promise<string[]> {
  const taken = new Set<string>();
  const probes: string[] = [];
  const startCount = await db.$count(attachments);
  probes.push(`${base}-${startCount + 1}`);
  probes.push(`${base}-v2`);
  probes.push(`${base}-new`);

  const out: string[] = [];
  for (let idx = 0; idx < probes.length; idx++) {
    let candidate = probes[idx] as string;
    let walk = 0;
    while (walk < 32) {
      if (taken.has(candidate)) {
        walk++;
        candidate = `${candidate}-x`;
        continue;
      }
      const conflict = await db
        .select()
        .from(attachments)
        .where(eq(attachments.slug, candidate))
        .get();
      if (!conflict) {
        out.push(candidate);
        taken.add(candidate);
        break;
      }
      taken.add(candidate);
      walk++;
      candidate = idx === 2 ? `${base}-alt-${walk}` : `${candidate}-x`;
    }
    if (out.length === idx + 1) continue;
    // Failed to derive — keep a fallback so caller always sees 3 entries.
    out.push(`${base}-${startCount + idx + 100}`);
  }

  return out.slice(0, 3);
}

/**
 * Re-export of {@link deriveSlugSuggestions} for the central slug
 * allocator (T10392).
 *
 * Lives in this module rather than the allocator so the suggestion
 * algorithm has exactly ONE implementation. Both the late-bound
 * `SlugCollisionError` path inside `attachmentStore.put` and the
 * early-bound `reserveSlug` chokepoint use the same helper, so the
 * suggestion shape is uniform regardless of which layer caught the
 * conflict.
 *
 * Loose typing on `db` matches the internal `DrizzleDb` alias so
 * cross-package consumers do not have to import drizzle types.
 *
 * @task T10392
 * @internal
 */
export async function deriveSlugSuggestionsForAllocator(
  db: DrizzleDb,
  base: string,
): Promise<string[]> {
  return deriveSlugSuggestions(db, base);
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
    async put(bytes, attachment, ownerType, ownerId, attachedBy, cwd, extras) {
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf-8');
      const hash = sha256Of(buf);
      const mime = mimeFromAttachment({ sha256: hash, ...attachment } as Attachment);
      const filePath = blobPath(hash, mime, cwd);
      // T11262: compute the canonical storageKey for blob kinds at the
      // chokepoint so all callers (changeset writer, ivtr-loop, import-
      // accessor, docs-add) produce contract-compliant rows even when they
      // pass an empty placeholder `storageKey: ''`. This matches the
      // {prefix}/{rest}{ext} layout used by `blobPath()` so reads can derive
      // the on-disk path purely from the stored shape.
      const computedStorageKey =
        attachment.kind === 'blob'
          ? `${hash.slice(0, 2)}/${hash.slice(2)}${extFromMime(mime)}`
          : null;
      const blobOverrides: { sha256: string; storageKey?: string } =
        attachment.kind === 'blob' && computedStorageKey !== null
          ? { sha256: hash, storageKey: computedStorageKey }
          : { sha256: hash };
      const fullAttachment: Attachment = {
        ...attachment,
        ...blobOverrides,
      } as Attachment;
      // Validate against the canonical Zod contract before persisting —
      // catches any future shape drift at the writer chokepoint (T11262).
      // Imported lazily to avoid pulling Zod into module init for callers
      // that only read attachments. Synchronous import works because the
      // module graph already includes `@cleocode/contracts`.
      const { attachmentSchema } = await import('@cleocode/contracts');
      attachmentSchema.parse(fullAttachment);
      const slug = extras?.slug;
      const type = extras?.type;

      return withWriteLock(async () => {
        const db = await getDb(cwd);
        const nativeDb = getNativeTasksDb();
        if (!nativeDb) throw new Error('Database not initialized');

        // Allocator chokepoint runtime assert (T10392) — every writer with
        // a slug SHOULD have first called reserveSlug(). The lookup is a
        // cheap in-process Set; SQLite UNIQUE INDEX remains the
        // cross-process backstop.
        //
        // OPT-IN BEHAVIOUR: this T10392 PR introduces the allocator module
        // but does NOT yet wire the writers — that lands in T10386 (docs
        // add) and T10388 (changeset add). Until both wiring PRs merge,
        // the assert is OPT-IN via the `CLEO_STRICT_SLUG_ALLOCATOR=1` env
        // var so existing legacy writers continue to work and the wiring
        // PRs can flip the default to strict in their own commit. The
        // env var also lets tests exercise the assert path explicitly.
        if (slug !== undefined && process.env['CLEO_STRICT_SLUG_ALLOCATOR'] === '1') {
          const { isSlugReserved, consumeReservedSlug } = await import('../docs/slug-allocator.js');
          if (!isSlugReserved(slug)) {
            throw new SlugNotReservedByAllocatorError(slug);
          }
          // Consume the reservation now so retries do NOT re-trip the
          // assert and the in-process Set does not grow unbounded.
          consumeReservedSlug(slug);
        }

        // Pre-check slug collision OUTSIDE the BEGIN IMMEDIATE window so the
        // caller receives SlugCollisionError without leaving a half-written
        // transaction. The partial UNIQUE INDEX on the slug column is the
        // hard backstop; this check provides a friendly error + suggestions.
        if (slug !== undefined) {
          const conflict = await db
            .select()
            .from(attachments)
            .where(eq(attachments.slug, slug))
            .get();
          if (conflict && conflict.sha256 !== hash) {
            const suggestions = await deriveSlugSuggestions(db, slug);
            throw new SlugCollisionError(slug, suggestions);
          }
        }

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
                ...(slug !== undefined ? { slug } : {}),
                ...(type !== undefined ? { type } : {}),
              })
              .run();
          }

          // For an already-existing row, apply slug/type if requested. The
          // pre-check above guarantees no cross-row collision; same-row
          // re-assignment of the same slug is a no-op via the partial UNIQUE
          // INDEX semantics. Use raw SQL via drizzle update to avoid clobbering
          // existing values when extras is undefined.
          if (existing && (slug !== undefined || type !== undefined)) {
            const updates: Record<string, string> = {};
            if (slug !== undefined) updates.slug = slug;
            if (type !== undefined) updates.type = type;
            await db.update(attachments).set(updates).where(eq(attachments.id, attachmentId)).run();
          }

          // Insert ref. The (attachment_id, owner_type, owner_id) tuple is the
          // composite PK on `attachment_refs`, so a re-put of the same blob
          // for the same owner would otherwise trip the UNIQUE constraint.
          // We pre-check + skip the insert + refCount bump so the call
          // remains idempotent on (sha, owner). This mirrors the slug
          // pre-check above — same rationale: friendly noop instead of an
          // opaque SQLite error in callers that legitimately re-attach.
          //
          // T9791 — uncovered by `cleo docs import` when an agent-output
          // had already been attached to its task via a pre-T9791 `cleo
          // docs add` call. The legacy ref already exists; the import path
          // must apply slug + type to the existing row WITHOUT crashing.
          const ownerTypeChecked = assertOwnerType(ownerType);
          const refExisting = await db
            .select()
            .from(attachmentRefs)
            .where(
              and(
                eq(attachmentRefs.attachmentId, attachmentId),
                eq(attachmentRefs.ownerType, ownerTypeChecked),
                eq(attachmentRefs.ownerId, ownerId),
              ),
            )
            .get();

          if (!refExisting) {
            await db
              .insert(attachmentRefs)
              .values({
                attachmentId,
                ownerType: ownerTypeChecked,
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
          }

          nativeDb.prepare('COMMIT').run();

          // Write file AFTER transaction (only if blob was new).
          // File write failure propagates naturally — this is bad but db is committed.
          // The blob row exists with refCount but no file. Future get() will return null.
          // This should rarely happen (permission issues, disk full, etc).
          if (wasNew) {
            await mkdir(join(filePath, '..'), { recursive: true });
            await writeFile(filePath, buf);
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

    async findBySlug(slug, cwd) {
      const db = await getDb(cwd);
      const row = await db.select().from(attachments).where(eq(attachments.slug, slug)).get();
      if (!row) return null;
      return {
        metadata: rowToMetadata(row),
        slug: row.slug ?? slug,
        type: row.type ?? null,
        summary: row.summary ?? null,
        lifecycleStatus: row.lifecycleStatus,
      };
    },

    async getExtras(attachmentId, cwd) {
      const db = await getDb(cwd);
      const row = await db.select().from(attachments).where(eq(attachments.id, attachmentId)).get();
      if (!row) return null;
      return { slug: row.slug ?? null, type: row.type ?? null };
    },

    async listAllInProject(cwd, filter) {
      const db = await getDb(cwd);
      // One row per attachment_refs binding, joined to attachments. We
      // intentionally surface duplicates when one blob is referenced by
      // multiple owners — callers wanting deduplication can collapse by id.
      const rows = await db
        .select({
          attachmentId: attachmentRefs.attachmentId,
          ownerType: attachmentRefs.ownerType,
          ownerId: attachmentRefs.ownerId,
        })
        .from(attachmentRefs)
        .all();

      if (rows.length === 0) return [];

      const out: Array<{
        metadata: AttachmentMetadata;
        slug: string | null;
        type: string | null;
        ownerType: AttachmentRef['ownerType'];
        ownerId: string;
        summary: string | null;
        lifecycleStatus: AttachmentLifecycleStatus;
      }> = [];
      for (const refRow of rows) {
        const row = await db
          .select()
          .from(attachments)
          .where(eq(attachments.id, refRow.attachmentId))
          .get();
        if (!row) continue;
        if (filter?.type !== undefined && row.type !== filter.type) continue;
        out.push({
          metadata: rowToMetadata(row),
          slug: row.slug ?? null,
          type: row.type ?? null,
          ownerType: refRow.ownerType,
          ownerId: refRow.ownerId,
          summary: row.summary ?? null,
          lifecycleStatus: row.lifecycleStatus,
        });
      }
      return out;
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

// ─── Llmtxt mirror store ─────────────────────────────────────────────────────

/**
 * Which backend persisted the attachment.
 *
 * As of T11141 only `llmtxt` is supported by the mirror store; the `legacy`
 * variant is kept because the docs operation contracts still expose it.
 */
export type AttachmentBackend = 'llmtxt' | 'legacy';

/**
 * Input descriptor for {@link AttachmentBlobStore.put}.
 */
export interface AttachmentFileInput {
  /** User-visible name, for example `design.png`. Must not contain path separators. */
  readonly name: string;
  /** Raw bytes. */
  readonly data: Uint8Array;
  /** Optional IANA MIME type. Defaults to `application/octet-stream`. */
  readonly contentType?: string;
}

/**
 * Result returned from {@link AttachmentBlobStore.put}.
 */
export interface AttachmentPutResult {
  /** Unique attachment id as minted by the active backend. */
  readonly attachmentId: string;
  /** Lowercase hex SHA-256 digest. */
  readonly sha256: string;
  /** Which backend persisted these bytes. Always `llmtxt` as of T11141. */
  readonly backend: AttachmentBackend;
}

/**
 * Entry returned from {@link AttachmentBlobStore.list}.
 */
export interface AttachmentListEntry {
  /** Unique attachment id. */
  readonly attachmentId: string;
  /** User-visible name. */
  readonly name: string;
  /** Lowercase hex SHA-256 digest. */
  readonly sha256: string;
}

/**
 * Retrieved attachment from {@link AttachmentBlobStore.get}.
 */
export interface AttachmentGetResult {
  /** Raw bytes. */
  readonly data: Uint8Array;
  /** User-visible name. */
  readonly name: string;
  /** IANA MIME type when known. */
  readonly contentType?: string;
}

/**
 * Minimal llmtxt-backed mirror contract used by docs operations.
 */
export interface AttachmentBlobStore {
  /** Persist bytes for an owner and return backend metadata. */
  put(taskId: string, file: AttachmentFileInput): Promise<AttachmentPutResult>;

  /** Retrieve bytes by attachment id, or `null` when the id is unknown. */
  get(attachmentId: string): Promise<AttachmentGetResult | null>;

  /** List active attachments for an owner. */
  list(taskId: string): Promise<AttachmentListEntry[]>;

  /** Soft-delete an attachment by id. Unknown ids are ignored. */
  remove(attachmentId: string, taskId?: string): Promise<void>;
}

/**
 * Options for {@link createAttachmentBlobStore}.
 */
export interface CreateAttachmentBlobStoreOptions {
  /** Reserved compatibility field; callers should omit options. */
  readonly __reserved?: never;
}

/**
 * Probe whether the llmtxt-backed path is loadable in this process.
 */
async function canUseLlmtxtBackend(): Promise<boolean> {
  try {
    await import('node:sqlite');
    await import('drizzle-orm/node-sqlite');
    await import('llmtxt/blob');
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the attachment backend used for new mirror-store writes.
 *
 * The legacy fallback was retired in T11141, so this always returns `llmtxt`.
 */
export async function resolveAttachmentBackend(): Promise<AttachmentBackend> {
  return 'llmtxt';
}

/**
 * Construct the llmtxt-backed attachment mirror store.
 *
 * The returned store lazily opens the llmtxt backend on first use. If
 * `llmtxt/blob` plus Node's SQLite support are unavailable, operations throw
 * rather than silently falling back to the legacy tasks.db store.
 *
 * @param projectRoot Absolute project root used for the llmtxt manifest.
 */
export function createAttachmentBlobStore(projectRoot: string): AttachmentBlobStore {
  let llmtxtStore: CleoBlobStoreType | null | false = null;
  const llmtxtIdIndex = new Map<string, { taskId: string; name: string }>();

  async function ensureLlmtxt(): Promise<CleoBlobStoreType> {
    if (llmtxtStore === false) {
      throw new Error(
        '[attachment-store] llmtxt backend previously failed to initialize; no legacy fallback available. ' +
          'Ensure node:sqlite, drizzle-orm/node-sqlite, and llmtxt/blob are installed.',
      );
    }
    if (llmtxtStore !== null) return llmtxtStore;

    if (!(await canUseLlmtxtBackend())) {
      llmtxtStore = false;
      throw new Error(
        '[attachment-store] llmtxt backend unavailable: missing peer deps (node:sqlite, drizzle-orm/node-sqlite, llmtxt/blob). ' +
          'The legacy fallback was retired in T11141.',
      );
    }

    try {
      const { CleoBlobStore } = await import('./llmtxt-blob-adapter.js');
      const store = new CleoBlobStore({ projectRoot });
      await store.open();
      llmtxtStore = store;
      return store;
    } catch (err) {
      llmtxtStore = false;
      throw new Error(
        `[attachment-store] Failed to open llmtxt blob store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async function refreshLlmtxtIndex(
    store: CleoBlobStoreType,
    taskId: string,
  ): Promise<AttachmentListEntry[]> {
    const rows = await store.list(taskId);
    const entries: AttachmentListEntry[] = [];
    for (const row of rows) {
      llmtxtIdIndex.set(row.id, { taskId: row.docSlug, name: row.blobName });
      entries.push({
        attachmentId: row.id,
        name: row.blobName,
        sha256: row.hash,
      });
    }
    return entries;
  }

  return {
    async put(taskId, file) {
      const contentType = file.contentType ?? 'application/octet-stream';
      const llmtxt = await ensureLlmtxt();
      const res = await llmtxt.attach(taskId, file.name, file.data, contentType);
      llmtxtIdIndex.set(res.attachmentId, { taskId, name: file.name });
      return {
        attachmentId: res.attachmentId,
        sha256: res.sha256,
        backend: 'llmtxt',
      };
    },

    async get(attachmentId) {
      const llmtxt = await ensureLlmtxt();
      const key = llmtxtIdIndex.get(attachmentId);
      if (key !== undefined) {
        const blob = await llmtxt.get(key.taskId, key.name);
        if (blob !== null && blob.data !== undefined) {
          return {
            data: new Uint8Array(blob.data),
            name: blob.blobName,
            contentType: blob.contentType,
          };
        }
      }
      return null;
    },

    async list(taskId) {
      const llmtxt = await ensureLlmtxt();
      return refreshLlmtxtIndex(llmtxt, taskId);
    },

    async remove(attachmentId) {
      const llmtxt = await ensureLlmtxt();
      const key = llmtxtIdIndex.get(attachmentId);
      if (key !== undefined) {
        await llmtxt.detach(key.taskId, key.name);
        llmtxtIdIndex.delete(attachmentId);
      }
    },
  };
}
