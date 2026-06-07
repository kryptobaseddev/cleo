/**
 * Global-scope `cleo.db` — cross-project **session manifest** mirror (1 table).
 *
 * EP-SESSION-MANIFEST (epic T11638, task T11639). The `session_manifest` table is
 * a CROSS-PROJECT MIRROR of the per-project `tasks_sessions` rows: each project's
 * authoritative session lives in that project's `tasks_sessions` table (PROJECT
 * scope `cleo.db`), and a best-effort writer copies a compact projection into this
 * GLOBAL-scope row so the fleet has a single, machine-wide view of every session
 * across every project — without ATTACHing N per-project DBs.
 *
 * ## NOT named `sessions` (AC1)
 *
 * The table is deliberately `session_manifest`, NOT `sessions`. The authoritative
 * project-tier table is `tasks_sessions`; naming the global mirror `sessions` would
 * invite a future reader to mistake the mirror for the source of truth. The name
 * encodes its role: a manifest (an index/catalog), never the authority.
 *
 * ## MIRROR, never authoritative (AC4)
 *
 * Every column here is derived from the project row. The mirror writer is
 * best-effort (a failure NEVER fails the underlying session op) and reconcile-on-
 * start re-reads the authoritative project row and OVERWRITES the manifest row, so
 * a stale or partially-written manifest entry can never drift into being treated as
 * truth. Consumers needing exact session state MUST read the project's
 * `tasks_sessions`; this table answers "which sessions exist, where, and how are
 * they forked" cheaply across projects.
 *
 * ## Identity (`project_id`)
 *
 * `project_id` is the canonical `nexus_project_registry.project_id` (12-hex) for
 * the project that owns the session — a soft FK into the global registry table in
 * THIS same `cleo.db`. It is reused (never minted here) so the manifest joins
 * cleanly to the registry. Nullable: a session started outside any resolvable
 * registered project still mirrors, with `project_id` NULL.
 *
 * ## Fork tree (`parent_session_id`)
 *
 * `parent_session_id` mirrors the project row's own `parent_session_id`
 * (populated from `CLEO_PARENT_SESSION_ID`, stamped by the supervisor — PR #996 /
 * T11629). It reconstructs the orchestrator→worker fork tree machine-wide without
 * a per-project DB scan. Soft self-reference to `session_manifest.session_id`;
 * NULL for a root session.
 *
 * @task T11639
 * @epic T11638
 * @saga T11242
 * @see ../cleo-project/tasks-core.ts — `tasksSessions` (the authoritative source)
 * @see ./nexus.ts — `nexusProjectRegistry` (the `project_id` SSoT)
 * @see ../../sessions/session-manifest-mirror.ts — the best-effort mirror writers
 */

import { sql } from 'drizzle-orm';
import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * `session_manifest` — cross-project mirror of per-project `tasks_sessions` rows.
 *
 * A best-effort projection: one row per session, keyed on the session id, carrying
 * just enough to answer fleet-wide "what sessions exist, in which project, and how
 * are they forked" without opening every project's `cleo.db`. NOT authoritative —
 * the project's `tasks_sessions` row is the source of truth; this row is overwritten
 * on reconcile-on-start so it can never drift into authority (AC4).
 *
 * @task T11639
 */
export const sessionManifest = sqliteTable(
  'session_manifest',
  {
    /** Session id (canonical `ses_...` form). Primary key — one manifest row per session. */
    sessionId: text('session_id').primaryKey(),
    /**
     * Canonical `nexus_project_registry.project_id` (12-hex) of the owning project.
     * Soft FK into the global registry in THIS `cleo.db`; NULL when the session was
     * started outside any resolvable registered project.
     */
    projectId: text('project_id'),
    /**
     * Fork-tree parent session id, mirrored from the project row's own
     * `parent_session_id` (sourced from `CLEO_PARENT_SESSION_ID`, T11629). Soft
     * self-reference to `session_manifest.session_id`; NULL for a root session.
     */
    parentSessionId: text('parent_session_id'),
    /** Mirrored session name. */
    name: text('name'),
    /** Mirrored session status (`active` | `ended` | `orphaned` | …). */
    status: text('status'),
    /** Mirrored absolute project root path (for operator readability / debugging). */
    projectPath: text('project_path'),
    /** Mirrored ISO-8601 UTC session-start instant. */
    startedAt: text('started_at'),
    /** Mirrored ISO-8601 UTC session-end instant; NULL while active. */
    endedAt: text('ended_at'),
    /**
     * ISO-8601 UTC instant this mirror row was last written by a mirror/reconcile
     * writer (NOT the session's own activity). Defaults to write time.
     */
    mirroredAt: text('mirrored_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index('idx_session_manifest_project_id').on(table.projectId),
    index('idx_session_manifest_parent').on(table.parentSessionId),
    index('idx_session_manifest_status').on(table.status),
  ],
);

/** Row type for `session_manifest` SELECT queries (mirror shape). */
export type SessionManifestRow = typeof sessionManifest.$inferSelect;
/** Row type for `session_manifest` INSERT/UPSERT operations (mirror shape). */
export type NewSessionManifestRow = typeof sessionManifest.$inferInsert;
