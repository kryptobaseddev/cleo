/**
 * Docs Domain Operations Contract (5 operations)
 *
 * Query operations: 3
 * Mutate operations: 2
 *
 * Docs domain handles attachment management and document generation via `cleo docs`:
 *   - add     — attach a local file or URL to a CLEO owner entity (task, session, observation)
 *   - list    — list attachments for an owner entity
 *   - generate — generate llms.txt summary for a task/epic, optionally attach as blob
 *   - fetch   — retrieve attachment bytes and metadata by ID or SHA-256
 *   - remove  — remove an attachment ref; purges blob when refCount hits zero
 *
 * Owner type is auto-detected from the owner ID prefix:
 *   T###        → 'task'
 *   ses_*       → 'session'
 *   O-*         → 'observation'
 *   D-* (dec_*) → 'decision'
 *   L-* (lrn_*) → 'learning'
 *   P-* (pat_*) → 'pattern'
 *   (default)   → 'task'
 *
 * SYNC: Canonical implementations at packages/core/src/store/attachment*.
 * Wire-format types live here; they are the API contract for CLI + HTTP dispatch.
 *
 * @task T980 — Orchestration Coherence v4 (contract surface completion)
 * @see packages/cleo/src/dispatch/domains/docs.ts
 * @see packages/contracts/src/operations/index.ts
 */

import type { AttachmentKind } from '../attachment.js';

// ============================================================================
// Shared Attachment Types (API wire format)
// ============================================================================

/**
 * Supported attachment owner type.
 *
 * Inferred from owner ID prefix; controls which table attachment refs are stored in.
 */
export type AttachmentOwnerType =
  | 'task'
  | 'session'
  | 'observation'
  | 'decision'
  | 'learning'
  | 'pattern';

// Re-export the canonical AttachmentKind so consumers of this module do not
// need a separate import from `../attachment.js`.
export type { AttachmentKind } from '../attachment.js';

/**
 * Allowed values for the `--type` taxonomy on `cleo docs add`.
 *
 * The set is closed at the CLI surface; new values require a coordinated
 * update to (1) {@link DOCS_TYPE_VALUES}, (2) the dispatch-layer guard, and
 * (3) the citty CLI flag description. The DB column itself is open (no CHECK)
 * so older clients reading a forward-compatible value gracefully degrade.
 *
 * @task T9637 (T-DOCS-SLUG-2)
 */
export const DOCS_TYPE_VALUES = [
  'spec',
  'adr',
  'research',
  'handoff',
  'note',
  'llm-readme',
] as const;

/**
 * Closed-set type alias for {@link DOCS_TYPE_VALUES}.
 *
 * @task T9637
 */
export type DocsType = (typeof DOCS_TYPE_VALUES)[number];

/**
 * Flattened wire-format attachment row returned by docs query operations.
 *
 * This is the **API response shape** — a denormalised projection of the domain
 * {@link import('../attachment.js').AttachmentMetadata} registry row suitable for
 * CLI/HTTP serialisation.  Key differences from the domain type:
 *
 * - `kind` is lifted from the nested `attachment` object to the top level.
 * - `mime` and `size` are lifted and made optional (not all kinds carry them).
 * - The full `attachment` discriminated-union value is NOT included (too verbose
 *   for list/fetch wire responses).
 *
 * @see {@link import('../attachment.js').AttachmentMetadata} — the full domain
 *   registry row stored in `.cleo/attachments/index.db`.
 */
export interface DocsAttachmentRow {
  /** Attachment identifier (UUID-like string). */
  id: string;
  /** SHA-256 hash of content; truncated to 8 chars in list views. */
  sha256: string;
  /** Attachment kind / storage mode. */
  kind: AttachmentKind;
  /** MIME type (when applicable; omitted for url kind). */
  mime?: string;
  /** Content size in bytes (only for local-file and blob kinds). */
  size?: number;
  /** Optional human-readable description. */
  description?: string;
  /** Optional labels array for categorization. */
  labels?: string[];
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** Current reference count across all owners. */
  refCount: number;
  /**
   * Optional human-friendly slug for the attachment, unique per project.
   *
   * @task T9636 (T-DOCS-SLUG-1)
   */
  slug?: string;
  /**
   * Optional taxonomy classification.
   *
   * @task T9637 (T-DOCS-SLUG-2)
   */
  type?: DocsType;
  /**
   * When the attachment is project-scoped (no specific entity owner), this
   * row's owner ID / type still reflect how the attachment was registered.
   * The `--project` list view simply unions all owner-types.
   *
   * @task T9638 (T-DOCS-SLUG-3)
   */
  ownerId?: string;
  /** Owner type (only populated by `docs list --project`). */
  ownerType?: AttachmentOwnerType;
}

/**
 * Supported attachment backend.
 *
 * - `legacy` — original file-based store (.cleo/attachments)
 * - `llmstxt-v2` — llmtxt-backed manifest store
 */
export type AttachmentBackend = 'legacy' | 'llmstxt-v2';

/**
 * Detailed attachment record with full metadata and optional byte content.
 *
 * Returned by `docs.fetch` operation.
 */
export interface AttachmentRecord {
  /** Attachment metadata. */
  metadata: DocsAttachmentRow;
  /** File system path where bytes are stored (if applicable). */
  path?: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Base64-encoded content (only for attachments <= 1 MB). */
  bytesBase64?: string;
  /** True when bytesBase64 is populated. */
  inlined: boolean;
}

// ============================================================================
// Query Operations
// ============================================================================

// --------------------------------------------------------------------------
// docs.list — list attachments for an owner
// --------------------------------------------------------------------------

/**
 * Parameters for `docs.list`.
 *
 * Exactly one of `task`, `session`, `observation`, or `project` must be
 * provided. `project=true` lists ALL attachments in the project DB
 * regardless of owner. `type` is an optional filter applicable to every
 * mode and matches the {@link DocsType} taxonomy exactly.
 *
 * @task T9637 (T-DOCS-SLUG-2 — `type` filter)
 * @task T9638 (T-DOCS-SLUG-3 — `project` scope)
 */
export interface DocsListParams {
  /** Task identifier to list attachments for. */
  task?: string;
  /** Session identifier to list attachments for. */
  session?: string;
  /** Observation identifier to list attachments for. */
  observation?: string;
  /**
   * When true, list ALL attachments in the project (across every owner).
   *
   * @task T9638
   */
  project?: boolean;
  /**
   * Filter results to attachments whose `type` column equals this value.
   *
   * @task T9637
   */
  type?: DocsType;
}

/**
 * Result of `docs.list`.
 *
 * When the caller passed `project: true`, `ownerId` is the empty string and
 * `ownerType` is `"task"` (a stable placeholder so consumers don't have to
 * widen their types); per-row owner information is carried on the
 * {@link DocsAttachmentRow.ownerId} / `ownerType` fields instead.
 */
export interface DocsListResult {
  /** Owner entity ID (empty when `project: true`). */
  ownerId: string;
  /** Inferred owner type (placeholder when `project: true`). */
  ownerType: AttachmentOwnerType;
  /** True when the result represents the whole-project scope (T9638). */
  project?: boolean;
  /** Type taxonomy filter, echoed back from the request when provided. */
  type?: DocsType;
  /** Count of attachments for this owner. */
  count: number;
  /** Attachment metadata array. */
  attachments: DocsAttachmentRow[];
  /** Current attachment backend in use. */
  attachmentBackend?: AttachmentBackend;
}

// --------------------------------------------------------------------------
// docs.fetch — retrieve attachment bytes and metadata by ID or SHA-256
// --------------------------------------------------------------------------

/**
 * Parameters for `docs.fetch`.
 */
export interface DocsFetchParams {
  /** Attachment reference: attachment ID or SHA-256 hex string (required). */
  attachmentRef: string;
}

/**
 * Result of `docs.fetch`.
 */
export interface DocsFetchResult {
  /** Flattened attachment metadata row for this attachment. */
  metadata: DocsAttachmentRow;
  /** File system path where bytes are stored (if applicable). */
  path?: string;
  /** Total size in bytes. */
  sizeBytes: number;
  /** Base64-encoded content (only for attachments <= 1 MB). */
  bytesBase64?: string;
  /** True when bytesBase64 is populated. */
  inlined: boolean;
  /** Current attachment backend in use. */
  attachmentBackend?: AttachmentBackend;
}

// --------------------------------------------------------------------------
// docs.generate — generate llms.txt summary and optionally attach
// --------------------------------------------------------------------------

/**
 * Parameters for `docs.generate`.
 */
export interface DocsGenerateParams {
  /** Task or epic ID to generate llms.txt for (required). */
  for: string;
  /** When true, attach the generated content as a blob (optional). */
  attach?: boolean;
}

/**
 * Result of `docs.generate`.
 */
export interface DocsGenerateResult {
  /** ID of the task/epic that was summarized. */
  forId: string;
  /** Generated llms.txt content. */
  content: string;
  /** Count of attachments that were included in the summary. */
  attachmentCount: number;
  /** True when the llmtxt package was used (false = fallback). */
  usedLlmtxtPackage: boolean;
  /** True when --attach was specified and attachment succeeded. */
  attached: boolean;
  /** Attachment ID if attached (when `attached === true`). */
  attachmentId?: string;
  /** SHA-256 hash of attachment if attached (when `attached === true`). */
  attachmentSha256?: string;
}

// ============================================================================
// Mutate Operations
// ============================================================================

// --------------------------------------------------------------------------
// docs.add — attach a local file or URL to an owner
// --------------------------------------------------------------------------

/**
 * Parameters for `docs.add`.
 *
 * Exactly one of `file` or `url` must be provided.
 */
export interface DocsAddParams {
  /** Owner entity ID (task, session, observation, etc.) — required. */
  ownerId: string;
  /** Local file path to attach (mutually exclusive with `url`). */
  file?: string;
  /** URL to attach as reference (mutually exclusive with `file`). */
  url?: string;
  /** Optional human-readable description. */
  desc?: string;
  /** Optional comma-separated labels for categorization. */
  labels?: string;
  /** Agent or service that attached this file (default: 'human'). */
  attachedBy?: string;
  /**
   * Optional human-friendly slug, unique per project. Pattern: kebab-case,
   * `[a-z0-9][a-z0-9-]*[a-z0-9]?` (≥1 char, ≤80 chars). Collision returns
   * `E_SLUG_TAKEN` with 3 alternative suggestions.
   *
   * @task T9636 (T-DOCS-SLUG-1)
   */
  slug?: string;
  /**
   * Optional taxonomy classification. Must match one of
   * {@link DOCS_TYPE_VALUES}; an invalid value returns `E_INVALID_TYPE`.
   *
   * @task T9637 (T-DOCS-SLUG-2)
   */
  type?: DocsType;
}

/**
 * Result of `docs.add`.
 */
export interface DocsAddResult {
  /** Newly-created or existing attachment ID. */
  attachmentId: string;
  /** SHA-256 hash of the attached content. */
  sha256: string;
  /** Current reference count for this attachment. */
  refCount: number;
  /** Attachment kind that was stored. */
  kind: AttachmentKind;
  /** Owner entity ID. */
  ownerId: string;
  /** Inferred owner type. */
  ownerType: AttachmentOwnerType;
  /** URL if `kind === 'url'` (otherwise omitted). */
  url?: string;
  /** Current attachment backend in use. */
  attachmentBackend?: AttachmentBackend;
  /** Slug recorded for this attachment, when provided (T9636). */
  slug?: string;
  /** Type classification recorded for this attachment, when provided (T9637). */
  type?: DocsType;
}

// --------------------------------------------------------------------------
// docs.remove — remove an attachment ref
// --------------------------------------------------------------------------

/**
 * Parameters for `docs.remove`.
 */
export interface DocsRemoveParams {
  /** Attachment reference: attachment ID or SHA-256 hex (required). */
  attachmentRef: string;
  /** Owner entity ID to remove the ref from (required). */
  from: string;
}

/**
 * Result of `docs.remove`.
 */
export interface DocsRemoveResult {
  /** True when the attachment blob was fully purged (refCount hit zero). */
  removed: boolean;
  /** Attachment ID that was dereferenced. */
  attachmentId: string;
  /** Owner entity ID. */
  from: string;
  /** Reference count after dereference (0 if blob was purged). */
  refCountAfter: number;
  /** True when blob was purged (duplicate of `removed` for clarity). */
  blobPurged: boolean;
  /** Current attachment backend in use. */
  attachmentBackend?: AttachmentBackend;
}

// ============================================================================
// Discriminated Union (DocsOps)
// ============================================================================

/**
 * Discriminated union of all docs domain operations.
 *
 * Consumed by `packages/cleo/src/dispatch/domains/docs.ts` via `TypedDomainHandler<DocsOps>`.
 *
 * @remarks
 * Pattern: each variant specifies `op` (operation name), `params` (input),
 * and `result` (output). The dispatch layer uses the `op` discriminator to
 * route to the correct handler method and validate types.
 */
export type DocsOps =
  | { op: 'docs.list'; params: DocsListParams; result: DocsListResult }
  | { op: 'docs.fetch'; params: DocsFetchParams; result: DocsFetchResult }
  | { op: 'docs.generate'; params: DocsGenerateParams; result: DocsGenerateResult }
  | { op: 'docs.add'; params: DocsAddParams; result: DocsAddResult }
  | { op: 'docs.remove'; params: DocsRemoveParams; result: DocsRemoveResult };

/**
 * Enumeration of all docs domain operation names.
 *
 * @remarks
 * Useful for dynamic operation dispatch, type narrowing, or documentation.
 * Kept in sync with the `DocsOps` discriminated union above.
 */
export type DocsOp = 'docs.list' | 'docs.fetch' | 'docs.generate' | 'docs.add' | 'docs.remove';
