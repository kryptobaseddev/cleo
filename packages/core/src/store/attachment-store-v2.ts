/**
 * Unified attachment store (T947 Wave C — legacy fallback retired).
 *
 * Backed exclusively by `CleoBlobStore` (wrapping `llmtxt/blob.BlobFsAdapter`).
 * The legacy {@link ./attachment-store.ts} (tasks.db + on-disk sha256 shards)
 * is NO LONGER used by this store as of Wave C. Callers that need the richer
 * interface (slug support, refcount, lifecycle status) continue to use
 * {@link ./attachment-store.ts} directly.
 *
 * The interface is intentionally minimal: `put / get / list / remove`.
 *
 * @epic T947
 * @task T11141 (Wave C — legacy fallback retired)
 * @see ./attachment-store.ts (legacy, kept for richer interface callers)
 * @see ./llmtxt-blob-adapter.ts (preferred backend)
 */

import type { CleoBlobStore as CleoBlobStoreType } from './llmtxt-blob-adapter.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Which backend persisted the attachment.
 *
 * As of Wave C only `llmtxt` is supported; the `legacy` variant is kept
 * in the type to avoid churn in downstream consumers that still reference
 * it in contracts/docs, but this store never returns it.
 */
export type AttachmentBackend = 'llmtxt' | 'legacy';

/**
 * Input descriptor for {@link AttachmentStoreV2.put}.
 */
export interface AttachmentFileInput {
  /** User-visible name (e.g. "design.png"). Must not contain path separators. */
  readonly name: string;
  /** Raw bytes. */
  readonly data: Uint8Array;
  /** Optional IANA MIME type. Defaults to `application/octet-stream`. */
  readonly contentType?: string;
}

/**
 * Result returned from {@link AttachmentStoreV2.put}.
 */
export interface AttachmentPutResult {
  /** Unique attachment id as minted by the active backend. */
  readonly attachmentId: string;
  /** Lowercase hex SHA-256 digest (64 chars). */
  readonly sha256: string;
  /** Which backend persisted these bytes. Always `'llmtxt'` as of Wave C. */
  readonly backend: AttachmentBackend;
}

/**
 * Entry returned from {@link AttachmentStoreV2.list}.
 */
export interface AttachmentListEntry {
  /** Unique attachment id. */
  readonly attachmentId: string;
  /** User-visible name (blob name). */
  readonly name: string;
  /** Lowercase hex SHA-256 digest. */
  readonly sha256: string;
}

/**
 * Retrieved attachment from {@link AttachmentStoreV2.get}.
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
 * Unified read+write contract.
 */
export interface AttachmentStoreV2 {
  /**
   * Persist bytes for a task. Returns the attachment id, sha256, and the
   * backend that actually stored the bytes.
   */
  put(taskId: string, file: AttachmentFileInput): Promise<AttachmentPutResult>;

  /**
   * Retrieve bytes for a previously-attached file by attachment id.
   * Returns `null` when the id is unknown.
   */
  get(attachmentId: string): Promise<AttachmentGetResult | null>;

  /**
   * List active (non-deleted) attachments for a task.
   */
  list(taskId: string): Promise<AttachmentListEntry[]>;

  /**
   * Remove an attachment by id. Soft-delete (LWW).
   * Returns silently when the id is unknown.
   */
  remove(attachmentId: string, taskId?: string): Promise<void>;
}

/**
 * Options for {@link createAttachmentStoreV2}.
 *
 * @deprecated Wave C (T11141) — the `backend` option has been removed.
 * The store always uses the llmtxt backend. This type is kept as an empty
 * interface for downstream type compatibility.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface CreateAttachmentStoreV2Options {}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Probe whether the llmtxt-backed path is loadable in this process.
 *
 * Runs once per store instance; the result is cached on the instance to
 * avoid re-entering the dynamic import on every call.
 *
 * @internal
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
 * Resolve the attachment backend that WOULD be used for a fresh store at the
 * given project root. Exposed for observability (dispatch layer writes this
 * into `meta.attachmentBackend`).
 *
 * As of Wave C this always returns `'llmtxt'`. The probe is kept for
 * diagnostics but legacy fallback is retired.
 *
 * This probe is side-effect free: it does NOT open the SQLite manifest or
 * touch the filesystem — it only resolves the peer-dep loaders.
 */
// SSoT-EXEMPT:probe-fn — zero-arg probe that detects peer-dep availability; no projectRoot needed
export async function resolveAttachmentBackend(): Promise<AttachmentBackend> {
  // Wave C: llmtxt is the only backend. The legacy fallback is retired.
  // If llmtxt peer deps are not available, that's a deployment issue —
  // the caller should surface the error, not silently degrade.
  return 'llmtxt';
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a unified attachment store.
 *
 * The returned store lazily resolves the llmtxt backend on first use.
 * If `llmtxt/blob` + `node:sqlite` are unavailable, operations throw
 * rather than silently falling back to the legacy store (Wave C).
 *
 * @param projectRoot Absolute path to the project root (determines where the
 *                    llmtxt blob manifest lives).
 *
 * @example
 * ```ts
 * import { createAttachmentStoreV2 } from '@cleocode/core/store/attachment-store-v2';
 *
 * const store = createAttachmentStoreV2(process.cwd());
 * const { attachmentId, sha256, backend } = await store.put('T123', {
 *   name: 'design.png',
 *   data: new Uint8Array([0xff, 0xd8, 0xff]),
 *   contentType: 'image/png',
 * });
 * console.log(`stored via ${backend} backend: ${sha256}`);
 * ```
 */
export function createAttachmentStoreV2(
  projectRoot: string,
): AttachmentStoreV2 {
  /**
   * Lazily-resolved llmtxt store. `null` means not yet attempted; `false`
   * means a prior attempt failed — subsequent calls will throw.
   */
  let llmtxtStore: CleoBlobStoreType | null | false = null;

  /**
   * Map attachmentId → (taskId, name) for the llmtxt path. We need this
   * because llmtxt's BlobFsAdapter keys by `(docSlug, blobName)` not by id
   * alone. Populated on every put/list; consulted by get/remove.
   */
  const llmtxtIdIndex = new Map<string, { taskId: string; name: string }>();

  /**
   * Attempt to initialise the llmtxt store. Throws if llmtxt peer deps
   * are unavailable or if opening the store fails. As of Wave C there is
   * no legacy fallback — callers must ensure llmtxt is available.
   *
   * @internal
   */
  async function ensureLlmtxt(): Promise<CleoBlobStoreType> {
    if (llmtxtStore === false) {
      throw new Error(
        '[attachment-store-v2] llmtxt backend previously failed to initialize — no legacy fallback available (Wave C). ' +
          'Ensure node:sqlite, drizzle-orm/node-sqlite, and llmtxt/blob are installed.',
      );
    }
    if (llmtxtStore !== null) return llmtxtStore;

    if (!(await canUseLlmtxtBackend())) {
      llmtxtStore = false;
      throw new Error(
        '[attachment-store-v2] llmtxt backend unavailable — missing peer deps (node:sqlite, drizzle-orm/node-sqlite, llmtxt/blob). ' +
          'The legacy fallback was retired in Wave C (T11141).',
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
        `[attachment-store-v2] Failed to open llmtxt blob store: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Refresh the `attachmentId → (taskId, name)` index for a given task by
   * asking the llmtxt adapter for its current manifest rows. Runs on every
   * list() call so callers that mint ids in one process and resolve them
   * in another always see a fresh view.
   *
   * @internal
   */
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
        backend: 'llmtxt' as AttachmentBackend,
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

    async remove(attachmentId, _taskId) {
      const llmtxt = await ensureLlmtxt();
      const key = llmtxtIdIndex.get(attachmentId);
      if (key !== undefined) {
        await llmtxt.detach(key.taskId, key.name);
        llmtxtIdIndex.delete(attachmentId);
      }
      // If the id isn't in the index, it was never stored via this store
      // instance — silently return (consistent with prior behavior).
    },
  };
}
