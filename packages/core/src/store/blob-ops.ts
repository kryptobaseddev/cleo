/**
 * Thin read-only BlobOps façade — T947 Step 1.
 *
 * Exposes a minimal content-addressed read API backed by `llmtxt/blob`
 * via {@link CleoBlobStore}. The write path lives in
 * {@link ./attachment-store.ts}; this module is intentionally
 * read-only so callers that only need to verify or retrieve blobs do
 * not have to instantiate the full mirror store and its lazy-init machinery.
 *
 * Pass-through contract (owner Constraint #4):
 *   - NEVER re-implements hashing, SHA-256 comparison, or blob-name
 *     validation — those come from `llmtxt/blob` verbatim.
 *   - Returns `null` (not throws) when a blob is not found; throws on
 *     corruption so hash-verify-on-read is surfaced to callers.
 *
 * Lifecycle:
 *   - {@link blobRead} / {@link blobList} lazy-open a per-call
 *     {@link CleoBlobStore} scoped to `projectRoot` and close it on
 *     completion. This is safe for the read path where concurrent
 *     multi-process access is expected and open/close overhead is
 *     acceptable. Long-running callers that batch many reads should
 *     use {@link CleoBlobStore} directly.
 *
 * @epic T947
 * @see ./attachment-store.ts (write path + unified interface)
 * @see ./llmtxt-blob-adapter.ts (CleoBlobStore — llmtxt/blob wrapper)
 */

import { getProjectRoot } from '../paths.js';
import { resolveStoreOwnerRoot } from '../project-scope.js';
import { CleoBlobStore } from './llmtxt-blob-adapter.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Manifest entry returned by {@link blobList}.
 *
 * Mirrors `llmtxt/blob.BlobAttachment` fields in a CLEO-idiomatic shape
 * without creating a hard compile-time dependency on llmtxt's type.
 */
export interface BlobListEntry {
  /** User-visible attachment name (e.g. "design.png"). */
  readonly name: string;
  /** Lowercase hex SHA-256 digest (64 chars). Content-address. */
  readonly sha256: string;
  /** Byte size of the stored blob. */
  readonly sizeBytes: number;
  /** IANA MIME type recorded at attach time, when known. */
  readonly mimeType?: string;
  /** Unix epoch ms when the blob was uploaded. Used for latest-version selection. */
  readonly uploadedAt?: number;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read raw bytes for a named attachment on a task.
 *
 * Hash-verifies the blob on read (llmtxt/blob contract). Returns `null`
 * when no active attachment exists for the `(taskId, name)` pair. Throws
 * {@link import('llmtxt/blob').BlobCorruptError} when on-disk bytes do not
 * match the recorded SHA-256.
 *
 * @param taskId - CLEO task identifier used as the llmtxt docSlug.
 * @param name   - User-visible attachment name (e.g. `"design.png"`).
 * @param projectRoot - Absolute project root. Defaults to `getProjectRoot()`.
 * @returns Raw bytes, or `null` when the attachment is not found.
 *
 * @throws {BlobCorruptError} when on-disk bytes fail SHA-256 verification.
 *
 * @example
 * ```ts
 * import { blobRead } from '@cleocode/core/store/blob-ops';
 *
 * const bytes = await blobRead('T123', 'design.png');
 * if (bytes) {
 *   console.log(`read ${bytes.byteLength} bytes`);
 * }
 * ```
 *
 * @epic T947
 */
export async function blobRead(
  taskId: string,
  name: string,
  projectRoot?: string,
): Promise<Uint8Array | null> {
  const root = projectRoot ?? getProjectRoot();
  const store = new CleoBlobStore({ projectRoot: root });
  await store.open();
  try {
    const blob = await store.get(taskId, name);
    if (blob === null || blob.data === undefined) return null;
    return new Uint8Array(blob.data);
  } finally {
    await store.close();
  }
}

/**
 * Read raw bytes for a blob directly from its content-addressed store path,
 * without resolving an (owner, name) manifest pair first.
 *
 * The llmtxt BlobFsAdapter stores bytes at
 * `<project .cleo>/blobs/blobs/<sha256-hex>`, so a sha256 alone is a
 * complete address. Used by the docs read/publish paths after the legacy
 * attachment byte tree was retired (T13362): the doc registry still resolves
 * metadata (slug, owner refs), but content always comes from the blob store.
 *
 * Hash-verifies the bytes against the address (a mismatch means corruption
 * or a wrong guess) and returns `null` when the file is absent — mirrors
 * {@link blobRead}'s null-not-throws contract. An absent file is first healed
 * from hash-verified legacy bytes when they exist (T13705), so docs written
 * before the blob store held every body read without a manual repair.
 *
 * @param sha256 - Lowercase hex SHA-256 of the content.
 * @param projectRoot - Absolute project root. Defaults to `getProjectRoot()`.
 * @returns Raw bytes, or `null` when the blob is not in the store.
 * @throws {Error} when on-disk bytes fail SHA-256 verification.
 *
 * @task T13362
 */
export async function blobReadBySha(
  sha256: string,
  projectRoot?: string,
): Promise<Uint8Array | null> {
  const root = projectRoot ?? getProjectRoot();
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  // T14127: a CLEO worktree reads its parent project's store, as the writers
  // write it, never the `.cleo/` seeded into the worktree itself.
  const cleoDir = join(resolveStoreOwnerRoot(root), '.cleo');
  const file = join(cleoDir, 'blobs', 'blobs', sha256.toLowerCase());
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch {
    // T13705: a doc whose bytes predate the blob store heals on first read
    // from hash-verified legacy bytes; otherwise the miss stands.
    // The heal never throws on its write (T13706): verified bytes are served.
    const { healBlobFromLegacy } = await import('./blob-keep.js');
    return healBlobFromLegacy(cleoDir, sha256.toLowerCase());
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== sha256.toLowerCase()) {
    // @sync-invariant none:local-only a corrupt local blob file is a read-side integrity refusal; no synced row is written or mutated
    throw new Error(`blobReadBySha: corrupt blob at ${file}: expected sha256=${sha256}`);
  }
  return bytes;
}

/**
 * List active (non-detached) attachment manifests for a task.
 *
 * Returns an empty array (not throws) when no blobs are attached to the
 * task. Does NOT return raw bytes — manifest metadata only.
 *
 * @param taskId      - CLEO task identifier used as the llmtxt docSlug.
 * @param projectRoot - Absolute project root. Defaults to `getProjectRoot()`.
 * @returns Array of manifest entries. Empty when no blobs are attached.
 *
 * @example
 * ```ts
 * import { blobList } from '@cleocode/core/store/blob-ops';
 *
 * const entries = await blobList('T123');
 * for (const e of entries) {
 *   console.log(`${e.name}  sha256=${e.sha256}  size=${e.sizeBytes}`);
 * }
 * ```
 *
 * @epic T947
 */
export async function blobList(taskId: string, projectRoot?: string): Promise<BlobListEntry[]> {
  const root = projectRoot ?? getProjectRoot();
  const store = new CleoBlobStore({ projectRoot: root });
  await store.open();
  try {
    const rows = await store.list(taskId);
    return rows.map(
      (row): BlobListEntry => ({
        name: row.blobName,
        sha256: row.hash,
        sizeBytes: row.size,
        mimeType: row.contentType === 'application/octet-stream' ? undefined : row.contentType,
        uploadedAt: row.uploadedAt,
      }),
    );
  } finally {
    await store.close();
  }
}
