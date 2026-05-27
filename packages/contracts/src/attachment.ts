/**
 * Attachment discriminated union and metadata types.
 *
 * An `Attachment` represents any content artifact that can be associated
 * with a CLEO owner (task, observation, session, decision, learning, pattern).
 * Five attachment kinds are supported:
 * - `local-file`  — a file on disk, tracked by path + SHA-256 hash
 * - `url`         — a remote URL, optionally cached to the content-addressed store
 * - `blob`        — raw bytes stored content-addressed in `.cleo/attachments/sha256/`
 * - `llms-txt`    — a generated or fetched llms.txt site-index snapshot (RFC llmstxt.org)
 * - `llmtxt-doc`  — a pointer into an llmtxt document (local or remote backend)
 *
 * `AttachmentMetadata` is the row persisted in the attachment registry.
 * `AttachmentRef` is the junction row linking an attachment to an owner.
 *
 * @epic T760
 * @task T795
 * @see {@link https://github.com/kryptobaseddev/cleo} T760 unified attachments
 */

// ─── Attachment variants ──────────────────────────────────────────────────────

/**
 * A file on disk inside or adjacent to the CLEO project.
 *
 * The `path` is stored as recorded at attach time; the `sha256` is the content
 * hash computed at that moment. On fetch, the runtime re-hashes the file and
 * emits a warning if the file has drifted from the stored hash.
 */
export interface LocalFileAttachment {
  kind: 'local-file';
  /** Path to the file (absolute or project-root-relative, forward-slashes only). */
  path: string;
  /** SHA-256 hex digest of the file at attach time. */
  sha256: string;
  /** IANA MIME type (e.g., `"text/markdown"`, `"application/pdf"`). */
  mime: string;
  /** File size in bytes at attach time. */
  size: number;
  /** Optional free-text description of what this file contains. */
  description?: string;
  /** Labels for filtering (e.g., `["rfc", "spec"]`). */
  labels?: string[];
}

/**
 * A remote URL, optionally cached to the content-addressed store.
 *
 * When `--cache` is passed on attach, the body is fetched, hashed, and stored
 * at `.cleo/attachments/sha256/<hash[0..2]>/<hash[2..]>.<ext>`. The
 * `cachedSha256` and `cachedAt` fields are populated on a successful cache.
 */
export interface UrlAttachment {
  kind: 'url';
  /** The remote URL. Must be a valid absolute URL. */
  url: string;
  /** SHA-256 of the fetched body if the URL has been cached locally. */
  cachedSha256?: string;
  /** ISO 8601 timestamp when the body was cached. */
  cachedAt?: string;
  /** IANA MIME type detected from the Content-Type header. */
  mime?: string;
  /** Optional free-text description. */
  description?: string;
  /** Labels for filtering. */
  labels?: string[];
}

/**
 * Raw bytes stored content-addressed in `.cleo/attachments/sha256/`.
 *
 * No external path dependency — the content is always retrievable by
 * `storageKey` as long as the attachment has a positive `refCount`.
 */
export interface BlobAttachment {
  kind: 'blob';
  /** SHA-256 hex digest of the uncompressed content. */
  sha256: string;
  /** Storage key inside `.cleo/attachments/sha256/` (e.g., `"ab/abcdef…12.pdf"`). */
  storageKey: string;
  /** IANA MIME type. */
  mime: string;
  /** Size of the uncompressed content in bytes. */
  size: number;
  /** Optional free-text description. */
  description?: string;
  /** Labels for filtering. */
  labels?: string[];
}

/**
 * A generated or fetched llms.txt site-index snapshot (per llmstxt.org spec).
 *
 * The content is stored inline — llms.txt files are small by design.
 * `source: 'url'` means it was fetched from a remote site;
 * `source: 'generated'` means it was produced by `cleo docs generate`.
 */
export interface LlmsTxtAttachment {
  kind: 'llms-txt';
  /** Where the llms.txt content originated. */
  source: 'url' | 'generated';
  /**
   * Full markdown content of the llms.txt (stored inline; small by design per
   * the llmstxt.org spec).
   */
  content: string;
  /** SHA-256 hex digest of `content`. */
  sha256: string;
  /** Optional free-text description. */
  description?: string;
  /** Labels for filtering. */
  labels?: string[];
}

/**
 * A pointer into an llmtxt document managed by a local or remote backend.
 *
 * `backend: 'local'`  — the document lives in `.cleo/llmtxt/` (llmtxt LocalBackend).
 * `backend: 'remote'` — the document lives on an llmtxt.my SaaS instance.
 *
 * This attachment kind delegates content storage to the llmtxt package; CLEO
 * only stores the pointer (slug + backend + optional pinned version).
 */
export interface LlmtxtDocAttachment {
  kind: 'llmtxt-doc';
  /** Document slug from the llmtxt backend (e.g., `"9fZLOnf5"`). */
  slug: string;
  /** Which backend owns the document. */
  backend: 'local' | 'remote';
  /**
   * Version string pinned at attach time.
   *
   * For `local` backends this is the integer version number serialised as a
   * string; for `remote` backends it is the version identifier returned by the
   * API.
   */
  pinnedVersion?: string;
  /** Optional free-text description. */
  description?: string;
  /** Labels for filtering. */
  labels?: string[];
}

// ─── Discriminated union ──────────────────────────────────────────────────────

/**
 * A content artifact attachable to any CLEO owner
 * (task, observation, session, decision, learning, or pattern).
 *
 * The `kind` field is the discriminant. All variants share optional
 * `description` and `labels` fields.
 *
 * @example
 * ```ts
 * const att: Attachment = {
 *   kind: 'local-file',
 *   path: 'docs/rfc-003.md',
 *   sha256: 'a1b2c3...ff',
 *   mime: 'text/markdown',
 *   size: 8192,
 *   description: 'RFC draft v3',
 *   labels: ['rfc', 'spec'],
 * };
 * ```
 */
export type Attachment =
  | LocalFileAttachment
  | UrlAttachment
  | BlobAttachment
  | LlmsTxtAttachment
  | LlmtxtDocAttachment;

/** All valid `kind` discriminants for `Attachment`. */
export type AttachmentKind = Attachment['kind'];

// ─── Registry row ─────────────────────────────────────────────────────────────

/**
 * Persisted metadata row for one attachment in the attachment registry
 * (`.cleo/attachments/index.db`).
 *
 * The full {@link Attachment} value is stored as a JSON blob in the `attachment`
 * field so the registry does not need a column per variant.
 */
export interface AttachmentMetadata {
  /**
   * Unique attachment ID.
   *
   * Pattern: `att_<base62>` — generated by `llmtxt.generateId()` or a UUID
   * fallback.
   */
  id: string;
  /**
   * Content hash.
   *
   * For `local-file`, `blob`, and `llms-txt` variants this is the SHA-256
   * of the bytes at attach time. For `url` it is `cachedSha256` when the URL
   * has been cached, or the empty string when it has not. For `llmtxt-doc` it
   * is the empty string (content is managed by the llmtxt backend).
   */
  sha256: string;
  /** The full attachment value (all kind-specific fields). */
  attachment: Attachment;
  /** ISO 8601 timestamp when this attachment was first registered. */
  createdAt: string;
  /**
   * How many {@link AttachmentRef} rows point at this attachment.
   *
   * When `refCount` drops to zero the blob is eligible for GC via
   * `cleo docs attachments gc`. Blobs are NEVER auto-deleted.
   */
  refCount: number;
}

// ─── Junction row ─────────────────────────────────────────────────────────────

/**
 * Junction row linking one attachment to one owner.
 *
 * Stored in the `attachment_refs` table of `.cleo/attachments/index.db`.
 * A single attachment can be referenced by multiple owners simultaneously
 * (e.g., the same RFC PDF attached to an epic and to every child task).
 */
export interface AttachmentRef {
  /** ID of the attachment (→ `attachments.id`). */
  attachmentId: string;
  /**
   * The domain entity type that owns this attachment.
   *
   * Determines which CLEO store to query when resolving the owner's display
   * name (`tasks.db` for task/session/decision/learning/pattern;
   * `brain.db` for observation).
   */
  ownerType: 'task' | 'observation' | 'session' | 'decision' | 'learning' | 'pattern';
  /** The ID of the owning entity (e.g., `"T766"`, `"O-abc123"`, `"ses_..."`). */
  ownerId: string;
  /** ISO 8601 timestamp when the ref was created. */
  attachedAt: string;
  /**
   * Agent identity (or `"human"`) that created the ref.
   *
   * Populated from the active session's agent credential when available.
   */
  attachedBy?: string;
}
