/**
 * Attachment storage tables: attachments, attachment_refs.
 *
 * @epic T760
 * @task T796
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

/**
 * Allowed owner-entity types for `attachment_refs.owner_type`.
 *
 * Exported as the SSoT const array so the consolidated docs target schema
 * (`schema/cleo-project/docs.ts`, T11360) references this identifier rather
 * than re-declaring the literal — per the canonical typing report §5a.
 */
export const ATTACHMENT_OWNER_TYPES = [
  'task',
  'observation',
  'session',
  'decision',
  'learning',
  'pattern',
] as const;

/**
 * Allowed lifecycle states for `attachments.lifecycle_status`.
 *
 * Mirrors the supersession workflow proven on `brain_decisions.confirmation_state`
 * (T1826) and extended for documents with the `draft`, `archived`, and
 * `deprecated` terminal states.
 *
 * Validation is enforced at the dispatch layer (not via a SQL CHECK constraint)
 * so future taxonomy additions do NOT require a schema migration.
 *
 * @task T10158 (Epic T10157 / Saga T9855)
 */
export const ATTACHMENT_LIFECYCLE_STATUSES = [
  'draft',
  'proposed',
  'accepted',
  'superseded',
  'archived',
  'deprecated',
] as const;

/** Discriminated union of attachment lifecycle states. */
export type AttachmentLifecycleStatus = (typeof ATTACHMENT_LIFECYCLE_STATUSES)[number];

/**
 * Registry of stored attachments (blob content).
 *
 * Storage path: `.cleo/attachments/sha256/<sha256[0..2]>/<sha256[2..]>.<ext>`
 *
 * @epic T760
 * @task T796
 */
export const attachments = sqliteTable(
  'attachments',
  {
    /** Unique attachment identifier (UUID v4). */
    id: text('id').primaryKey(),
    /** SHA-256 hex digest of the uncompressed content. Unique across the registry. */
    sha256: text('sha256').notNull().unique(),
    /** Serialised `Attachment` discriminated union (all kind-specific fields). */
    attachmentJson: text('attachment_json').notNull(),
    /** ISO 8601 timestamp when this attachment was first registered. */
    createdAt: text('created_at').notNull(),
    /**
     * How many `attachment_refs` rows point at this attachment.
     *
     * When `ref_count` drops to zero the blob is eligible for GC.
     * Blobs are NEVER auto-deleted — use `cleo docs attachments gc`.
     */
    refCount: integer('ref_count').notNull().default(0),
    /**
     * Optional human-friendly slug for the attachment, unique per project.
     *
     * @task T9636 (Epic T9627 / Saga T9625)
     */
    slug: text('slug'),
    /**
     * Optional taxonomy classification for the attachment.
     *
     * @task T9637 (Epic T9627 / Saga T9625)
     */
    type: text('type'),
    /**
     * Document workflow state — mirrors `brain_decisions.confirmation_state`
     * (T1826) and extends it for the document-publishing lifecycle.
     *
     * Allowed values: `draft | proposed | accepted | superseded | archived | deprecated`.
     * Defaults to `'draft'` for new rows; legacy rows pass through at this
     * default after the T10158 migration. Validation is performed at the
     * dispatch layer (no SQL CHECK constraint) so future states can be added
     * without a schema migration.
     *
     * @see ATTACHMENT_LIFECYCLE_STATUSES — canonical enum
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    lifecycleStatus: text('lifecycle_status', { enum: ATTACHMENT_LIFECYCLE_STATUSES })
      .notNull()
      .default('draft'),
    /**
     * Self-referential FK forward pointer to the `attachments.id` row that
     * this doc replaces. NULL when this doc does not supersede a prior one.
     *
     * The referenced row's `superseded_by` should be set to this row's ID on
     * write — mirrors the brain_decisions supersession pattern (T1826).
     *
     * @see supersededBy — reverse pointer stored on the older row
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    supersedes: text('supersedes').references((): AnySQLiteColumn => attachments.id),
    /**
     * Self-referential FK reverse pointer to the `attachments.id` row that
     * has superseded this doc. NULL while this doc is still active.
     *
     * Set when a newer doc's `supersedes` points to this row.
     *
     * @see supersedes — forward pointer stored on the newer row
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    supersededBy: text('superseded_by').references((): AnySQLiteColumn => attachments.id),
    /**
     * Optional short human-readable summary of the attachment (≤ 1 sentence),
     * distinct from the full body stored in `attachment_json`. Surfaced in
     * `cleo docs list` and graph-traversal envelopes.
     *
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    summary: text('summary'),
    /**
     * Optional JSON array of free-form keyword strings for search.
     *
     * Stored as serialised JSON (not normalised to a sidecar table) to match
     * the existing `attachment_json` storage discipline. Parsed at read time
     * by the dispatch layer.
     *
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    keywords: text('keywords'),
    /**
     * Optional JSON array of canonical topic slugs (cross-cuts taxonomy) — a
     * higher-signal classification axis than `type`. Topics are project-defined
     * and validated at the dispatch layer.
     *
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    topics: text('topics'),
    /**
     * Optional JSON array of `T####` task IDs that this doc relates to.
     *
     * Soft cross-reference (no FK enforced) since tasks live in the same
     * tasks.db but the `tasks` table is not always present during pure
     * docs-graph traversal.
     *
     * @task T10158 (Epic T10157 / Saga T9855)
     */
    relatedTasks: text('related_tasks'),
    /**
     * CLEO release version that wrote this row (canonical SSoT).
     *
     * Derived from @cleocode/cleo/package.json → version at write time.
     * Used by the docs version SSoT to anchor docs to their release cycle.
     *
     * @task T11181 (Epic T10518 / Saga T10516)
     */
    ownerVersion: text('owner_version'),
    /**
     * Sequential doc version counter for this slug.
     *
     * Auto-incremented on every `docs.update` call: oldRow.docVersion + 1.
     * Defaults to 1 for newly created rows.
     *
     * @task T11181 (Epic T10518 / Saga T10516)
     */
    docVersion: integer('doc_version').notNull().default(1),
    /**
     * Optional explicit display-alias NUMBER for the doc, DECOUPLED from the
     * slug string.
     *
     * Background (T11875 · ADR reconcile T11676): under the ratified
     * slug-primary model the kebab `slug` is the canonical handle and the
     * displayed number (e.g. ADR "051") is a DISPLAY ALIAS only. Previously
     * that number was DERIVED by parsing the digits out of the slug
     * (`adr-051-*` → 051), so three distinct ADRs that all slug as `adr-051-*`
     * collided on the rendered number with no way to disambiguate.
     *
     * When non-null, this column is the authoritative display number and is
     * PREFERRED over the slug-derived number by
     * {@link import('../../docs/numbering.js').resolveDisplayNumber}. When null,
     * rendering falls back to the slug-derived number unchanged — so docs that
     * never had an alias assigned keep their historical behaviour.
     *
     * Uniqueness among `type='adr'` docs is enforced at the dispatch layer (not
     * via a SQL UNIQUE constraint) by
     * {@link import('../../docs/display-alias.js').setDisplayAlias}, mirroring
     * the dispatch-validated discipline used for `lifecycle_status` /
     * `relation` so future taxonomy changes never require a schema migration.
     *
     * @task T11875 (Epic T11781 / Saga T11778)
     */
    displayAlias: integer('display_alias'),
  },
  (table) => [
    index('idx_attachments_sha256').on(table.sha256),
    index('idx_attachments_lifecycle_status').on(table.lifecycleStatus),
    index('idx_attachments_supersedes').on(table.supersedes),
    // Speeds the per-type uniqueness scan in `setDisplayAlias` (T11875). Not a
    // UNIQUE index — uniqueness is scoped to `type='adr'` and enforced at the
    // dispatch layer so non-adr kinds may reuse numbers freely.
    index('idx_attachments_display_alias').on(table.displayAlias),
  ],
);

/**
 * Ref-counted junction table linking attachments to owner entities.
 *
 * @epic T760
 * @task T796
 */
export const attachmentRefs = sqliteTable(
  'attachment_refs',
  {
    /** ID of the attachment (→ `attachments.id`). */
    attachmentId: text('attachment_id').notNull(),
    /**
     * The domain entity type that owns this ref.
     */
    ownerType: text('owner_type', { enum: ATTACHMENT_OWNER_TYPES }).notNull(),
    /** The ID of the owning entity. */
    ownerId: text('owner_id').notNull(),
    /** ISO 8601 timestamp when this ref was created. */
    attachedAt: text('attached_at').notNull(),
    /** Agent identity (or `"human"`) that created this ref. */
    attachedBy: text('attached_by'),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.ownerType, table.ownerId] }),
    index('idx_attachment_refs_attachment_id').on(table.attachmentId),
    index('idx_attachment_refs_owner').on(table.ownerType, table.ownerId),
  ],
);

/**
 * Allowed relations for a `docs_wikilinks` edge.
 *
 * A wikilink is a DERIVED, slug-addressed edge between two docs (or a doc and a
 * task) reconstructed from the authoritative provenance columns on
 * `attachments` — there is no hand-authored edge here. The relation enumerates
 * which source column produced the edge:
 *
 *   - `supersedes`     — `attachments.supersedes` (newer → older)
 *   - `superseded-by`  — `attachments.superseded_by` (older → newer)
 *   - `related-task`   — `attachments.related_tasks` JSON membership (doc → T####)
 *   - `topic`          — `attachments.topics` JSON co-membership (doc ↔ doc sharing a topic)
 *
 * Kept slug-primary so the edge table is Obsidian-grade (vault links are
 * slug-addressed) and survives attachment-id churn across versions.
 *
 * @task T11826 (Epic T11781 / Saga T11778)
 */
export const DOCS_WIKILINK_RELATIONS = [
  'supersedes',
  'superseded-by',
  'related-task',
  'topic',
] as const;

/** Discriminated union of `docs_wikilinks.relation` values. */
export type DocsWikilinkRelation = (typeof DOCS_WIKILINK_RELATIONS)[number];

/**
 * `docs_wikilinks` — DERIVED, slug-addressed edge table for the docs graph.
 *
 * Per the ratified Docs-SSoT model (saga T11778): `cleo.db` is the SOLE doc
 * authority, and `docs_wikilinks` is a *minimal edge table derived from*
 * `supersedes` + `relatedTasks` + `topics` on `attachments`. It is NOT an
 * authoritative input surface — it is rebuilt idempotently from the provenance
 * columns by {@link import('../../docs/wikilinks.js').rebuildDocsWikilinks}.
 *
 * The table makes the bidirectional backlink graph queryable in O(edges)
 * without recomputing the BFS, which is what the Obsidian plugin (T11827)
 * renders. `cleo docs graph` (T10164) continues to compute the provenance BFS
 * but hydrates persisted backlinks from this table when present.
 *
 * Edges are slug-primary; `to_slug` carries a doc slug for `topic` /
 * `supersedes` / `superseded-by` edges and a `T####` task id for `related-task`
 * edges (`to_is_task = 1`). No markdown body `[[link]]` parsing is performed
 * (AC4) — the edges derive purely from structured provenance columns.
 *
 * @task T11826 (Epic T11781 / Saga T11778)
 */
export const docsWikilinks = sqliteTable(
  'docs_wikilinks',
  {
    /** Source doc slug (→ `attachments.slug`). Always a doc. */
    fromSlug: text('from_slug').notNull(),
    /** Target slug — a doc slug, or a `T####` task id when `toIsTask = 1`. */
    toSlug: text('to_slug').notNull(),
    /** Which provenance column produced this edge — dispatch-validated, no SQL CHECK. */
    relation: text('relation', { enum: DOCS_WIKILINK_RELATIONS }).notNull(),
    /** 1 when `to_slug` is a task id (`related-task` edges); 0 for doc→doc edges. */
    toIsTask: integer('to_is_task', { mode: 'boolean' }).notNull().default(false),
    /** ISO-8601 UTC instant this edge was last (re)derived. */
    derivedAt: text('derived_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.fromSlug, table.toSlug, table.relation] }),
    index('idx_docs_wikilinks_from').on(table.fromSlug),
    index('idx_docs_wikilinks_to').on(table.toSlug),
    index('idx_docs_wikilinks_relation').on(table.relation),
  ],
);

// === TYPE EXPORTS ===

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachmentRow = typeof attachments.$inferInsert;
export type AttachmentRefRow = typeof attachmentRefs.$inferSelect;
export type NewAttachmentRefRow = typeof attachmentRefs.$inferInsert;
/** Row type for `docs_wikilinks` SELECT queries. */
export type DocsWikilinkRow = typeof docsWikilinks.$inferSelect;
/** Row type for `docs_wikilinks` INSERT operations. */
export type NewDocsWikilinkRow = typeof docsWikilinks.$inferInsert;
