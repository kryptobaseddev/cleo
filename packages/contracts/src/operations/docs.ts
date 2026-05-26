/**
 * Docs Domain Operations Contract (7 operations)
 *
 * Query operations: 3
 * Mutate operations: 4
 *
 * Docs domain handles attachment management and document generation via `cleo docs`:
 *   - add        — attach a local file or URL to a CLEO owner entity (task, session, observation)
 *   - list       — list attachments for an owner entity
 *   - generate   — generate llms.txt summary for a task/epic, optionally attach as blob
 *   - fetch      — retrieve attachment bytes and metadata by ID or SHA-256
 *   - remove     — remove an attachment ref; purges blob when refCount hits zero
 *   - update     — UPDATE-in-place via slug (T10161)
 *   - supersede  — atomically flip an older doc to `superseded` and link it to its successor (T10162)
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
import { BUILTIN_DOC_KIND_VALUES, type BuiltinDocKind } from '../docs-taxonomy.js';

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
 * As of T9788 this is derived from the canonical {@link BUILTIN_DOC_KIND_VALUES}
 * in `docs-taxonomy.ts` — adding a kind there automatically widens this set
 * without a duplicate edit here.
 *
 * Project-level extensions registered through `.cleo/docs-config.json` are
 * NOT included in this constant (they are runtime-only, since the
 * compile-time union must stay closed). Use {@link DocKindRegistry.list}
 * to enumerate built-ins plus extensions at runtime.
 *
 * @task T9637 (T-DOCS-SLUG-2)
 * @task T9788 (E-DOCS-TAXONOMY-V2 — registry consolidation)
 */
export const DOCS_TYPE_VALUES: ReadonlyArray<BuiltinDocKind> =
  BUILTIN_DOC_KIND_VALUES as ReadonlyArray<BuiltinDocKind>;

/**
 * Closed-set type alias for {@link DOCS_TYPE_VALUES}.
 *
 * As of T9788 this aliases {@link BuiltinDocKind} from the canonical
 * registry — the union widens automatically when a new built-in kind
 * is added to {@link BUILTIN_DOC_KINDS}.
 *
 * @task T9637
 * @task T9788
 */
export type DocsType = BuiltinDocKind;

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
 * Sort key for `docs.list` results.
 *
 * - `newest` — descending by `createdAt` (default — most recent first).
 * - `sha`    — ascending by `sha256` (stable lexicographic).
 * - `slug`   — ascending by `slug`; entries without a slug sort last.
 *
 * @task T9792
 */
export type DocsListOrderBy = 'newest' | 'sha' | 'slug';

/**
 * Default maximum number of rows returned by `docs.list` when the caller
 * does not pass an explicit `limit`. Mirrored on the CLI flag default so the
 * dispatch and CLI surfaces agree on the browsing window.
 *
 * @task T9792
 */
export const DOCS_LIST_DEFAULT_LIMIT = 50;

/**
 * Parameters for `docs.list`.
 *
 * Scope is auto-promoted to whole-project when no owner-scope flag is set
 * (T9792). Pre-T9792 callers MUST still pass `project: true` explicitly to
 * stay forward-compatible — the auto-promote happens at the CLI layer.
 * `type` is an optional filter applicable to every mode and matches the
 * {@link DocsType} taxonomy exactly.
 *
 * @task T9637 (T-DOCS-SLUG-2 — `type` filter)
 * @task T9638 (T-DOCS-SLUG-3 — `project` scope)
 * @task T9792 (E-DOCS-LIST-UX-FIX — auto-promote project scope + limit + orderBy)
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
  /**
   * Maximum number of rows to return. Defaults to
   * {@link DOCS_LIST_DEFAULT_LIMIT} when omitted. Values `<= 0` are treated
   * as "no limit" so agents can opt-in to the full result set explicitly.
   *
   * @task T9792
   */
  limit?: number;
  /**
   * Sort key for the returned rows. Defaults to `newest` when omitted.
   *
   * @task T9792
   */
  orderBy?: DocsListOrderBy;
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
  /** Count of attachments for this owner (after limit + filters). */
  count: number;
  /**
   * Total number of attachments matching the scope + filters BEFORE the
   * `limit` window was applied. Only emitted when `limit` truncated the
   * result set so consumers can distinguish "fewer than limit" from
   * "limit truncated".
   *
   * @task T9792
   */
  totalCount?: number;
  /**
   * Effective limit applied to this response. Mirrored from the request
   * (or {@link DOCS_LIST_DEFAULT_LIMIT} when the request did not set one)
   * so consumers can paginate without re-deriving the default.
   *
   * @task T9792
   */
  limit?: number;
  /**
   * Effective sort key applied to this response. Mirrored from the request
   * (or `"newest"` when the request did not set one).
   *
   * @task T9792
   */
  orderBy?: DocsListOrderBy;
  /**
   * Optional human-readable hint surfaced when a default behaviour kicked
   * in (e.g. project scope auto-promoted because no scope was passed). The
   * CLI surfaces this through `meta.hint` so JSON consumers can detect that
   * a narrower invocation may have been intended.
   *
   * @task T9792
   */
  hint?: string;
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
   * Optional human-readable title — used to derive the kebab-slug tail when
   * auto-allocating an ADR slug. REQUIRED when `type === 'adr'` AND `slug`
   * is omitted; ignored otherwise. The allocator slugifies the title via
   * the shared kebabize helper.
   *
   * @task T10360 (closes T10153)
   */
  title?: string;
  /**
   * Optional taxonomy classification. Must match one of
   * {@link DOCS_TYPE_VALUES}; an invalid value returns `E_INVALID_TYPE`.
   *
   * @task T9637 (T-DOCS-SLUG-2)
   */
  type?: DocsType;
  /**
   * When `true`, body-schema validation against
   * {@link DocKindMetadata.requiredSections} is enforced — a missing
   * required H2 section returns `E_DOC_SCHEMA_MISMATCH` with the
   * missing-sections list in `details.missing`. When omitted or `false`,
   * the validator runs in advisory mode: the write proceeds and any
   * missing sections surface as a warning in the envelope's `meta`.
   *
   * Only meaningful when `file` is set; URL attachments skip body
   * validation (no local bytes to scan).
   *
   * @task T10160 (E12.C3 · absorbs T10154)
   * @epic T10157
   * @saga T9855
   */
  strict?: boolean;
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
  /**
   * Auto-allocated ADR number, present iff the slug was minted by
   * {@link allocateAdrSlug} (i.e. `--type adr` without `--slug`).
   *
   * @task T10360
   */
  adrNumber?: number;
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

// --------------------------------------------------------------------------
// docs.update — UPDATE-in-place via slug (T10161)
// --------------------------------------------------------------------------

/**
 * Allowed `lifecycle_status` values mirrored from the attachments-table enum
 * (`ATTACHMENT_LIFECYCLE_STATUSES` in
 * `packages/core/src/store/schema/attachments.ts`). Kept inline here so the
 * contract surface stays self-contained — the dispatch handler narrows raw
 * `--status` input against this set before touching the store.
 *
 * @task T10161 (Epic T10157 / Saga T9855)
 */
export const DOCS_LIFECYCLE_STATUSES = [
  'draft',
  'proposed',
  'accepted',
  'superseded',
  'archived',
  'deprecated',
] as const;

export type DocsLifecycleStatus = (typeof DOCS_LIFECYCLE_STATUSES)[number];

/**
 * Parameters for `docs.update`.
 *
 * Replaces the blob content for an existing slug — the slug is transferred
 * from the old `attachments` row to a new row carrying the new sha256, and
 * the old row remains reachable by attachment-id for history. Unlike
 * {@link DocsSupersedeParams}-style flows, NO supersession edge is created
 * (callers wanting an explicit lineage edge should use `cleo docs supersede`).
 *
 * Exactly one of `file` or `content` MUST be provided.
 *
 * @task T10161 (Epic T10157 / Saga T9855 — E12.C4)
 */
export interface DocsUpdateParams {
  /** Slug of the existing attachment to update (required). */
  slug: string;
  /** Path to a local file containing the new content. */
  file?: string;
  /**
   * Permit `file` to resolve outside the canonical project root.
   *
   * Mirrors `docs.add` worktree routing for explicitly opted-in callers while
   * preserving path-traversal protection for default `docs.update` usage.
   */
  allowExternal?: boolean;
  /** Inline UTF-8 content (mutually exclusive with `file`). */
  content?: string;
  /** Optional one-line summary describing the change (recorded in the audit log). */
  message?: string;
  /**
   * Override the new lifecycle status. Defaults to `'draft'` on every update
   * so an explicit `accepted` doc gets back-pressured to draft on edit. Pass
   * `--status accepted` (or any other valid status) to override.
   */
  status?: DocsLifecycleStatus;
  /** Validate/preflight only; do not mutate attachment rows, blob storage, or audit logs. */
  dryRun?: boolean;
  /** Fail body-schema diagnostics instead of surfacing advisory warnings. */
  strict?: boolean;
  /** Agent identity that performed the update (default: `'human'`). */
  attachedBy?: string;
}

/**
 * Result of `docs.update`.
 *
 * Identifies the new row (active) and the row it replaced. When the supplied
 * content is byte-identical to the current content the operation is a noop —
 * `previousSha256` will equal `sha256` and `changed` will be `false`.
 *
 * @task T10161
 */
export interface DocsUpdateResult {
  /** Slug that now points at the new content. */
  slug: string;
  /** Type/kind of the row, preserved from the prior version. */
  type?: DocsType;
  /** New attachment ID now bearing the slug. */
  attachmentId: string;
  /** Previous attachment ID; retains its row + bytes for history. */
  previousAttachmentId: string;
  /** SHA-256 hex of the new content. */
  sha256: string;
  /** SHA-256 hex of the prior content (equals `sha256` on a noop). */
  previousSha256: string;
  /** Whether the bytes actually changed (false ⇒ noop). */
  changed: boolean;
  /** Lifecycle status now stored on the new row. */
  lifecycleStatus: DocsLifecycleStatus;
  /** ISO 8601 timestamp the new row was registered. */
  updatedAt: string;
  /**
   * Best-effort 1-indexed version number for the slug (count of historical
   * rows that ever carried this slug, including the current one). When the
   * underlying store cannot enumerate history this falls back to `2` for the
   * first update and increments by 1 thereafter.
   */
  version: number;
  /**
   * True when this update was squashed into an existing audit entry within
   * the 5-minute squash window (no new audit line was written).
   */
  squashed: boolean;
  /** Present when this response came from a preview-only update. */
  dryRun?: true;
  /** False for dry-runs because no write was actually performed. */
  wouldWrite?: boolean;
  /** Preview-only indicator that the requested bytes/status differ from the active row. */
  wouldChange?: boolean;
}

// --------------------------------------------------------------------------
// docs.supersede — flip an old doc to `superseded` and point at its successor
// --------------------------------------------------------------------------

/**
 * Parameters for `docs.supersede`.
 *
 * Both `oldSlug` and `newSlug` reference rows on `attachments.slug`. The
 * operation is atomic: either both rows update (and the lifecycle flip lands)
 * or neither does.
 *
 * @task T10162 (Saga T9855 · Epic T10157 · ADR-078)
 */
export interface DocsSupersedeParams {
  /** Slug of the doc being replaced. */
  oldSlug: string;
  /** Slug of the doc that replaces {@link oldSlug}. */
  newSlug: string;
  /**
   * Optional human-readable reason surfaced on the response envelope and
   * preserved by future provenance-graph reads (T10166 `summary` field on
   * the `supersedes` edge). Not persisted to a dedicated column today.
   */
  reason?: string;
}

/**
 * Result of `docs.supersede`.
 *
 * @task T10162 (Saga T9855 · Epic T10157 · ADR-078)
 */
export interface DocsSupersedeResult {
  /** Slug of the doc that was just superseded. */
  oldSlug: string;
  /** Slug of the new doc that supersedes {@link oldSlug}. */
  newSlug: string;
  /** Attachment ID resolved from {@link oldSlug}. */
  oldAttachmentId: string;
  /** Attachment ID resolved from {@link newSlug}. */
  newAttachmentId: string;
  /** ISO-8601 timestamp the supersession was recorded. */
  supersededAt: string;
  /**
   * Stable identifier for the lineage edge minted by this call.
   *
   * The edge itself is not stored in a dedicated table — it is reconstructed
   * at read time from `attachments.supersedes` / `attachments.superseded_by`
   * by `cleo docs provenance` (T10166). The ID is deterministic
   * (`supersedes:<newAttachmentId>->&<oldAttachmentId>`) so concurrent callers
   * that win the transaction race observe a stable value.
   */
  edgeId: string;
  /** Optional reason carried through from the request. */
  reason?: string;
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
  | { op: 'docs.remove'; params: DocsRemoveParams; result: DocsRemoveResult }
  | { op: 'docs.update'; params: DocsUpdateParams; result: DocsUpdateResult }
  | { op: 'docs.supersede'; params: DocsSupersedeParams; result: DocsSupersedeResult };

/**
 * Enumeration of all docs domain operation names.
 *
 * @remarks
 * Useful for dynamic operation dispatch, type narrowing, or documentation.
 * Kept in sync with the `DocsOps` discriminated union above.
 */
export type DocsOp =
  | 'docs.list'
  | 'docs.fetch'
  | 'docs.generate'
  | 'docs.add'
  | 'docs.remove'
  | 'docs.update'
  | 'docs.supersede';
