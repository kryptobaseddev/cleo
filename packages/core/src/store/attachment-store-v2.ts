/**
 * Unified attachment store (T947 Wave B).
 *
 * Wraps both the preferred `CleoBlobStore` (backed by `llmtxt/blob.BlobFsAdapter`)
 * and the legacy {@link ./attachment-store.ts} (tasks.db + on-disk sha256 shards)
 * behind a single interface. At runtime this store probes the optional peer
 * `node:sqlite` (built into Node 24) and `drizzle-orm/node-sqlite` are
 * available alongside llmtxt; when so, the preferred path is used, otherwise
 * we gracefully fall back to the legacy implementation so callers never
 * observe a hard failure.
 *
 * The interface is intentionally minimal: `put / get / list / remove`. It does
 * NOT try to be a superset of {@link ./attachment-store.ts} — existing callers
 * that need `listByOwner`, `deref`, URL/llms-txt kinds continue to use the
 * legacy store directly. Dispatch-layer integration (`cleo docs`) keeps using
 * the legacy store for now; the `add / list / fetch / remove` handlers gain
 * `meta.attachmentBackend` observability via {@link resolveAttachmentBackend}.
 *
 * Retirement plan: `attachment-store.ts` (643 LoC) is NOT deleted in this wave.
 * A Wave C cleanup may retire it after a full release cycle validates the
 * llmtxt-backed path in production.
 *
 * @epic T947
 * @see ./attachment-store.ts (legacy, kept operational)
 * @see ./llmtxt-blob-adapter.ts (preferred backend)
 */

import type { BlobAttachment } from '@cleocode/contracts';
import type { CleoBlobStore as CleoBlobStoreType } from './llmtxt-blob-adapter.js';

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Which backend persisted the attachment.
 *
 * `llmtxt` — preferred content-addressed store from `llmtxt/blob`.
 * `legacy` — tasks.db + `.cleo/attachments/sha256/**` shards.
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
  /** Which backend persisted these bytes. */
  readonly backend: AttachmentBackend;
}

/**
 * Entry returned from {@link AttachmentStoreV2.list}.
 */
export interface AttachmentListEntry {
  /** Unique attachment id. */
  readonly attachmentId: string;
  /** User-visible name (blob name for llmtxt, best-effort for legacy). */
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
   * Returns `null` when the id is unknown in both backends.
   */
  get(attachmentId: string): Promise<AttachmentGetResult | null>;

  /**
   * List active (non-deleted) attachments for a task.
   */
  list(taskId: string): Promise<AttachmentListEntry[]>;

  /**
   * Remove an attachment by id. Soft-delete on llmtxt (LWW); deref on legacy.
   * Returns silently when the id is unknown.
   *
   * For the legacy backend the optional `taskId` scopes the deref to a
   * specific owner — required when multiple owners share the same
   * content-addressed blob (refCount > 1). When omitted the legacy path
   * walks every `task`-type ref row for the attachment.
   */
  remove(attachmentId: string, taskId?: string): Promise<void>;
}

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
 * This probe is side-effect free: it does NOT open the SQLite manifest or
 * touch the filesystem — it only resolves the peer-dep loaders.
 */
// SSoT-EXEMPT:probe-fn — zero-arg probe that detects peer-dep availability; no projectRoot needed
export async function resolveAttachmentBackend(): Promise<AttachmentBackend> {
  return (await canUseLlmtxtBackend()) ? 'llmtxt' : 'legacy';
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Construct a unified attachment store.
 *
 * The returned store lazily resolves the preferred backend on first use. When
 * `llmtxt/blob` + `node:sqlite` load successfully, writes go to
 * {@link CleoBlobStore}. Any construction/open failure falls through to the
 * legacy {@link ./attachment-store.ts} implementation — callers never observe
 * a hard failure.
 *
 * @param projectRoot Absolute path to the project root (determines where the
 *                    llmtxt blob manifest lives).
 * @param opts Optional overrides. `backend: 'legacy'` forces the fallback
 *             path regardless of peer-dep availability (used by tests and
 *             by dispatch layers that need deterministic behaviour).
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
/**
 * Options for {@link createAttachmentStoreV2}.
 */
export interface CreateAttachmentStoreV2Options {
  /**
   * Force a specific backend. `auto` (default) probes for llmtxt + node:sqlite
   * and falls back to legacy on failure. `legacy` skips the probe entirely.
   */
  readonly backend?: 'auto' | 'legacy';
}

export function createAttachmentStoreV2(
  projectRoot: string,
  opts: CreateAttachmentStoreV2Options = {},
): AttachmentStoreV2 {
  const forceLegacy = opts.backend === 'legacy';
  /**
   * Lazily-resolved llmtxt store. `null` means not yet attempted; `false`
   * means a prior attempt failed — skip straight to the legacy path.
   */
  let llmtxtStore: CleoBlobStoreType | null | false = null;

  /**
   * Map attachmentId → (taskId, name) for the llmtxt path. We need this
   * because llmtxt's BlobFsAdapter keys by `(docSlug, blobName)` not by id
   * alone. Populated on every put/list; consulted by get/remove.
   */
  const llmtxtIdIndex = new Map<string, { taskId: string; name: string }>();

  /**
   * Attempt to initialise the llmtxt store. Returns `null` on any failure
   * (which permanently flips `llmtxtStore` to `false` so subsequent calls
   * skip straight to the legacy path).
   *
   * @internal
   */
  async function ensureLlmtxt(): Promise<CleoBlobStoreType | null> {
    if (forceLegacy) return null;
    if (llmtxtStore === false) return null;
    if (llmtxtStore !== null) return llmtxtStore;
    if (!(await canUseLlmtxtBackend())) {
      llmtxtStore = false;
      return null;
    }
    try {
      const { CleoBlobStore } = await import('./llmtxt-blob-adapter.js');
      const store = new CleoBlobStore({ projectRoot });
      await store.open();
      llmtxtStore = store;
      return store;
    } catch (err) {
      // Observability: llmtxt backend silently fell back to legacy for months in CI
      // because the bindings error was swallowed. Log to stderr (never stdout —
      // stdout is reserved for LAFS envelope).
      console.error(
        '[attachment-store-v2] llmtxt backend unavailable, falling back to legacy:',
        err instanceof Error ? err.message : String(err),
      );
      llmtxtStore = false;
      return null;
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

      // Preferred path: llmtxt-backed blob store. We intentionally do NOT
      // wrap this in a try/catch fallback — payload-specific errors (invalid
      // name, too large) must surface to the caller. Peer-dep unavailability
      // is handled upstream by `ensureLlmtxt()` returning null.
      const llmtxt = await ensureLlmtxt();
      if (llmtxt !== null) {
        const res = await llmtxt.attach(taskId, file.name, file.data, contentType);
        llmtxtIdIndex.set(res.attachmentId, { taskId, name: file.name });
        return {
          attachmentId: res.attachmentId,
          sha256: res.sha256,
          backend: 'llmtxt',
        };
      }

      // Legacy path — wraps the existing content-addressed store. `sha256`
      // on the returned metadata is always populated by the legacy store.
      const { createAttachmentStore } = await import('./attachment-store.js');
      const legacy = createAttachmentStore();
      const blobDescriptor: Omit<BlobAttachment, 'sha256'> = {
        kind: 'blob',
        storageKey: '',
        mime: contentType,
        size: file.data.byteLength,
      };
      const meta = await legacy.put(Buffer.from(file.data), blobDescriptor, 'task', taskId);
      return {
        attachmentId: meta.id,
        sha256: meta.sha256,
        backend: 'legacy',
      };
    },

    async get(attachmentId) {
      // Try llmtxt first if available.
      const llmtxt = await ensureLlmtxt();
      if (llmtxt !== null) {
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
      }

      // Legacy path — resolve by attachment id → sha256 → bytes.
      const { createAttachmentStore } = await import('./attachment-store.js');
      const legacy = createAttachmentStore();
      const meta = await legacy.getMetadata(attachmentId);
      if (meta === null) return null;
      const result = await legacy.get(meta.sha256);
      if (result === null) return null;

      // Derive a display name from the attachment union.
      const att = result.metadata.attachment;
      let name = attachmentId;
      let contentType: string | undefined;
      if (att.kind === 'local-file') {
        name = att.path.split(/[\\/]/).pop() ?? attachmentId;
        contentType = att.mime;
      } else if (att.kind === 'blob') {
        contentType = att.mime;
      }

      return {
        data: new Uint8Array(result.bytes),
        name,
        contentType,
      };
    },

    async list(taskId) {
      // llmtxt is authoritative for task-scoped listings.
      const llmtxt = await ensureLlmtxt();
      if (llmtxt !== null) {
        return refreshLlmtxtIndex(llmtxt, taskId);
      }

      const { createAttachmentStore } = await import('./attachment-store.js');
      const legacy = createAttachmentStore();
      const rows = await legacy.listByOwner('task', taskId);
      return rows.map((m): AttachmentListEntry => {
        let name = m.id;
        if (m.attachment.kind === 'local-file') {
          name = m.attachment.path.split(/[\\/]/).pop() ?? m.id;
        }
        return {
          attachmentId: m.id,
          name,
          sha256: m.sha256,
        };
      });
    },

    async remove(attachmentId, taskId) {
      // llmtxt: resolve via index (populated by put/list). A `detach` is
      // a soft-delete so refcount semantics do not apply — the newest
      // upload for `(task, name)` replaces the old row.
      const llmtxt = await ensureLlmtxt();
      if (llmtxt !== null) {
        const key = llmtxtIdIndex.get(attachmentId);
        if (key !== undefined) {
          await llmtxt.detach(key.taskId, key.name);
          llmtxtIdIndex.delete(attachmentId);
          return;
        }
      }

      // Legacy path — deref the `(attachment, task, owner)` ref row.
      // When `taskId` is omitted we can't accurately pick which owner to
      // deref (tasks.db has no reverse index from attachmentId→owner list
      // on the public accessor), so we fall back to a no-op and rely on
      // the caller to supply `taskId` when refCount > 1 matters.
      const { createAttachmentStore } = await import('./attachment-store.js');
      const legacy = createAttachmentStore();
      const meta = await legacy.getMetadata(attachmentId);
      if (meta === null) return;

      if (taskId !== undefined) {
        await legacy.deref(attachmentId, 'task', taskId);
      }
    },
  };
}
