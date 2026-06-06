/**
 * Build a typed {@link DocProvenanceResponse} envelope by traversing the
 * docs provenance graph (T10166 contract) from a single root.
 *
 * The root is addressed by either:
 *   - a canonical doc slug (matches `attachments.slug`), or
 *   - a CLEO task ID (matches `attachment_refs.owner_id` with `owner_type='task'`,
 *     or any doc whose `related_tasks` JSON list contains the ID).
 *
 * Traversal walks the supersession chain in both directions (forward via
 * `attachments.supersedes`, reverse via `attachments.superseded_by`) plus the
 * cross-entity link from each visited doc to every owning task (via the
 * `attachment_refs` junction). `depth` bounds the BFS — `depth=0` returns only
 * the root, `depth=N` returns the root plus all neighbors reachable in `N` hops.
 *
 * The result conforms to {@link DocProvenanceResponse} from
 * `@cleocode/contracts/docs/provenance` (T10166) and is the wire envelope for
 * `cleo docs graph --root`.
 *
 * @see DocProvenanceResponse — packages/contracts/src/docs/provenance.ts
 * @see ADR-078 §4 — Docs SSoT as provenance graph
 *
 * @task T10164 (Epic T10157 / Saga T9855)
 */

import type {
  DocLifecycleStatus,
  DocProvenanceResponse,
  ProvenanceDocNode,
  ProvenanceEdge,
  ProvenanceEdgeRelation,
  ProvenanceNode,
  ProvenanceNodeKind,
  ProvenanceTaskNode,
} from '@cleocode/contracts';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { getProjectRoot } from '../paths.js';
import { docsWikilinks } from '../store/schema/attachments.js';
import { getDb } from '../store/sqlite.js';
import { attachmentRefs, attachments } from '../store/tasks-schema.js';

/**
 * Options accepted by {@link buildDocProvenanceGraph}.
 *
 * @task T10164
 */
export interface BuildDocProvenanceGraphOptions {
  /**
   * Root identifier — either a doc slug (matches `attachments.slug`) or a
   * CLEO task ID (matches `attachment_refs.owner_id` or `related_tasks` JSON).
   */
  readonly root: string;
  /**
   * Maximum BFS hops from the root. `0` returns the root alone; the default
   * (`2`) returns the root plus its direct + 1-hop neighbors.
   *
   * @default 2
   */
  readonly depth?: number;
  /**
   * Project root for DB resolution. Defaults to {@link getProjectRoot}().
   */
  readonly projectRoot?: string;
  /**
   * When `true`, hydrate the BFS result with the persisted `docs_wikilinks`
   * backlink edges (T11826) incident to the visited doc nodes — adding
   * `shares-topic` doc↔doc edges (which the on-the-fly BFS does not compute)
   * plus any persisted supersedes / related-task backlinks not already present.
   * The persisted edge table is the Obsidian-grade graph; this folds it into
   * the same envelope without a second query path.
   *
   * @default false
   * @task T11826
   */
  readonly hydrateWikilinks?: boolean;
}

/**
 * Error raised when {@link buildDocProvenanceGraph}'s root identifier cannot
 * be resolved to either a doc slug or any doc associated with a task ID.
 *
 * @task T10164
 */
export class DocProvenanceRootNotFoundError extends Error {
  constructor(root: string) {
    super(
      `Root '${root}' not found — no doc carries this slug and no attachment_ref points at this task ID`,
    );
    this.name = 'DocProvenanceRootNotFoundError';
  }
}

/** Internal shape of an attachments-table row narrowed to the fields we read. */
type AttachmentRow = {
  id: string;
  slug: string | null;
  type: string | null;
  lifecycleStatus: string;
  supersedes: string | null;
  supersededBy: string | null;
  summary: string | null;
  relatedTasks: string | null;
  createdAt: string;
  attachmentJson: string;
};

/** Compact key for the visited-set: `kind|id`. */
type NodeKey = `${ProvenanceNodeKind}|${string}`;

/**
 * Build a {@link DocProvenanceResponse} by BFS-traversing the docs provenance
 * graph from a root (slug or task ID).
 *
 * @example
 * ```ts
 * const graph = await buildDocProvenanceGraph({ root: 'adr-078-docs-provenance', depth: 2 });
 * for (const node of graph.nodes) {
 *   if (node.kind === 'doc') console.log(node.slug, node.lifecycleStatus);
 * }
 * ```
 *
 * @task T10164
 */
export async function buildDocProvenanceGraph(
  options: BuildDocProvenanceGraphOptions,
): Promise<DocProvenanceResponse> {
  const depth = options.depth ?? 2;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new TypeError(`depth must be a non-negative integer (got ${String(depth)})`);
  }

  const projectRoot = options.projectRoot ?? getProjectRoot();
  const db = await getDb(projectRoot);

  const rootDocs = await resolveRootDocs(db, options.root);
  if (rootDocs.length === 0) {
    throw new DocProvenanceRootNotFoundError(options.root);
  }

  // Frontier carries the (attachmentId, hopsRemaining) BFS state. We dedupe by
  // attachmentId across hops — the first visit wins, so the shortest hop count
  // anchors each node.
  const visitedDocIds = new Set<string>();
  const visitedKeys = new Set<NodeKey>();
  const nodes: ProvenanceNode[] = [];
  const edges: ProvenanceEdge[] = [];

  let frontier: AttachmentRow[] = rootDocs;
  for (const row of rootDocs) {
    visitedDocIds.add(row.id);
    const node = toDocNode(row);
    visitedKeys.add(docNodeKey(node));
    nodes.push(node);
  }

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const nextFrontier: AttachmentRow[] = [];

    // 1. Supersession chain — forward (this doc supersedes prior) + reverse
    //    (this doc is superseded by newer). Each link emits one edge.
    const supersedeTargetIds = new Set<string>();
    for (const row of frontier) {
      if (row.supersedes) supersedeTargetIds.add(row.supersedes);
      if (row.supersededBy) supersedeTargetIds.add(row.supersededBy);
    }
    const supersedeRows = await loadAttachmentsByIds(db, [...supersedeTargetIds]);
    const supersedeIndex = new Map(supersedeRows.map((r) => [r.id, r]));

    for (const row of frontier) {
      if (row.supersedes) {
        const target = supersedeIndex.get(row.supersedes);
        if (target) {
          pushDocNeighbor(target, 'supersedes', row, nodes, edges, visitedKeys);
          if (!visitedDocIds.has(target.id)) {
            visitedDocIds.add(target.id);
            nextFrontier.push(target);
          }
        }
      }
      if (row.supersededBy) {
        const target = supersedeIndex.get(row.supersededBy);
        if (target) {
          pushDocNeighbor(target, 'superseded-by', row, nodes, edges, visitedKeys);
          if (!visitedDocIds.has(target.id)) {
            visitedDocIds.add(target.id);
            nextFrontier.push(target);
          }
        }
      }
    }

    // 2. Cross-entity edges — for every visited doc, link to its owning tasks
    //    via attachment_refs (owner_type='task'). Task nodes are leaves: they
    //    do not extend the frontier (we don't traverse task→task graph).
    const docIds = frontier.map((r) => r.id);
    if (docIds.length > 0) {
      const taskRefs = await db
        .select({
          attachmentId: attachmentRefs.attachmentId,
          ownerId: attachmentRefs.ownerId,
          attachedAt: attachmentRefs.attachedAt,
        })
        .from(attachmentRefs)
        .where(
          and(eq(attachmentRefs.ownerType, 'task'), inArray(attachmentRefs.attachmentId, docIds)),
        )
        .all();

      for (const ref of taskRefs) {
        const docRow = frontier.find((r) => r.id === ref.attachmentId);
        if (!docRow) continue;
        const taskNode = toTaskNodeStub(ref.ownerId);
        const taskKey = `task|${ref.ownerId}` as const;
        if (!visitedKeys.has(taskKey)) {
          visitedKeys.add(taskKey);
          nodes.push(taskNode);
        }
        const docNode = toDocNode(docRow);
        edges.push({
          relation: 'attached-to',
          from: docNode.id,
          fromKind: 'doc',
          to: taskNode.id,
          toKind: 'task',
          addedAt: ref.attachedAt,
        });
      }
    }

    // 3. related_tasks JSON — surfaces docs that mention a task even when no
    //    attachment_ref exists. These produce task leaf nodes + 'related-task'
    //    edges. Failing JSON.parse is silently skipped — corrupt rows are not
    //    a fatal traversal error.
    for (const row of frontier) {
      if (!row.relatedTasks) continue;
      const tasks = parseRelatedTasks(row.relatedTasks);
      const docNode = toDocNode(row);
      for (const taskId of tasks) {
        const taskKey = `task|${taskId}` as const;
        if (!visitedKeys.has(taskKey)) {
          visitedKeys.add(taskKey);
          nodes.push(toTaskNodeStub(taskId));
        }
        edges.push({
          relation: 'related-task',
          from: docNode.id,
          fromKind: 'doc',
          to: taskId,
          toKind: 'task',
          addedAt: row.createdAt,
        });
      }
    }

    frontier = nextFrontier;
  }

  if (options.hydrateWikilinks) {
    await hydrateFromWikilinks(db, nodes, edges);
  }

  return {
    nodes,
    edges,
    totalNodes: nodes.length,
    totalEdges: edges.length,
  };
}

/**
 * Fold the persisted `docs_wikilinks` backlink edges (T11826) into an
 * already-built provenance graph.
 *
 * For every doc node currently in the graph, pull its incident wikilink edges
 * (both directions) and append any that connect to another doc node already in
 * the graph and are not already present. This surfaces `shares-topic` doc↔doc
 * edges — which the on-the-fly BFS does not compute — without re-deriving the
 * graph. Edges to nodes outside the visited set are skipped so the BFS depth
 * bound is respected.
 *
 * @internal
 * @task T11826
 */
async function hydrateFromWikilinks(
  db: Awaited<ReturnType<typeof getDb>>,
  nodes: ProvenanceNode[],
  edges: ProvenanceEdge[],
): Promise<void> {
  const docSlugs = new Set(nodes.filter((n) => n.kind === 'doc').map((n) => n.id));
  if (docSlugs.size === 0) return;

  const rows = await db
    .select()
    .from(docsWikilinks)
    .where(
      or(
        inArray(docsWikilinks.fromSlug, [...docSlugs]),
        inArray(docsWikilinks.toSlug, [...docSlugs]),
      ),
    )
    .all();

  // Dedupe against existing edges by (relation, from, to).
  const existing = new Set(edges.map((e) => `${e.relation}|${e.from}|${e.to}`));

  for (const row of rows) {
    // Only fold edges whose endpoints are both already visited doc nodes —
    // related-task edges are already emitted by the BFS, and topic links to
    // unvisited docs would breach the depth bound.
    if (row.relation === 'related-task') continue;
    if (!docSlugs.has(row.fromSlug) || !docSlugs.has(row.toSlug)) continue;

    const relation: ProvenanceEdgeRelation =
      row.relation === 'topic' ? 'shares-topic' : (row.relation as ProvenanceEdgeRelation);
    const key = `${relation}|${row.fromSlug}|${row.toSlug}`;
    if (existing.has(key)) continue;
    existing.add(key);

    edges.push({
      relation,
      from: row.fromSlug,
      fromKind: 'doc',
      to: row.toSlug,
      toKind: 'doc',
      addedAt: row.derivedAt,
    });
  }
}

/**
 * Render a {@link DocProvenanceResponse} as a Graphviz DOT graph.
 *
 * Each node renders with its kind-prefixed label; each edge renders with the
 * semantic relation as the edge label. Output is deterministic in node + edge
 * order so two equivalent graphs always render to byte-identical DOT.
 *
 * @example
 * ```ts
 * const graph = await buildDocProvenanceGraph({ root: 'adr-078' });
 * const dot = renderProvenanceGraphAsDot(graph);
 * await writeFile('graph.dot', dot, 'utf8');
 * // dot -Tsvg graph.dot -o graph.svg
 * ```
 *
 * @task T10164
 */
export function renderProvenanceGraphAsDot(graph: DocProvenanceResponse): string {
  const lines: string[] = ['digraph DocProvenance {', '  rankdir=LR;', '  node [shape=box];'];
  for (const node of graph.nodes) {
    const label = nodeLabel(node);
    lines.push(`  "${escapeDotId(node.kind, node.id)}" [label=${quoteDotString(label)}];`);
  }
  for (const edge of graph.edges) {
    lines.push(
      `  "${escapeDotId(edge.fromKind, edge.from)}" -> "${escapeDotId(edge.toKind, edge.to)}" [label="${edge.relation}"];`,
    );
  }
  lines.push('}');
  return lines.join('\n');
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolve a root identifier to one or more attachment rows. Slug matches
 * return exactly one row (slug is project-unique); task IDs may resolve to N
 * rows (every doc attached to that task plus every doc whose `related_tasks`
 * mentions it). Empty array means no match.
 */
async function resolveRootDocs(
  db: Awaited<ReturnType<typeof getDb>>,
  root: string,
): Promise<AttachmentRow[]> {
  const looksLikeTask = /^T\d+$/.test(root);

  if (!looksLikeTask) {
    const row = await db.select().from(attachments).where(eq(attachments.slug, root)).get();
    return row ? [normalizeRow(row)] : [];
  }

  // Task-anchored root: union of (refs where owner_id = root) and
  // (attachments whose related_tasks JSON list contains root).
  const refRows = await db
    .select({ attachmentId: attachmentRefs.attachmentId })
    .from(attachmentRefs)
    .where(and(eq(attachmentRefs.ownerType, 'task'), eq(attachmentRefs.ownerId, root)))
    .all();
  const refIds = refRows.map((r) => r.attachmentId);

  const relatedRows = await db
    .select()
    .from(attachments)
    .where(
      or(
        // Exact JSON-array membership via sqlite's `json_each` — robust to
        // whitespace and ordering compared to a substring LIKE match.
        sql`EXISTS (SELECT 1 FROM json_each(${attachments.relatedTasks}) WHERE value = ${root})`,
        refIds.length > 0 ? inArray(attachments.id, refIds) : sql`0`,
      ),
    )
    .all();

  return relatedRows.map(normalizeRow);
}

async function loadAttachmentsByIds(
  db: Awaited<ReturnType<typeof getDb>>,
  ids: readonly string[],
): Promise<AttachmentRow[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(attachments)
    .where(inArray(attachments.id, [...ids]))
    .all();
  return rows.map(normalizeRow);
}

function normalizeRow(row: typeof attachments.$inferSelect): AttachmentRow {
  return {
    id: row.id,
    slug: row.slug ?? null,
    type: row.type ?? null,
    lifecycleStatus: row.lifecycleStatus,
    supersedes: row.supersedes ?? null,
    supersededBy: row.supersededBy ?? null,
    summary: row.summary ?? null,
    relatedTasks: row.relatedTasks ?? null,
    createdAt: row.createdAt,
    attachmentJson: row.attachmentJson,
  };
}

function toDocNode(row: AttachmentRow): ProvenanceDocNode {
  const slug = row.slug ?? row.id;
  const docKind = row.type ?? 'unknown';
  const node: ProvenanceDocNode = {
    kind: 'doc',
    id: slug,
    slug,
    docKind,
    title: extractTitle(row),
    lifecycleStatus: narrowLifecycleStatus(row.lifecycleStatus),
    publishedAt: row.createdAt,
    ...(row.summary ? { summary: row.summary } : {}),
  };
  return node;
}

function toTaskNodeStub(taskId: string): ProvenanceTaskNode {
  return {
    kind: 'task',
    id: taskId,
    title: taskId,
    // Stub status — full task lookup is out-of-scope for the doc-rooted graph
    // (a separate task-rooted graph would join against the tasks table). The
    // E11 renderer falls back to the discriminator + ID when the title is the
    // raw task ID.
    taskType: 'task',
    status: 'pending',
  };
}

function docNodeKey(node: ProvenanceDocNode): NodeKey {
  return `doc|${node.id}`;
}

function pushDocNeighbor(
  target: AttachmentRow,
  relation: ProvenanceEdgeRelation,
  source: AttachmentRow,
  nodes: ProvenanceNode[],
  edges: ProvenanceEdge[],
  visitedKeys: Set<NodeKey>,
): void {
  const targetNode = toDocNode(target);
  const sourceSlug = source.slug ?? source.id;
  const targetKey = docNodeKey(targetNode);
  if (!visitedKeys.has(targetKey)) {
    visitedKeys.add(targetKey);
    nodes.push(targetNode);
  }
  edges.push({
    relation,
    from: sourceSlug,
    fromKind: 'doc',
    to: targetNode.id,
    toKind: 'doc',
    addedAt: target.createdAt,
  });
}

function parseRelatedTasks(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string' && /^T\d+$/.test(v));
  } catch {
    return [];
  }
}

function narrowLifecycleStatus(raw: string): DocLifecycleStatus {
  // The contract's enum is `draft|active|superseded|archived`; the DB stores
  // the wider `brain_decisions`-aligned set (adds `proposed|accepted|deprecated`).
  // Map the DB superset down so the wire envelope satisfies the Zod schema.
  switch (raw) {
    case 'accepted':
    case 'proposed':
      return 'active';
    case 'deprecated':
      return 'archived';
    case 'draft':
    case 'superseded':
    case 'archived':
      return raw;
    default:
      return 'draft';
  }
}

function extractTitle(row: AttachmentRow): string {
  // `attachment_json` stores the discriminated `Attachment` union — every
  // variant carries either `name` or `originalName`. Best-effort parse so a
  // malformed payload still yields a node with a non-empty title.
  try {
    const parsed: unknown = JSON.parse(row.attachmentJson);
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj['name'] === 'string') return obj['name'];
      if (typeof obj['originalName'] === 'string') return obj['originalName'];
    }
  } catch {
    // Fall through to slug-based default.
  }
  return row.slug ?? row.id;
}

function nodeLabel(node: ProvenanceNode): string {
  switch (node.kind) {
    case 'doc':
      return `${node.docKind.toUpperCase()}: ${node.title} (${node.lifecycleStatus})`;
    case 'task':
      return `${node.taskType.toUpperCase()} ${node.id}`;
    case 'decision':
      return `DECISION ${node.id} (${node.outcome})`;
    case 'session':
      return `SESSION ${node.id}`;
    case 'memory':
      return `MEMORY ${node.id} (${node.memoryType})`;
  }
}

function escapeDotId(kind: ProvenanceNodeKind, id: string): string {
  // DOT IDs are double-quoted so a backslash-escape on the closing quote is
  // sufficient. The kind prefix disambiguates same-id-different-kind nodes.
  return `${kind}:${id.replace(/"/g, '\\"')}`;
}

function quoteDotString(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}
