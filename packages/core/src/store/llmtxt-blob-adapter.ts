/**
 * CLEO blob store backed by `llmtxt/blob`'s {@link BlobFsAdapter}.
 *
 * Wraps llmtxt's content-addressed blob filesystem store into a CLEO-shaped
 * API that mirrors the surface of {@link ../store/attachment-store.ts} for
 * future drop-in replacement. Satisfies owner Constraint #4 (zero primitive
 * duplication) per GitHub issue #96 — CLEO no longer rolls its own SHA-256
 * hashing, tmp-rename atomic writes, or orphan tracking; those primitives
 * are sourced from llmtxt's WASM-backed core and tracked on the llmtxt
 * release cadence.
 *
 * Wiring model:
 *   - `BlobFsAdapter` requires a `NodeSQLiteDatabase<Record<string, never>>`
 *     that owns a `blob_attachments` table (manifest + LWW).
 *   - Bytes live at `<projectRoot>/.cleo/blobs/blobs/<sha256-hex>`.
 *     The nested `blobs/` subdir is BlobFsAdapter's internal convention.
 *   - We lazy-load `node:sqlite` + `drizzle-orm/node-sqlite` — both ship
 *     with Node 24 and drizzle-orm v1.0.0-beta, so no optional peer deps
 *     are required. A pre-constructed DB may also be injected via
 *     {@link CleoBlobStoreOptions.db}.
 *
 * Retirement plan (Wave B): the existing `packages/core/src/store/attachment-store.ts`
 * (643 LoC) will be migrated caller-by-caller to this store. Both stores
 * stay operational in parallel during the transition — do NOT delete
 * `attachment-store.ts` in this wave.
 *
 * @epic T947
 * @see packages/core/src/store/attachment-store.ts (legacy, kept in parallel)
 * @see https://github.com/kryptobaseddev/llmtxt (llmtxt/blob subpath)
 */

import path from 'node:path';
import type { AttachBlobParams, BlobAttachment, BlobData } from 'llmtxt/blob';
import {
  BlobAccessDeniedError,
  BlobCorruptError,
  BlobFsAdapter,
  BlobNameInvalidError,
  BlobNotFoundError,
  BlobTooLargeError,
  hashBlob,
} from 'llmtxt/blob';

// ─── Public error re-exports ──────────────────────────────────────────────────
// Callers can catch these without an extra import from llmtxt.

export type { AttachBlobParams, BlobAttachment, BlobData };
export {
  BlobAccessDeniedError,
  BlobCorruptError,
  BlobNameInvalidError,
  BlobNotFoundError,
  BlobTooLargeError,
};

/**
 * Options for constructing a {@link CleoBlobStore}.
 */
export interface CleoBlobStoreOptions {
  /**
   * Absolute path to the project root. The store writes to
   * `<projectRoot>/.cleo/blobs/` by default.
   */
  readonly projectRoot: string;

  /**
   * Optional SQLite file path for the blob manifest. Defaults to
   * `<projectRoot>/.cleo/blobs/manifest.db`.
   */
  readonly manifestDbPath?: string;

  /**
   * Optional absolute storage path override. Defaults to
   * `<projectRoot>/.cleo/blobs`. BlobFsAdapter will write bytes to
   * `<storagePath>/blobs/<hash>` beneath this directory.
   */
  readonly storagePath?: string;

  /**
   * Maximum blob size in bytes. Defaults to 100 MiB (llmtxt default).
   */
  readonly maxBlobSizeBytes?: number;

  /**
   * Injected pre-constructed Drizzle database. When provided, takes
   * precedence over `manifestDbPath`. Useful for tests that want to
   * share a single in-memory DB or for integrations that already own
   * a Drizzle connection.
   *
   * Typed as `unknown` to avoid a hard compile-time dependency on
   * `drizzle-orm/node-sqlite` — the runtime shape is validated by
   * BlobFsAdapter's constructor.
   */
  readonly db?: unknown;
}

/**
 * Result returned by {@link CleoBlobStore.attach}.
 */
export interface CleoBlobAttachResult {
  /** Unique attachment id (nanoid, 21 chars). */
  readonly attachmentId: string;
  /** Lowercase hex SHA-256 digest (64 chars) — content-address. */
  readonly sha256: string;
  /** Byte size of the stored blob. */
  readonly size: number;
  /** MIME content type recorded at attach time. */
  readonly contentType: string;
}

/**
 * Lazy-loaded Drizzle ctor + node:sqlite ctor bundle.
 * Cached at module scope so a second instantiation does not re-require
 * the modules.
 *
 * Note: drizzle-orm v1.0.0-beta requires `drizzle({ client: nativeDb })` —
 * the v0.x positional-arg form `drizzle(nativeDb)` silently opens a fresh
 * in-memory connection, which would cause "no such table" errors at query
 * time even though the bootstrap DDL succeeded. We pass the config object
 * form below to stay compatible with v1.0.
 */
let _drizzleCtor: {
  drizzle: (config: { client: unknown }) => unknown;
  NodeSqliteDatabase: new (filename: string) => unknown;
} | null = null;

/**
 * Lazy-load `node:sqlite` + `drizzle-orm/node-sqlite`.
 *
 * Both ship with Node 24 and drizzle-orm v1.0.0-beta respectively —
 * no optional peer deps required.
 *
 * @internal
 */
async function loadDrizzle(): Promise<NonNullable<typeof _drizzleCtor>> {
  if (_drizzleCtor !== null) return _drizzleCtor;
  const { DatabaseSync } = await import('node:sqlite');
  const drizzleMod = (await import('drizzle-orm/node-sqlite')) as {
    drizzle: (config: { client: unknown }) => unknown;
  };
  _drizzleCtor = {
    drizzle: drizzleMod.drizzle,
    NodeSqliteDatabase: DatabaseSync,
  };
  return _drizzleCtor;
}

/**
 * Content-addressed blob store backed by `llmtxt/blob.BlobFsAdapter`.
 *
 * Mirrors the behavioural contract of {@link ../attachment-store.ts}:
 *   - Same bytes attached twice produce the same SHA-256 (dedup).
 *   - Detach is a soft delete; bytes remain on disk until orphan GC.
 *   - Hash is verified on every `get(includeData=true)` read.
 *
 * Use a per-task scoping model: CLEO passes `taskId` as the llmtxt `docSlug`
 * so the LWW semantics (newest upload wins for `(docSlug, blobName)`) apply
 * naturally to CLEO attachments.
 *
 * @example
 * ```ts
 * import { CleoBlobStore } from '@cleocode/core/store/llmtxt-blob-adapter';
 *
 * const store = new CleoBlobStore({ projectRoot: process.cwd() });
 * await store.open();
 *
 * const { attachmentId, sha256 } = await store.attach(
 *   'T123',
 *   'design.png',
 *   new Uint8Array(Buffer.from('fake png bytes')),
 *   'image/png',
 * );
 * const blob = await store.get('T123', 'design.png');
 * // ...
 * await store.close();
 * ```
 */
export class CleoBlobStore {
  private readonly opts: CleoBlobStoreOptions;
  private adapter: BlobFsAdapter | null = null;
  /**
   * The node:sqlite native Database handle. Retained so {@link close}
   * can release the file descriptor. `null` when the caller injected a
   * pre-constructed DB (ownership stays with the caller).
   */
  private ownedNativeDb: { close(): void } | null = null;

  /**
   * Construct a new store. Call {@link open} to initialize the backing
   * SQLite manifest + blob directory before any attach/get/list/detach.
   */
  constructor(opts: CleoBlobStoreOptions) {
    this.opts = opts;
  }

  /**
   * Initialize the backing Drizzle database and BlobFsAdapter.
   *
   * Idempotent — a second call is a no-op. Creates the `blob_attachments`
   * manifest table and ensures the storage directory exists.
   */
  async open(): Promise<void> {
    if (this.adapter !== null) return;

    const storagePath = this.opts.storagePath ?? path.join(this.opts.projectRoot, '.cleo', 'blobs');
    const manifestDbPath = this.opts.manifestDbPath ?? path.join(storagePath, 'manifest.db');

    let db: unknown;
    if (this.opts.db !== undefined) {
      db = this.opts.db;
    } else {
      const { drizzle, NodeSqliteDatabase } = await loadDrizzle();
      // Ensure parent dir exists before opening the SQLite file.
      const { mkdir } = await import('node:fs/promises');
      await mkdir(path.dirname(manifestDbPath), { recursive: true });
      const nativeDb = new NodeSqliteDatabase(manifestDbPath);
      this.ownedNativeDb = nativeDb as { close(): void };
      // drizzle v1.0 API — must pass `{ client: nativeDb }` to reuse the
      // already-opened native handle. Positional form opens a new DB.
      db = drizzle({ client: nativeDb });
      // Bootstrap the `blob_attachments` table. BlobFsAdapter imports the
      // schema from llmtxt's local module; we replicate the DDL so tests +
      // fresh installs work without running llmtxt's migration pipeline.
      ensureBlobAttachmentsTable(nativeDb as SqliteExecLike);
    }

    // cast: BlobFsAdapter's constructor types `db` as a Drizzle SQLite database.
    // `drizzle({ client: nativeDb })` returns a NodeSQLiteDatabase which satisfies
    // the same interface at runtime. The llmtxt runtime does not introspect the
    // generic, so this cast is safe.
    this.adapter = new BlobFsAdapter(
      db as ConstructorParameters<typeof BlobFsAdapter>[0],
      storagePath,
      this.opts.maxBlobSizeBytes,
    );
  }

  /**
   * Close the store, releasing the SQLite file descriptor when this
   * store owns it. Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (this.ownedNativeDb !== null) {
      try {
        this.ownedNativeDb.close();
      } finally {
        this.ownedNativeDb = null;
      }
    }
    this.adapter = null;
  }

  /**
   * Attach a blob to a task. Returns attachment id + sha256.
   *
   * @param taskId Task identifier (used as llmtxt docSlug).
   * @param name User-visible attachment name (e.g. "design.png"). Must pass
   *             {@link llmtxt/blob.validateBlobName} — no path separators,
   *             no path traversal, no null bytes, ≤255 UTF-8 bytes.
   * @param data Raw bytes. Buffer or Uint8Array accepted.
   * @param contentType MIME type. Defaults to `application/octet-stream`.
   *
   * @throws BlobNameInvalidError on bad `name`.
   * @throws BlobTooLargeError when `data` exceeds the configured max size.
   */
  async attach(
    taskId: string,
    name: string,
    data: Uint8Array,
    contentType: string = 'application/octet-stream',
  ): Promise<CleoBlobAttachResult> {
    const adapter = this.ensureOpen();
    const params: AttachBlobParams = {
      docSlug: taskId,
      name,
      data,
      contentType,
      uploadedBy: 'cleo',
    };
    const row = adapter.attachBlob(params);
    return {
      attachmentId: row.id,
      sha256: row.hash,
      size: row.size,
      contentType: row.contentType,
    };
  }

  /**
   * Retrieve the blob manifest row + bytes for a `(taskId, name)` pair.
   *
   * Returns `null` (NOT throws) when no active attachment exists for the
   * requested name. Throws {@link BlobCorruptError} when on-disk bytes
   * do not match the recorded hash.
   */
  async get(taskId: string, name: string): Promise<BlobData | null> {
    const adapter = this.ensureOpen();
    return adapter.getBlob(taskId, name, { includeData: true });
  }

  /**
   * List active (non-detached) attachments for a task, manifest-only
   * (no bytes).
   */
  async list(taskId: string): Promise<BlobAttachment[]> {
    const adapter = this.ensureOpen();
    return adapter.listBlobs(taskId);
  }

  /**
   * Detach (soft-delete) an attachment. Returns silently when no
   * active attachment exists for the given name.
   */
  async detach(taskId: string, name: string): Promise<void> {
    const adapter = this.ensureOpen();
    adapter.detachBlob(taskId, name, 'cleo');
  }

  /**
   * Compute the SHA-256 content hash of raw bytes WITHOUT storing them.
   *
   * Delegates to `llmtxt/blob.hashBlob` (WASM-backed, matches the Rust
   * `llmtxt-core::hash_blob` primitive exactly).
   *
   * @returns Lowercase hex SHA-256 digest (64 chars).
   */
  static hash(data: Uint8Array): string {
    return hashBlob(data);
  }

  /** @internal */
  private ensureOpen(): BlobFsAdapter {
    if (this.adapter === null) {
      throw new Error('CleoBlobStore: call open() before any operation');
    }
    return this.adapter;
  }
}

// ─── Internal: blob_attachments DDL ──────────────────────────────────────────

/**
 * Minimal typing for the subset of `node:sqlite`'s `DatabaseSync` surface we
 * use during manifest bootstrap.
 */
interface SqliteExecLike {
  exec(sql: string): unknown;
}

/**
 * Idempotently create the `blob_attachments` table llmtxt's BlobFsAdapter
 * reads and writes. DDL is derived from
 * `node_modules/llmtxt/dist/local/schema-local.js` (llmtxt@2026.4.9).
 *
 * Safe to call on an existing manifest — uses `CREATE TABLE IF NOT EXISTS`.
 *
 * @internal
 */
function ensureBlobAttachmentsTable(db: SqliteExecLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blob_attachments (
      id TEXT PRIMARY KEY,
      doc_slug TEXT NOT NULL,
      blob_name TEXT NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      content_type TEXT NOT NULL,
      uploaded_by TEXT NOT NULL,
      uploaded_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS blob_attachments_doc_slug_idx
      ON blob_attachments(doc_slug);
    CREATE INDEX IF NOT EXISTS blob_attachments_hash_idx
      ON blob_attachments(hash);
  `);
}
