/**
 * Thin read-only BlobOps façade — T947 Step 1.
 *
 * Exposes a minimal content-addressed read API backed by `llmtxt/blob`
 * via {@link CleoBlobStore}. The write path lives in
 * {@link ./attachment-store-v2.ts}; this module is intentionally
 * read-only so callers that only need to verify or retrieve blobs do
 * not have to instantiate the full v2 store and its lazy-init machinery.
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
 * @see ./attachment-store-v2.ts (write path + unified interface)
 * @see ./llmtxt-blob-adapter.ts (CleoBlobStore — llmtxt/blob wrapper)
 */

import { getProjectRoot } from '../paths.js';
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
      }),
    );
  } finally {
    await store.close();
  }
}
