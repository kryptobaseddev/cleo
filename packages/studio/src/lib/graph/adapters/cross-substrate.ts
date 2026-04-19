/**
 * CLEO Studio — cross-substrate bridge detection.
 *
 * Surfacing and amplifying every meaningful bridge between the five CLEO
 * substrates (BRAIN, TASKS, NEXUS, CONDUIT, SIGNALDOCK) so the unified
 * Living Brain graph reads as one networked mind rather than five isolated
 * clusters.
 *
 * Bridge edges always carry `meta.isBridge: true` and a default weight of
 * 0.7 — higher than typical intra-substrate edges — so the force layout
 * draws cross-cluster regions together and the renderer (Agent B) applies
 * the accent-violet thick-line style.
 *
 * ## Bridge categories surfaced
 *
 * | Category       | Source column / table                              | Edge kind    |
 * |----------------|----------------------------------------------------|--------------|
 * | task→brain     | brain_memory_links (memory_type, memory_id, task_id) | derived_from / produced_by / informed_by |
 * | task→brain     | brain_decisions.context_task_id / context_epic_id  | informed_by  |
 * | brain→nexus    | brain_page_edges whose to_id is a nexus-style path | references   |
 * | brain→nexus    | brain_observations.files_modified_json             | documents    |
 * | task→nexus     | brain_page_edges whose from_id is a task ref and to_id is nexus | references |
 * | conduit→tasks  | brain_page_edges whose from_id is msg: and to_id is task: | messages |
 * | signaldock→tasks | tasks.assignee matching a loaded signaldock node | messages |
 * | signaldock→brain | brain_observations.source_session_id bridged via sessions.agent | produced_by |
 *
 * ## Columns that do NOT yet exist (latent bridges)
 *
 * The following columns appear in the mission spec but are absent from the
 * current schema. They are documented in the REPORT.md as recommended
 * schema extensions — this adapter does NOT invent data for them.
 *
 * - `brain_observations.relatedTaskId` — not in schema (only `files_modified_json` exists)
 * - `brain_patterns.sourceTaskId` — not in schema
 * - `brain_learnings.sourceTaskId` / `relatedTaskId` — not in schema
 * - `tasks.manifestEntries` nexus symbol links — `manifest_entries.linked_tasks_json` stores task IDs, not nexus refs
 * - `brain_cross_refs` table — does not exist
 * - `conduit.messages.contextTaskId` — messages table has no task FK
 * - `conduit.messages.attachmentIds` referencing brain entries — not in schema
 * - `signaldock.agents.currentSession.taskIds` — no such column
 * - `signaldock.agents.owningMemoryIds` — no such column
 *
 * @task T990
 * @wave Agent D
 *
 * @see cross-substrate-schema.ts — type definitions
 * @see ../brain-adapter.ts — adaptBrainGraph / adaptBrainGraphWithBridges
 */

import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';

import type { GraphEdge, GraphNode } from '../types.js';
import type { BridgeEdge, BridgeStats, BridgeType } from './cross-substrate-schema.js';

// DatabaseSync type alias — matches the import pattern used in @cleocode/brain
type DatabaseSync = _DatabaseSyncType;

// ---------------------------------------------------------------------------
// Internal SQL helpers
// ---------------------------------------------------------------------------

/**
 * Minimal prepared-statement interface required by this adapter.
 * Mirrors the shape from `@cleocode/brain`'s `allTyped` helper.
 */
interface StmtLike {
  all(...params: unknown[]): unknown[];
}

/**
 * Execute a prepared statement and cast to `T[]`.
 * Identical to `allTyped` in `@cleocode/brain/db-connections` —
 * duplicated here so the studio package stays independent.
 */
function allTyped<T>(stmt: StmtLike, ...params: unknown[]): T[] {
  return stmt.all(...params) as T[];
}

// ---------------------------------------------------------------------------
// DB reference bag (passed in by Agent C's server load)
// ---------------------------------------------------------------------------

/**
 * Loose bag of optional DB references forwarded from the server load.
 *
 * Every field is optional: the adapter gracefully degrades when a DB
 * is unavailable (e.g. conduit not initialised, nexus not indexed).
 */
export interface DbRefs {
  /** brain.db connection (per-project). */
  brainDb?: DatabaseSync;
  /** nexus.db connection (global). */
  nexusDb?: DatabaseSync;
  /** tasks.db connection (per-project). */
  tasksDb?: DatabaseSync;
  /** conduit.db connection (per-project). */
  conduitDb?: DatabaseSync;
  /** signaldock.db connection (global). */
  signaldockDb?: DatabaseSync;
}

// ---------------------------------------------------------------------------
// Bridge weight constants
// ---------------------------------------------------------------------------

/** Default weight for all bridge edges — 0.7, higher than intra-substrate defaults. */
const BRIDGE_WEIGHT = 0.7 as const;

// ---------------------------------------------------------------------------
// Per-category bridge builders
// ---------------------------------------------------------------------------

/** Raw row from brain_memory_links. */
interface MemLinkRow {
  memory_type: string;
  memory_id: string;
  task_id: string;
  link_type: string;
}

/** Raw row from brain_decisions (context columns only). */
interface DecisionContextRow {
  id: string;
  context_task_id: string | null;
  context_epic_id: string | null;
}

/** Raw row from brain_page_edges. */
interface PageEdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
}

/** Raw row from brain_observations (files_modified_json only). */
interface ObsFilesRow {
  id: string;
  files_modified_json: string | null;
}

/** Raw row from tasks table (assignee column only). */
interface TaskAssigneeRow {
  id: string;
  assignee: string | null;
}

// ---------------------------------------------------------------------------
// Map brain_memory_links.link_type → EdgeKind
// ---------------------------------------------------------------------------

/**
 * Translate a `brain_memory_links.link_type` value to the canonical
 * `EdgeKind` vocabulary.
 *
 * Known values per `BRAIN_LINK_TYPES` in memory-schema.ts:
 * `produced_by | applies_to | informed_by | contradicts`
 *
 * @param linkType - Raw link_type from brain_memory_links.
 * @returns Canonical EdgeKind.
 */
function memLinkToEdgeKind(
  linkType: string,
): 'produced_by' | 'informed_by' | 'derived_from' | 'relates_to' {
  if (linkType === 'produced_by') return 'produced_by';
  if (linkType === 'informed_by') return 'informed_by';
  if (linkType === 'applies_to') return 'derived_from';
  if (linkType === 'contradicts') return 'relates_to';
  return 'relates_to';
}

// ---------------------------------------------------------------------------
// Helpers for nexus-style ID detection (mirrors brain adapter logic)
// ---------------------------------------------------------------------------

/**
 * Returns true when a `brain_page_edges.to_id` value looks like a nexus
 * node path (contains `::` separator for file::Symbol, or is a relative
 * file path with a `/`).
 *
 * Mirrors `isNexusStyleId` from `packages/brain/src/adapters/brain.ts`.
 *
 * @param toId - Candidate ID string from brain_page_edges.
 */
function isNexusStyleId(toId: string): boolean {
  if (toId.includes('::')) return true;
  if (!toId.includes(':') && toId.includes('/')) return true;
  return false;
}

/**
 * Returns true when a `brain_page_edges.from_id` / `to_id` value represents
 * a task reference (e.g. `"task:T532"`).
 *
 * @param id - Candidate ID string from brain_page_edges.
 */
function isTaskRef(id: string): boolean {
  return id.startsWith('task:');
}

/**
 * Returns true when a `brain_page_edges.from_id` value represents
 * a CONDUIT message reference (e.g. `"msg:msg_abc123"`).
 *
 * @param id - Candidate ID string from brain_page_edges.
 */
function isMsgRef(id: string): boolean {
  return id.startsWith('msg:');
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Compute all cross-substrate bridges between the given node set.
 *
 * This is the primary integration point for Agent C's server load. It
 * is called for tier-0, tier-1, and tier-2 paints. Bridges involving
 * hub nodes are always included — even in tier-0 — because bridges are
 * what makes the first paint look "alive".
 *
 * The function:
 * 1. Enumerates each bridge category using SQL queries against the provided DBs.
 * 2. Filters to bridges where both endpoints exist in `nodes`.
 * 3. Deduplicates by (source, target, kind).
 * 4. Applies a 2 × |nodes| cap, sorted by weight descending.
 * 5. Logs per-category counts to `console.info`.
 *
 * @param nodes - Current node set (substrate-prefixed IDs). Only bridges
 *   where both endpoints appear here are emitted.
 * @param dbRefs - Optional DB connections. Missing DBs produce zero bridges
 *   for that category — no errors are thrown.
 * @returns Array of {@link GraphEdge} objects with `meta.isBridge: true`.
 *
 * @example
 * ```ts
 * import { computeBridges } from '$lib/graph/adapters/cross-substrate.js';
 *
 * const bridges = computeBridges(nodes, { brainDb, tasksDb, nexusDb });
 * const allEdges = [...intraEdges, ...bridges];
 * ```
 */
export function computeBridges(nodes: readonly GraphNode[], dbRefs: DbRefs): GraphEdge[] {
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const raw: BridgeEdge[] = [];

  // -------------------------------------------------------------------------
  // 1. TASK ↔ BRAIN — brain_memory_links
  // -------------------------------------------------------------------------
  if (dbRefs.brainDb) {
    raw.push(...bridgeTaskBrainViaMemLinks(dbRefs.brainDb, nodeIdSet));
    raw.push(...bridgeTaskBrainViaDecisions(dbRefs.brainDb, nodeIdSet));
  }

  // -------------------------------------------------------------------------
  // 2. BRAIN ↔ NEXUS — brain_page_edges (nexus-style to_id)
  // -------------------------------------------------------------------------
  if (dbRefs.brainDb) {
    raw.push(...bridgeBrainNexusViaPageEdges(dbRefs.brainDb, nodeIdSet));
    raw.push(...bridgeBrainNexusViaObsFiles(dbRefs.brainDb, nodeIdSet));
  }

  // -------------------------------------------------------------------------
  // 3. CONDUIT ↔ TASKS — brain_page_edges (msg: from + task: to)
  // -------------------------------------------------------------------------
  if (dbRefs.brainDb) {
    raw.push(...bridgeConduitTasksViaPageEdges(dbRefs.brainDb, nodeIdSet));
  }

  // -------------------------------------------------------------------------
  // 4. SIGNALDOCK ↔ TASKS — tasks.assignee matching loaded signaldock nodes
  // -------------------------------------------------------------------------
  if (dbRefs.tasksDb) {
    raw.push(...bridgeSignaldockTasksViaAssignee(dbRefs.tasksDb, nodeIdSet));
  }

  // -------------------------------------------------------------------------
  // Deduplicate: (source, target, kind) triple
  // -------------------------------------------------------------------------
  const seen = new Set<string>();
  const unique: BridgeEdge[] = [];
  for (const b of raw) {
    const key = `${b.source}|${b.target}|${b.kind}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(b);
    }
  }

  // -------------------------------------------------------------------------
  // Cap at 2 × node count, sorted by weight DESC
  // -------------------------------------------------------------------------
  const cap = nodes.length * 2;
  unique.sort((a, b) => b.weight - a.weight);
  const capped = unique.length > cap;
  const result = capped ? unique.slice(0, cap) : unique;

  // -------------------------------------------------------------------------
  // Log statistics
  // -------------------------------------------------------------------------
  const stats = buildStats(result, capped);
  console.info(
    `[cross-substrate] bridges emitted: ${stats.total} (capped=${stats.capped}) — ` +
      Object.entries(stats.byType)
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `${k}:${v}`)
        .join(', '),
  );

  // -------------------------------------------------------------------------
  // Project to GraphEdge (BridgeEdge is a structural subtype)
  // -------------------------------------------------------------------------
  return result.map(
    (b, i): GraphEdge => ({
      id: `bridge-${i}:${b.source}>${b.target}:${b.kind}`,
      source: b.source,
      target: b.target,
      kind: b.kind,
      weight: b.weight,
      directional: true,
      meta: b.meta,
    }),
  );
}

// ---------------------------------------------------------------------------
// Per-category builders
// ---------------------------------------------------------------------------

/**
 * Bridge: TASK ↔ BRAIN via `brain_memory_links`.
 *
 * The `brain_memory_links` table stores explicit cross-DB links between
 * typed memory entries and tasks. Each row maps (memory_type, memory_id) →
 * task_id with a semantic link_type.
 *
 * Verified present in `memory-schema.ts` as `brainMemoryLinks`.
 *
 * @param db - brain.db connection.
 * @param nodeIds - Set of loaded node IDs.
 * @returns Bridge edges.
 */
function bridgeTaskBrainViaMemLinks(db: DatabaseSync, nodeIds: Set<string>): BridgeEdge[] {
  const bridges: BridgeEdge[] = [];
  try {
    const rows = allTyped<MemLinkRow>(
      db.prepare(
        `SELECT memory_type, memory_id, task_id, link_type
         FROM brain_memory_links
         LIMIT 2000`,
      ),
    );

    for (const row of rows) {
      // brain node ID format: "brain:<memory_id>"
      const brainNodeId = `brain:${row.memory_id}`;
      const tasksNodeId = `tasks:${row.task_id}`;

      if (!nodeIds.has(brainNodeId) || !nodeIds.has(tasksNodeId)) continue;

      const kind = memLinkToEdgeKind(row.link_type);
      const bridgeType: BridgeType = 'task->brain';
      bridges.push({
        source: brainNodeId,
        target: tasksNodeId,
        kind,
        weight: BRIDGE_WEIGHT,
        meta: {
          isBridge: true,
          bridgeType,
          description: `Memory entry ${row.memory_type}:${row.memory_id} ${kind.replace('_', ' ')} task ${row.task_id}`,
          link_type: row.link_type,
          memory_type: row.memory_type,
        },
      });
    }
  } catch {
    // Silently degrade — brain_memory_links may not exist yet
  }
  return bridges;
}

/**
 * Bridge: TASK ↔ BRAIN via `brain_decisions.context_task_id` and
 * `brain_decisions.context_epic_id`.
 *
 * Both columns are present in the schema as soft FKs into tasks.db.
 * Each decision that cites a task gets an `informed_by` bridge pointing
 * to the task that provided the architectural context.
 *
 * Verified present in `memory-schema.ts` as `brainDecisions.contextTaskId`
 * and `brainDecisions.contextEpicId`.
 *
 * @param db - brain.db connection.
 * @param nodeIds - Set of loaded node IDs.
 * @returns Bridge edges.
 */
function bridgeTaskBrainViaDecisions(db: DatabaseSync, nodeIds: Set<string>): BridgeEdge[] {
  const bridges: BridgeEdge[] = [];
  try {
    const rows = allTyped<DecisionContextRow>(
      db.prepare(
        `SELECT id, context_task_id, context_epic_id
         FROM brain_decisions
         WHERE context_task_id IS NOT NULL OR context_epic_id IS NOT NULL
         LIMIT 1000`,
      ),
    );

    for (const row of rows) {
      const brainNodeId = `brain:${row.id}`;
      if (!nodeIds.has(brainNodeId)) continue;

      // context_task_id bridge
      if (row.context_task_id) {
        const tasksNodeId = `tasks:${row.context_task_id}`;
        if (nodeIds.has(tasksNodeId)) {
          bridges.push({
            source: brainNodeId,
            target: tasksNodeId,
            kind: 'informed_by',
            weight: BRIDGE_WEIGHT,
            meta: {
              isBridge: true,
              bridgeType: 'task->brain',
              description: `Decision informed by task ${row.context_task_id}`,
              context_column: 'context_task_id',
            },
          });
        }
      }

      // context_epic_id bridge
      if (row.context_epic_id) {
        const tasksNodeId = `tasks:${row.context_epic_id}`;
        if (nodeIds.has(tasksNodeId)) {
          bridges.push({
            source: brainNodeId,
            target: tasksNodeId,
            kind: 'informed_by',
            weight: BRIDGE_WEIGHT,
            meta: {
              isBridge: true,
              bridgeType: 'task->brain',
              description: `Decision informed by epic ${row.context_epic_id}`,
              context_column: 'context_epic_id',
            },
          });
        }
      }
    }
  } catch {
    // Silently degrade
  }
  return bridges;
}

/**
 * Bridge: BRAIN ↔ NEXUS via `brain_page_edges` where `to_id` is a nexus path.
 *
 * `brain_page_edges.to_id` may store nexus-style IDs:
 * - `"some/path/file.ts::SymbolName"` — a file::Symbol reference
 * - `"some/relative/path.ts"` — a file path (no `:` prefix)
 *
 * These map to `nexus:<to_id>` in the graph. The existing brain.ts adapter
 * already emits some of these in its `BrainEdge` output; this function
 * surfaces the same bridges at the Studio adapter layer so they flow through
 * the `computeBridges` path and carry `meta.isBridge: true`.
 *
 * @param db - brain.db connection.
 * @param nodeIds - Set of loaded node IDs.
 * @returns Bridge edges.
 */
function bridgeBrainNexusViaPageEdges(db: DatabaseSync, nodeIds: Set<string>): BridgeEdge[] {
  const bridges: BridgeEdge[] = [];
  try {
    const rows = allTyped<PageEdgeRow>(
      db.prepare(
        `SELECT from_id, to_id, edge_type, weight
         FROM brain_page_edges
         LIMIT 5000`,
      ),
    );

    for (const row of rows) {
      if (!isNexusStyleId(row.to_id)) continue;

      // Convert from_id to brain node ID
      const sep = row.from_id.indexOf(':');
      if (sep === -1) continue;
      const prefix = row.from_id.slice(0, sep);
      const rawId = row.from_id.slice(sep + 1);
      const validPrefixes = new Set(['observation', 'decision', 'pattern', 'learning']);
      if (!validPrefixes.has(prefix)) continue;

      const brainNodeId = `brain:${rawId}`;
      const nexusNodeId = `nexus:${row.to_id}`;

      if (!nodeIds.has(brainNodeId) || !nodeIds.has(nexusNodeId)) continue;

      bridges.push({
        source: brainNodeId,
        target: nexusNodeId,
        kind: 'references',
        weight: Math.min(1, Math.max(0.1, row.weight ?? BRIDGE_WEIGHT)),
        meta: {
          isBridge: true,
          bridgeType: 'brain->nexus',
          description: `Brain node ${prefix}:${rawId} references code ${row.to_id}`,
          edge_type: row.edge_type,
          link_kind: 'code',
        },
      });
    }
  } catch {
    // Silently degrade — brain_page_edges may be empty
  }
  return bridges;
}

/**
 * Bridge: BRAIN ↔ NEXUS via `brain_observations.files_modified_json`.
 *
 * Each observation can carry a JSON array of relative file paths it
 * modified during the session. Each path maps to `nexus:<path>`.
 *
 * Cap: first 5 links per observation to prevent hairballing on
 * large session observations.
 *
 * Verified present in `memory-schema.ts` as `brainObservations.filesModifiedJson`.
 *
 * @param db - brain.db connection.
 * @param nodeIds - Set of loaded node IDs.
 * @returns Bridge edges.
 */
function bridgeBrainNexusViaObsFiles(db: DatabaseSync, nodeIds: Set<string>): BridgeEdge[] {
  const bridges: BridgeEdge[] = [];
  const MAX_LINKS_PER_OBS = 5;

  try {
    const rows = allTyped<ObsFilesRow>(
      db.prepare(
        `SELECT id, files_modified_json
         FROM brain_observations
         WHERE files_modified_json IS NOT NULL
           AND files_modified_json != '[]'
         LIMIT 500`,
      ),
    );

    for (const row of rows) {
      if (!row.files_modified_json) continue;

      const brainNodeId = `brain:${row.id}`;
      if (!nodeIds.has(brainNodeId)) continue;

      let filePaths: unknown;
      try {
        filePaths = JSON.parse(row.files_modified_json);
      } catch {
        continue;
      }
      if (!Array.isArray(filePaths)) continue;

      const limited = filePaths.slice(0, MAX_LINKS_PER_OBS);
      for (const rawPath of limited) {
        if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
        const nexusNodeId = `nexus:${rawPath}`;
        if (!nodeIds.has(nexusNodeId)) continue;

        bridges.push({
          source: brainNodeId,
          target: nexusNodeId,
          kind: 'documents',
          weight: BRIDGE_WEIGHT,
          meta: {
            isBridge: true,
            bridgeType: 'brain->nexus',
            description: `Observation documents file ${rawPath}`,
            file_path: rawPath,
          },
        });
      }
    }
  } catch {
    // Silently degrade
  }
  return bridges;
}

/**
 * Bridge: CONDUIT ↔ TASKS via `brain_page_edges` where `from_id` is a
 * `msg:` reference and `to_id` is a `task:` reference.
 *
 * `brain_page_edges` stores cross-substrate links at the page-graph level.
 * The `discusses` edge type (defined in `BRAIN_EDGE_TYPES`) connects
 * CONDUIT message nodes to task nodes.
 *
 * The `conduit:` node prefix is used in the graph even though the
 * page-edge stores `msg:` as the type prefix. Conversion:
 * - `msg:<messageId>` → `conduit:<messageId>`
 * - `task:<taskId>` → `tasks:<taskId>`
 *
 * @param db - brain.db connection (page edges cross-reference conduit).
 * @param nodeIds - Set of loaded node IDs.
 * @returns Bridge edges.
 */
function bridgeConduitTasksViaPageEdges(db: DatabaseSync, nodeIds: Set<string>): BridgeEdge[] {
  const bridges: BridgeEdge[] = [];
  try {
    const rows = allTyped<PageEdgeRow>(
      db.prepare(
        `SELECT from_id, to_id, edge_type, weight
         FROM brain_page_edges
         WHERE from_id LIKE 'msg:%'
           AND to_id LIKE 'task:%'
         LIMIT 1000`,
      ),
    );

    for (const row of rows) {
      if (!isMsgRef(row.from_id) || !isTaskRef(row.to_id)) continue;

      const msgId = row.from_id.slice('msg:'.length);
      const taskId = row.to_id.slice('task:'.length);

      const conduitNodeId = `conduit:${msgId}`;
      const tasksNodeId = `tasks:${taskId}`;

      if (!nodeIds.has(conduitNodeId) || !nodeIds.has(tasksNodeId)) continue;

      bridges.push({
        source: conduitNodeId,
        target: tasksNodeId,
        kind: 'messages',
        weight: BRIDGE_WEIGHT,
        meta: {
          isBridge: true,
          bridgeType: 'conduit->tasks',
          description: `Conduit message discusses task ${taskId}`,
          edge_type: row.edge_type,
        },
      });
    }
  } catch {
    // Silently degrade
  }
  return bridges;
}

/**
 * Bridge: SIGNALDOCK ↔ TASKS via `tasks.assignee` matching a loaded
 * signaldock agent node.
 *
 * When a task has an `assignee` field and a signaldock node with that
 * agent ID exists in the loaded node set, emit a `messages` bridge
 * from the agent to the task.
 *
 * The `tasks.assignee` column is verified present in `tasks-schema.ts`.
 * The signaldock node ID format is `signaldock:<agent_id>`.
 *
 * @param db - tasks.db connection.
 * @param nodeIds - Set of loaded node IDs.
 * @returns Bridge edges.
 */
function bridgeSignaldockTasksViaAssignee(db: DatabaseSync, nodeIds: Set<string>): BridgeEdge[] {
  const bridges: BridgeEdge[] = [];
  try {
    const rows = allTyped<TaskAssigneeRow>(
      db.prepare(
        `SELECT id, assignee
         FROM tasks
         WHERE assignee IS NOT NULL
           AND status NOT IN ('archived', 'cancelled')
         LIMIT 1000`,
      ),
    );

    for (const row of rows) {
      if (!row.assignee) continue;

      const tasksNodeId = `tasks:${row.id}`;
      const signaldockNodeId = `signaldock:${row.assignee}`;

      if (!nodeIds.has(tasksNodeId) || !nodeIds.has(signaldockNodeId)) continue;

      bridges.push({
        source: signaldockNodeId,
        target: tasksNodeId,
        kind: 'messages',
        weight: BRIDGE_WEIGHT,
        meta: {
          isBridge: true,
          bridgeType: 'signaldock->tasks',
          description: `Agent ${row.assignee} is assigned to task ${row.id}`,
          assignee: row.assignee,
        },
      });
    }
  } catch {
    // Silently degrade
  }
  return bridges;
}

// ---------------------------------------------------------------------------
// Statistics helper
// ---------------------------------------------------------------------------

/**
 * Build {@link BridgeStats} from an array of bridge edges.
 *
 * @param bridges - The final emitted bridge set.
 * @param capped - Whether the 2 × node-count cap was applied.
 * @returns Statistics summary.
 */
function buildStats(bridges: BridgeEdge[], capped: boolean): BridgeStats {
  const byType: Record<BridgeType, number> = {
    'task->brain': 0,
    'task->nexus': 0,
    'brain->nexus': 0,
    'conduit->tasks': 0,
    'conduit->brain': 0,
    'signaldock->tasks': 0,
    'signaldock->brain': 0,
  };

  for (const b of bridges) {
    const bt = b.meta.bridgeType;
    byType[bt] = (byType[bt] ?? 0) + 1;
  }

  return { total: bridges.length, byType, capped };
}
