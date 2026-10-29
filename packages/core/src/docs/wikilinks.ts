/**
 * `docs_wikilinks` — derive + query the slug-addressed docs edge table.
 *
 * Per the ratified Docs-SSoT model (saga T11778) `cleo.db` is the SOLE doc
 * authority and `docs_wikilinks` is a **DERIVED, non-authoritative** edge table
 * reconstructed from three provenance columns already on `attachments`:
 *
 *   - `supersedes` / `superseded_by` → doc→doc supersession edges
 *   - `related_tasks`                → doc→T#### task edges (JSON array)
 *   - `topics`                       → doc↔doc shared-topic edges (JSON array)
 *
 * Those column-derived edges are **idempotent**: a rebuild replaces them all,
 * so callers may re-run it after any `docs add` / `supersede` / `docs update`
 * write to keep the graph fresh. The one body-derived relation, `links-to`
 * (T14113, a `[[slug]]` wikilink in the doc body), is written per doc by
 * {@link syncDocBodyWikilinks} at the docs write path — the only place the
 * body is in hand — and a rebuild leaves those rows alone.
 *
 * This module is the runtime twin of the SQL backfill in
 * `migrations/drizzle-tasks/20260605000001_t11826-docs-wikilinks/migration.sql`
 * — the migration seeds the table on schema upgrade, this function rebuilds it
 * on demand.
 *
 * @task T11826 (Epic T11781 / Saga T11778)
 * @adr ADR-078 — Docs SSoT as provenance graph
 * @see build-provenance-graph.ts — the on-the-fly BFS this table makes O(edges)
 */

import { and, count, eq, getTableColumns, ne, or } from 'drizzle-orm';
import { getProjectRoot } from '../paths.js';
import { type DocsWikilinkRelation, docsWikilinks } from '../store/schema/attachments.js';
import { getDb } from '../store/sqlite.js';
import { attachments } from '../store/tasks-schema.js';

/**
 * A single slug-addressed wikilink edge.
 *
 * @task T11826
 */
export interface WikilinkEdge {
  /** Source doc slug (always a doc). */
  readonly fromSlug: string;
  /** Target slug — a doc slug, or a `T####` task id when {@link toIsTask}. */
  readonly toSlug: string;
  /** Which provenance column produced this edge. */
  readonly relation: DocsWikilinkRelation;
  /** True when {@link toSlug} is a task id (`related-task` edges). */
  readonly toIsTask: boolean;
}

/**
 * Options shared by {@link rebuildDocsWikilinks}.
 *
 * @task T11826
 */
export interface RebuildDocsWikilinksOptions {
  /** Project root for DB resolution. Defaults to {@link getProjectRoot}(). */
  readonly projectRoot?: string;
}

/**
 * Outcome of a {@link rebuildDocsWikilinks} call.
 *
 * @task T11826
 */
export interface RebuildDocsWikilinksResult {
  /** Number of edges in the table after the rebuild. */
  readonly edgeCount: number;
  /** Per-relation edge counts. */
  readonly byRelation: Readonly<Record<DocsWikilinkRelation, number>>;
}

/** Narrow row shape read from `attachments` during derivation. */
interface DerivationRow {
  readonly slug: string;
  readonly supersedesSlug: string | null;
  readonly supersededBySlug: string | null;
  readonly relatedTasks: string | null;
  readonly topics: string | null;
}

/**
 * Idempotently rebuild the `docs_wikilinks` edge table from the provenance
 * columns on `attachments`.
 *
 * The whole table is truncated and re-derived inside a single transaction, so
 * the function is safe to call after any doc write and always converges to the
 * same edge set for a given `attachments` state. The edge insert is chunked at
 * 6553 rows per statement — SQLite's 32766-variable cap with 5 bound columns
 * per row — so stores with more than 6553 edges still rebuild fully (T13711).
 *
 * @example
 * ```ts
 * const { edgeCount, byRelation } = await rebuildDocsWikilinks();
 * console.log(`derived ${edgeCount} edges (${byRelation['topic']} topic links)`);
 * ```
 *
 * @param opts - Optional project-root override.
 * @returns Edge totals after the rebuild.
 * @task T11826
 */
export async function rebuildDocsWikilinks(
  opts: RebuildDocsWikilinksOptions = {},
): Promise<RebuildDocsWikilinksResult> {
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const db = await getDb(projectRoot);

  // Read every attachment's id, slug and provenance columns in one pass, then
  // resolve the supersession FK ids → slugs in JS via an id→slug map. (A
  // correlated SQL subquery aliasing the same table is fragile across SQLite
  // versions, so the resolution is done in memory.)
  const allRows = await db
    .select({
      id: attachments.id,
      slug: attachments.slug,
      supersedes: attachments.supersedes,
      supersededBy: attachments.supersededBy,
      relatedTasks: attachments.relatedTasks,
      topics: attachments.topics,
    })
    .from(attachments)
    .all();

  const slugById = new Map<string, string>();
  for (const r of allRows) {
    if (r.slug) slugById.set(r.id, r.slug);
  }

  const slugged: DerivationRow[] = allRows
    .filter((r): r is typeof r & { slug: string } => typeof r.slug === 'string')
    .map((r) => ({
      slug: r.slug,
      supersedesSlug: r.supersedes ? (slugById.get(r.supersedes) ?? null) : null,
      supersededBySlug: r.supersededBy ? (slugById.get(r.supersededBy) ?? null) : null,
      relatedTasks: r.relatedTasks,
      topics: r.topics,
    }));

  const edges = deriveWikilinkEdges(slugged);

  const nowIso = new Date().toISOString();
  // The node:sqlite driver is synchronous — drizzle's transaction callback must
  // be sync (an async body throws a DrizzleTypeError at build time).
  db.transaction((tx) => {
    // `links-to` edges come from doc bodies, not columns: keep them (T14113).
    tx.delete(docsWikilinks).where(ne(docsWikilinks.relation, 'links-to')).run();
    if (edges.length === 0) return;
    // Batch insert; INSERT OR IGNORE semantics via onConflictDoNothing keep the
    // composite PK idempotent even if deriveWikilinkEdges emitted a duplicate.
    //
    // T13711: SQLite caps a statement's bound variables at SQLITE_MAX_VARIABLE_
    // NUMBER (32766), so one INSERT binds at most floor(32766 / columns) rows
    // — past that (axiom-app: 8387 edges) the single statement fails and the
    // whole rebuild rolls back. Chunk inside the SAME transaction so the
    // rebuild stays atomic.
    const WIKILINK_INSERT_CHUNK_ROWS = Math.floor(
      32766 / Object.keys(getTableColumns(docsWikilinks)).length,
    );
    for (let i = 0; i < edges.length; i += WIKILINK_INSERT_CHUNK_ROWS) {
      tx.insert(docsWikilinks)
        .values(
          edges.slice(i, i + WIKILINK_INSERT_CHUNK_ROWS).map((e) => ({
            fromSlug: e.fromSlug,
            toSlug: e.toSlug,
            relation: e.relation,
            toIsTask: e.toIsTask,
            derivedAt: nowIso,
          })),
        )
        .onConflictDoNothing()
        .run();
    }
  });

  const linkRows = await db
    .select({ n: count() })
    .from(docsWikilinks)
    .where(eq(docsWikilinks.relation, 'links-to'))
    .all();
  const byRelation: Record<DocsWikilinkRelation, number> = {
    supersedes: 0,
    'superseded-by': 0,
    'related-task': 0,
    topic: 0,
    'links-to': linkRows[0]?.n ?? 0,
  };
  for (const e of edges) byRelation[e.relation] += 1;

  return { edgeCount: edges.length + byRelation['links-to'], byRelation };
}

/**
 * Replace one doc's body-derived `links-to` edges with `targets`.
 *
 * Called at the docs write path with the slugs the new body links to via
 * `[[slug]]` (see `extractWikilinkTargets`); an empty list clears the doc's
 * outbound body links. Self-links are dropped.
 *
 * @param slug - The doc whose body was written.
 * @param targets - Slugs the body links to.
 * @param opts - Optional project-root override.
 * @returns The number of `links-to` edges now leaving `slug`.
 * @task T14113
 */
export async function syncDocBodyWikilinks(
  slug: string,
  targets: readonly string[],
  opts: RebuildDocsWikilinksOptions = {},
): Promise<number> {
  const db = await getDb(opts.projectRoot ?? getProjectRoot());
  const unique = [...new Set(targets)].filter((t) => t !== slug);
  const nowIso = new Date().toISOString();
  db.transaction((tx) => {
    tx.delete(docsWikilinks)
      .where(and(eq(docsWikilinks.fromSlug, slug), eq(docsWikilinks.relation, 'links-to')))
      .run();
    if (unique.length === 0) return;
    tx.insert(docsWikilinks)
      .values(
        unique.map((toSlug) => ({
          fromSlug: slug,
          toSlug,
          relation: 'links-to' as const,
          toIsTask: false,
          derivedAt: nowIso,
        })),
      )
      .onConflictDoNothing()
      .run();
  });
  return unique.length;
}

/**
 * Pure derivation: turn slugged `attachments` rows into the full edge set.
 *
 * Exposed for unit testing the derivation rules without a database. The output
 * is deduplicated on the (`fromSlug`, `toSlug`, `relation`) composite key.
 *
 * @param rows - Slugged attachment rows with their provenance columns.
 * @returns The derived wikilink edges.
 * @task T11826
 */
export function deriveWikilinkEdges(rows: readonly DerivationRow[]): WikilinkEdge[] {
  const seen = new Set<string>();
  const out: WikilinkEdge[] = [];

  const push = (
    fromSlug: string,
    toSlug: string,
    relation: DocsWikilinkRelation,
    toIsTask: boolean,
  ): void => {
    const key = `${fromSlug}|${toSlug}|${relation}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ fromSlug, toSlug, relation, toIsTask });
  };

  // Topic membership index: topic slug → set of doc slugs carrying it.
  const topicMembers = new Map<string, Set<string>>();

  for (const row of rows) {
    // supersedes / superseded-by — doc→doc.
    if (row.supersedesSlug) push(row.slug, row.supersedesSlug, 'supersedes', false);
    if (row.supersededBySlug) push(row.slug, row.supersededBySlug, 'superseded-by', false);

    // related-task — doc→T####.
    for (const taskId of parseStringArray(row.relatedTasks)) {
      if (/^T\d+$/.test(taskId)) push(row.slug, taskId, 'related-task', true);
    }

    // Accumulate topic membership for the symmetric pass below.
    for (const topic of parseStringArray(row.topics)) {
      let members = topicMembers.get(topic);
      if (!members) {
        members = new Set<string>();
        topicMembers.set(topic, members);
      }
      members.add(row.slug);
    }
  }

  // topic — symmetric doc↔doc edges for co-members of any topic.
  for (const members of topicMembers.values()) {
    const slugs = [...members];
    for (let i = 0; i < slugs.length; i++) {
      for (let j = 0; j < slugs.length; j++) {
        if (i === j) continue;
        push(slugs[i], slugs[j], 'topic', false);
      }
    }
  }

  return out;
}

/**
 * Read all wikilink edges incident to a doc slug — **bidirectional** by default.
 *
 * Returns both outbound edges (`from_slug = slug`) and inbound backlinks
 * (`to_slug = slug`). This is the query the Obsidian plugin (T11827) renders to
 * show a doc's neighborhood, and what `cleo docs graph` hydrates for persisted
 * backlinks.
 *
 * @param slug - The doc slug to fetch edges for.
 * @param opts.direction - `'both'` (default), `'out'`, or `'in'`.
 * @param opts.projectRoot - Project root override.
 * @returns The incident edges.
 * @task T11826
 */
export async function getDocsWikilinks(
  slug: string,
  opts: { direction?: 'both' | 'out' | 'in'; projectRoot?: string } = {},
): Promise<WikilinkEdge[]> {
  const direction = opts.direction ?? 'both';
  const projectRoot = opts.projectRoot ?? getProjectRoot();
  const db = await getDb(projectRoot);

  const predicate =
    direction === 'out'
      ? eq(docsWikilinks.fromSlug, slug)
      : direction === 'in'
        ? eq(docsWikilinks.toSlug, slug)
        : or(eq(docsWikilinks.fromSlug, slug), eq(docsWikilinks.toSlug, slug));

  const rows = await db.select().from(docsWikilinks).where(predicate).all();
  return rows.map((r) => ({
    fromSlug: r.fromSlug,
    toSlug: r.toSlug,
    relation: r.relation,
    toIsTask: r.toIsTask,
  }));
}

/**
 * Parse a JSON-array-of-strings column, tolerating null / malformed values.
 *
 * @internal
 */
function parseStringArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && v.length > 0);
  } catch {
    return [];
  }
}
