/**
 * Project-scope `cleo.db` — consolidated **docs** domain (D11 collapse).
 *
 * Part of the consolidated PROJECT-scope `cleo.db` target shape authored for
 * SG-DB-SUBSTRATE-V2 (saga T11242, epic T11245/E2, task T11360). This module is
 * **target-shape authoring only** — it carries the domain-prefixed Pattern-A
 * physical table names and the E10 strict typing the exodus migration
 * (T11248) will deploy. The live runtime modules under
 * `packages/core/src/store/schema/{attachments,manifest}.ts` keep their
 * UNPREFIXED physical names until exodus swaps the substrate; do not point
 * runtime accessors at this module.
 *
 * ## D11 — the docs collapse (AC3)
 *
 * The legacy `attachments` / `attachment_refs` (attachment store) and
 * `manifest_entries` / `pipeline_manifest` (RCASD provenance manifest) table
 * families collapse into ONE `docs_*` schema. There is no separate
 * `attachments_*` or `llmtxt_*` family in the consolidated substrate — every
 * document-bearing table lives under the `docs_` prefix:
 *
 *   - `docs_attachments`        ← `attachments`
 *   - `docs_attachment_refs`    ← `attachment_refs`
 *   - `docs_manifest_entries`   ← `manifest_entries`
 *   - `docs_pipeline_manifest`  ← `pipeline_manifest`
 *
 * ## E10 typing applied (per docs/migration/sqlite-schema-canonical.md)
 *
 * - **§3b boolean non-conformer:** `pipeline_manifest.distilled` was already
 *   `integer({ mode: 'boolean' })` — preserved.
 * - **§4 timestamps:** every timestamp column is the canonical TEXT ISO8601
 *   form (`datetime('now')`); none were epoch non-conformers in this domain.
 * - **§5 enum-like bare TEXT:** `manifest_entries.status` already carries
 *   `{ enum: MANIFEST_STATUSES }` (kept). `attachments.type` and
 *   `pipeline_manifest.{type,status}` are §5b non-conformers whose legal value
 *   set is **writer-derived / open taxonomy** (attachment `type` is a free
 *   doc-kind tag validated at the dispatch layer; pipeline `type` is mapped
 *   from phase-directory names and pipeline `status` is written dynamically).
 *   Per §8.3 + the `attachments.ts` precedent (dispatch-layer validation so new
 *   taxonomy needs no migration) these remain documented bare TEXT — the CHECK
 *   list cannot be hand-frozen without rejecting valid writes. Flagged for the
 *   exodus writer audit (T11248) rather than guessed here.
 * - **§6a JSON-in-TEXT (AC4):** JSON columns use the existing E4 `jsonb<T>()`
 *   pattern from `../jsonb.js` for the columns the JSON-Column Audit routes to
 *   JSONB, and remain serialized TEXT (with a documented read rule) for the
 *   columns that audit keeps as TEXT. No new JSON pattern is invented.
 *
 * @task T11360
 * @epic T11245
 * @saga T11242
 * @see docs/migration/sqlite-schema-canonical.md §1 (D1″) · §3b · §5 · §6a
 * @see docs/migration/sqlite-schema-columns.json (per-column affinity SSoT)
 */

import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { MANIFEST_STATUSES } from '../../status-registry.js';
import { ATTACHMENT_LIFECYCLE_STATUSES, ATTACHMENT_OWNER_TYPES } from '../attachments.js';

/**
 * `docs_attachments` — content-addressed registry of stored documents/blobs.
 *
 * Domain-prefixed target of the legacy `attachments` table (D11 collapse).
 *
 * @task T11360 (target shape) · T796 (original)
 */
export const docsAttachments = sqliteTable(
  'docs_attachments',
  {
    /** Unique attachment identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** SHA-256 hex digest of the uncompressed content. Unique across the registry. */
    sha256: text('sha256').notNull().unique(),
    /**
     * Serialised `Attachment` discriminated union (all kind-specific fields).
     *
     * JSON-in-TEXT (§6a). Kept as TEXT per the JSON-Column Audit disposition
     * (not routed to JSONB); read-time validation lives in the dispatch layer.
     */
    attachmentJson: text('attachment_json').notNull(),
    /** ISO-8601 UTC creation instant (canonical TEXT timestamp, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** Number of `docs_attachment_refs` rows pointing here; GC-eligible at 0. */
    refCount: integer('ref_count').notNull().default(0),
    /** Optional human-friendly slug, unique per project. */
    slug: text('slug'),
    /**
     * Optional doc-kind taxonomy tag (§5b non-conformer).
     *
     * Open taxonomy validated at the dispatch layer — see module docs. Left as
     * bare TEXT; the exodus writer audit (T11248) enumerates the legal set.
     */
    type: text('type'),
    /** Document workflow state — CHECK-backed via {@link ATTACHMENT_LIFECYCLE_STATUSES}. */
    lifecycleStatus: text('lifecycle_status', { enum: ATTACHMENT_LIFECYCLE_STATUSES })
      .notNull()
      .default('draft'),
    /** Forward supersession pointer (→ `docs_attachments.id`); NULL if none. */
    supersedes: text('supersedes').references((): AnySQLiteColumn => docsAttachments.id),
    /** Reverse supersession pointer (→ `docs_attachments.id`); NULL while active. */
    supersededBy: text('superseded_by').references((): AnySQLiteColumn => docsAttachments.id),
    /** Optional one-sentence human summary, distinct from the full body. */
    summary: text('summary'),
    /** Optional JSON array of free-form keyword strings (TEXT per JSON audit). */
    keywords: text('keywords'),
    /** Optional JSON array of canonical topic slugs (TEXT per JSON audit). */
    topics: text('topics'),
    /** Optional JSON array of related `T####` task IDs (TEXT per JSON audit). */
    relatedTasks: text('related_tasks'),
    /** CLEO release version that wrote this row (docs version SSoT anchor). */
    ownerVersion: text('owner_version'),
    /** Sequential doc-version counter for this slug; 1 for new rows. */
    docVersion: integer('doc_version').notNull().default(1),
  },
  (table) => [
    index('idx_docs_attachments_sha256').on(table.sha256),
    index('idx_docs_attachments_lifecycle_status').on(table.lifecycleStatus),
    index('idx_docs_attachments_supersedes').on(table.supersedes),
  ],
);

/**
 * `docs_attachment_refs` — ref-counted junction linking attachments to owners.
 *
 * Domain-prefixed target of the legacy `attachment_refs` table (D11 collapse).
 *
 * @task T11360 (target shape) · T796 (original)
 */
export const docsAttachmentRefs = sqliteTable(
  'docs_attachment_refs',
  {
    /** ID of the attachment (→ `docs_attachments.id`). */
    attachmentId: text('attachment_id').notNull(),
    /** Domain entity type that owns this ref — CHECK-backed. */
    ownerType: text('owner_type', { enum: ATTACHMENT_OWNER_TYPES }).notNull(),
    /** The ID of the owning entity. */
    ownerId: text('owner_id').notNull(),
    /** ISO-8601 UTC instant when this ref was created (canonical TEXT, §4). */
    attachedAt: text('attached_at').notNull(),
    /** Agent identity (or `"human"`) that created this ref. */
    attachedBy: text('attached_by'),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.ownerType, table.ownerId] }),
    index('idx_docs_attachment_refs_attachment_id').on(table.attachmentId),
    index('idx_docs_attachment_refs_owner').on(table.ownerType, table.ownerId),
  ],
);

/**
 * `docs_manifest_entries` — RCASD provenance manifest rows.
 *
 * Domain-prefixed target of the legacy `manifest_entries` table (D11 collapse).
 * Cross-domain FKs (`pipeline_id`, `stage_id` → lifecycle tables) are resolved
 * by the exodus prefixer against the consolidated single-file schema; this
 * target module carries them as plain TEXT id columns (no in-module FK to the
 * live lifecycle module, which keeps unprefixed names).
 *
 * @task T11360 (target shape) · T5100 (original)
 */
export const docsManifestEntries = sqliteTable(
  'docs_manifest_entries',
  {
    /** Manifest entry id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_lifecycle_pipelines.id` (resolved at exodus). */
    pipelineId: text('pipeline_id'),
    /** FK → `tasks_lifecycle_stages.id` (resolved at exodus). */
    stageId: text('stage_id'),
    /** Human-readable manifest title. */
    title: text('title').notNull(),
    /** Manifest date (display TEXT). */
    date: text('date').notNull(),
    /** Manifest lifecycle status — CHECK-backed via {@link MANIFEST_STATUSES}. */
    status: text('status', { enum: MANIFEST_STATUSES }).notNull(),
    /** Optional agent type that produced the entry. */
    agentType: text('agent_type'),
    /** Optional path to the produced output file. */
    outputFile: text('output_file'),
    /** JSON array of topic slugs (TEXT per JSON audit; empty-array default). */
    topicsJson: text('topics_json').default('[]'),
    /** JSON array of findings (TEXT per JSON audit; empty-array default). */
    findingsJson: text('findings_json').default('[]'),
    /** JSON array of linked task IDs (TEXT per JSON audit; empty-array default). */
    linkedTasksJson: text('linked_tasks_json').default('[]'),
    /** Agent identity (or `"human"`) that created the entry. */
    createdBy: text('created_by'),
    /** ISO-8601 UTC creation instant (canonical TEXT timestamp, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_docs_manifest_entries_pipeline_id').on(table.pipelineId),
    index('idx_docs_manifest_entries_stage_id').on(table.stageId),
    index('idx_docs_manifest_entries_status').on(table.status),
  ],
);

/**
 * `docs_pipeline_manifest` — distilled pipeline manifest (memory ingestion).
 *
 * Domain-prefixed target of the legacy `pipeline_manifest` table (D11 collapse).
 * `session_id` / `task_id` / `epic_id` are cross-domain FKs into the
 * `tasks_*` family resolved by the exodus prefixer; carried here as TEXT id
 * columns.
 *
 * @task T11360 (target shape) · T5581 (original)
 */
export const docsPipelineManifest = sqliteTable(
  'docs_pipeline_manifest',
  {
    /** Pipeline manifest id (UUID v4). */
    id: text('id').primaryKey(),
    /** FK → `tasks_sessions.id` (resolved at exodus). */
    sessionId: text('session_id'),
    /** FK → `tasks_tasks.id` (resolved at exodus). */
    taskId: text('task_id'),
    /** FK → `tasks_tasks.id` (epic, resolved at exodus). */
    epicId: text('epic_id'),
    /**
     * Manifest entry type (§5b non-conformer).
     *
     * Mapped from phase-directory names by the ingestion writer — open
     * taxonomy. Left as bare TEXT; legal set enumerated at the exodus writer
     * audit (T11248).
     */
    type: text('type').notNull(),
    /** Distilled content body. */
    content: text('content').notNull(),
    /** Optional content hash for dedup. */
    contentHash: text('content_hash'),
    /**
     * Manifest status (§5b non-conformer).
     *
     * Written dynamically by the ingestion path (default `'active'`); not a
     * frozen enum. Left as bare TEXT pending the exodus writer audit (T11248).
     */
    status: text('status').notNull().default('active'),
    /** Whether the entry has been distilled into BRAIN — boolean (§3, kept typed). */
    distilled: integer('distilled', { mode: 'boolean' }).notNull().default(false),
    /** Optional id of the BRAIN observation this entry distilled into. */
    brainObsId: text('brain_obs_id'),
    /** Optional source file path. */
    sourceFile: text('source_file'),
    /** Optional serialized metadata (TEXT per JSON audit). */
    metadataJson: text('metadata_json'),
    /** ISO-8601 UTC creation instant (canonical TEXT timestamp, §4). */
    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    /** ISO-8601 UTC archival instant; NULL while active (canonical TEXT, §4). */
    archivedAt: text('archived_at'),
  },
  (table) => [
    index('idx_docs_pipeline_manifest_task_id').on(table.taskId),
    index('idx_docs_pipeline_manifest_session_id').on(table.sessionId),
    index('idx_docs_pipeline_manifest_distilled').on(table.distilled),
    index('idx_docs_pipeline_manifest_status').on(table.status),
    index('idx_docs_pipeline_manifest_content_hash').on(table.contentHash),
  ],
);

// === TYPE EXPORTS ===

/** Row type for `docs_attachments` SELECT queries (target shape). */
export type DocsAttachmentRow = typeof docsAttachments.$inferSelect;
/** Row type for `docs_attachments` INSERT operations (target shape). */
export type NewDocsAttachmentRow = typeof docsAttachments.$inferInsert;
/** Row type for `docs_attachment_refs` SELECT queries (target shape). */
export type DocsAttachmentRefRow = typeof docsAttachmentRefs.$inferSelect;
/** Row type for `docs_attachment_refs` INSERT operations (target shape). */
export type NewDocsAttachmentRefRow = typeof docsAttachmentRefs.$inferInsert;
/** Row type for `docs_manifest_entries` SELECT queries (target shape). */
export type DocsManifestEntryRow = typeof docsManifestEntries.$inferSelect;
/** Row type for `docs_manifest_entries` INSERT operations (target shape). */
export type NewDocsManifestEntryRow = typeof docsManifestEntries.$inferInsert;
/** Row type for `docs_pipeline_manifest` SELECT queries (target shape). */
export type DocsPipelineManifestRow = typeof docsPipelineManifest.$inferSelect;
/** Row type for `docs_pipeline_manifest` INSERT operations (target shape). */
export type NewDocsPipelineManifestRow = typeof docsPipelineManifest.$inferInsert;
