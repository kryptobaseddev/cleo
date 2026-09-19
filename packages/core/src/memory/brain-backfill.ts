/**
 * Brain graph back-fill — populates brain_page_nodes and brain_page_edges from
 * existing typed table rows (decisions, patterns, learnings, observations,
 * sticky notes).
 *
 * Each row in a typed table gets a corresponding node in brain_page_nodes.
 * Relationship edges are derived from:
 *   - decision.contextTaskId / contextEpicId  → applies_to edges
 *   - observation.sourceSessionId             → produced_by edge
 *   - observation text referencing task IDs   → applies_to edges
 *   - pattern entries                         → derived_from stubs
 *
 * Stub nodes (task:<id>, session:<id>, epic:<id>) are created for referenced
 * external entities so edges have valid targets.
 *
 * Duplicate nodes are silently skipped (INSERT OR IGNORE semantics via
 * Drizzle onConflictDoNothing).
 *
 * T1003: Staged backfill functions (stagedBackfillRun, approveBackfillRun,
 * rollbackBackfillRun, listBackfillRuns) are appended below the graph
 * back-fill core. Staged runs capture exact source/version and incident-edge
 * preconditions in brain_backfill_runs; approval reconstructs only those missing
 * nodes, without synthesizing edges or invoking the broad graph back-fill.
 *
 * @task T530
 * @epic T523
 */

import { createHash, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { KnowledgeBackfillOptions } from '@cleocode/contracts';
import { z } from 'zod';
import { getBrainAccessor } from '../store/memory-accessor.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import type {
  BrainBackfillRunRow,
  BrainDecisionRow,
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
  NewBrainPageEdgeRow,
  NewBrainPageNodeRow,
} from '../store/schema/memory-schema.js';
import * as brainSchema from '../store/schema/memory-schema.js';

// ============================================================================
// Types
// ============================================================================

/** Result returned by backfillBrainGraph. */
export interface BrainBackfillResult {
  /** Counts before the back-fill ran. */
  before: {
    nodes: number;
    edges: number;
    decisions: number;
    patterns: number;
    learnings: number;
    observations: number;
    stickyNotes: number;
  };
  /** Counts after the back-fill ran. */
  after: {
    nodes: number;
    edges: number;
  };
  /** Number of nodes inserted during this run. */
  nodesInserted: number;
  /** Number of edges inserted during this run. */
  edgesInserted: number;
  /** Number of stub nodes created for external references (tasks, sessions, epics). */
  stubsCreated: number;
  /** Node counts broken down by type. */
  byType: Record<string, number>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Return the SHA-256 prefix (first 16 hex chars) of the given content string.
 * Normalises to lowercase and trims before hashing to improve dedup accuracy.
 */
function sha256prefix(content: string): string {
  return createHash('sha256').update(content.trim().toLowerCase()).digest('hex').substring(0, 16);
}

/**
 * Compute quality score for a decision row.
 * High confidence → 0.9, medium → 0.7, low → 0.5.
 */
function computeDecisionQuality(decision: BrainDecisionRow): number {
  switch (decision.confidence) {
    case 'high':
      return 0.9;
    case 'medium':
      return 0.7;
    default:
      return 0.5;
  }
}

/**
 * Compute quality score for a pattern row.
 * Composite: base 0.4 + frequency factor + success-rate factor.
 * Capped at 0.9 to reserve 1.0 for canonical external references.
 */
function computePatternQuality(pattern: BrainPatternRow): number {
  const freqFactor = Math.min(0.3, (pattern.frequency ?? 1) * 0.05);
  const successFactor = (pattern.successRate ?? 0) * 0.3;
  return Math.min(0.9, 0.4 + freqFactor + successFactor);
}

/**
 * Compute quality score for a learning row.
 * Maps the stored 0.0–1.0 confidence directly to quality, capped at 0.9.
 */
function computeLearningQuality(learning: BrainLearningRow): number {
  return Math.min(0.9, learning.confidence ?? 0.5);
}

/**
 * Compute quality score for an observation row.
 * Manual entries are highest quality (0.8), agent-generated 0.7, others 0.5.
 */
function computeObservationQuality(observation: BrainObservationRow): number {
  switch (observation.sourceType) {
    case 'manual':
      return 0.8;
    case 'agent':
    case 'session-debrief':
      return 0.7;
    default:
      return 0.5;
  }
}

/**
 * Extract task IDs referenced in a block of text.
 * Matches T followed by 3–6 digits (e.g. T530, T5160).
 */
function extractTaskRefs(text: string): string[] {
  const matches = text.match(/\bT\d{3,6}\b/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

// ============================================================================
// Core back-fill function
// ============================================================================

/**
 * Back-fill brain_page_nodes and brain_page_edges from all existing typed rows
 * in brain.db.
 *
 * Safe to run multiple times — duplicate nodes and edges are silently ignored
 * via INSERT OR IGNORE semantics.
 *
 * @param projectRoot - Absolute path to the project root (contains .cleo/).
 * @returns BackfillResult with before/after counts and insertion stats.
 */
export async function backfillBrainGraph(projectRoot: string): Promise<BrainBackfillResult> {
  const db = await getBrainDb(projectRoot);
  const accessor = await getBrainAccessor(projectRoot);

  // ── Before counts ────────────────────────────────────────────────────────
  const [beforeNodes, beforeEdges] = await Promise.all([
    db.select({ count: brainSchema.brainPageNodes.id }).from(brainSchema.brainPageNodes),
    db.select({ count: brainSchema.brainPageEdges.fromId }).from(brainSchema.brainPageEdges),
  ]);

  const [decisions, patterns, learnings, observations, stickyNotes] = await Promise.all([
    accessor.findDecisions(),
    accessor.findPatterns(),
    accessor.findLearnings(),
    accessor.findObservations(),
    accessor.findStickyNotes(),
  ]);

  const beforeNodeCount = beforeNodes.length;
  const beforeEdgeCount = beforeEdges.length;

  // ── Tracking state ────────────────────────────────────────────────────────
  let nodesInserted = 0;
  let edgesInserted = 0;
  let stubsCreated = 0;

  // Track stub nodes we've already created to avoid duplicates
  const createdStubs = new Set<string>();

  // Accumulate pending inserts for batch efficiency
  const pendingNodes: NewBrainPageNodeRow[] = [];
  const pendingEdges: NewBrainPageEdgeRow[] = [];

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  /** Ensure a stub node exists for an external reference (task, session, epic). */
  function scheduleStub(
    nodeId: string,
    nodeType: 'task' | 'session' | 'epic',
    label: string,
  ): void {
    if (createdStubs.has(nodeId)) return;
    createdStubs.add(nodeId);
    pendingNodes.push({
      id: nodeId,
      nodeType,
      label: label.substring(0, 200),
      qualityScore: 1.0,
      contentHash: null,
      lastActivityAt: now,
      metadataJson: null,
      createdAt: now,
      updatedAt: null,
    });
  }

  /** Schedule an edge insert (deduped by fromId+toId+edgeType within this run). */
  const edgeSet = new Set<string>();
  function scheduleEdge(edge: NewBrainPageEdgeRow): void {
    const key = `${edge.fromId}|${edge.toId}|${edge.edgeType}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    pendingEdges.push(edge);
  }

  // ── 1. Decisions ─────────────────────────────────────────────────────────
  const byType: Record<string, number> = {};

  for (const decision of decisions) {
    const nodeId = `decision:${decision.id}`;
    pendingNodes.push({
      id: nodeId,
      nodeType: 'decision',
      label: decision.decision.substring(0, 200),
      qualityScore: computeDecisionQuality(decision),
      contentHash: sha256prefix(decision.decision + (decision.rationale ?? '')),
      lastActivityAt: decision.updatedAt ?? decision.createdAt ?? now,
      metadataJson: JSON.stringify({
        type: decision.type,
        confidence: decision.confidence,
        outcome: decision.outcome,
      }),
      createdAt: decision.createdAt ?? now,
      updatedAt: decision.updatedAt ?? null,
    });
    byType['decision'] = (byType['decision'] ?? 0) + 1;

    // Decision → task applies_to edge
    if (decision.contextTaskId) {
      const taskNodeId = `task:${decision.contextTaskId}`;
      scheduleStub(taskNodeId, 'task', decision.contextTaskId);
      scheduleEdge({
        fromId: nodeId,
        toId: taskNodeId,
        edgeType: 'applies_to',
        weight: 1.0,
        provenance: 'backfill:decision.contextTaskId',
        createdAt: now,
      });
    }

    // Decision → epic applies_to edge
    if (decision.contextEpicId) {
      const epicNodeId = `epic:${decision.contextEpicId}`;
      scheduleStub(epicNodeId, 'epic', decision.contextEpicId);
      scheduleEdge({
        fromId: nodeId,
        toId: epicNodeId,
        edgeType: 'applies_to',
        weight: 0.9,
        provenance: 'backfill:decision.contextEpicId',
        createdAt: now,
      });
    }
  }

  // ── 2. Patterns ───────────────────────────────────────────────────────────
  for (const pattern of patterns) {
    const nodeId = `pattern:${pattern.id}`;
    pendingNodes.push({
      id: nodeId,
      nodeType: 'pattern',
      label: pattern.pattern.substring(0, 200),
      qualityScore: computePatternQuality(pattern),
      contentHash: sha256prefix(pattern.pattern),
      lastActivityAt: pattern.updatedAt ?? pattern.extractedAt ?? now,
      metadataJson: JSON.stringify({
        type: pattern.type,
        frequency: pattern.frequency,
        impact: pattern.impact,
      }),
      createdAt: pattern.extractedAt ?? now,
      updatedAt: pattern.updatedAt ?? null,
    });
    byType['pattern'] = (byType['pattern'] ?? 0) + 1;

    // Patterns referencing tasks in their context field → derived_from edge
    if (pattern.context) {
      const taskRefs = extractTaskRefs(pattern.context);
      for (const taskId of taskRefs) {
        const taskNodeId = `task:${taskId}`;
        scheduleStub(taskNodeId, 'task', taskId);
        scheduleEdge({
          fromId: nodeId,
          toId: taskNodeId,
          edgeType: 'derived_from',
          weight: 0.7,
          provenance: 'backfill:pattern.context-task-ref',
          createdAt: now,
        });
      }
    }
  }

  // ── 3. Learnings ──────────────────────────────────────────────────────────
  for (const learning of learnings) {
    const nodeId = `learning:${learning.id}`;
    pendingNodes.push({
      id: nodeId,
      nodeType: 'learning',
      label: learning.insight.substring(0, 200),
      qualityScore: computeLearningQuality(learning),
      contentHash: sha256prefix(learning.insight + (learning.source ?? '')),
      lastActivityAt: learning.updatedAt ?? learning.createdAt ?? now,
      metadataJson: JSON.stringify({
        confidence: learning.confidence,
        actionable: learning.actionable,
        source: learning.source,
      }),
      createdAt: learning.createdAt ?? now,
      updatedAt: learning.updatedAt ?? null,
    });
    byType['learning'] = (byType['learning'] ?? 0) + 1;
  }

  // ── 4. Observations ───────────────────────────────────────────────────────
  for (const observation of observations) {
    const nodeId = `observation:${observation.id}`;
    const labelSource =
      observation.title || observation.narrative?.substring(0, 200) || 'Untitled observation';
    pendingNodes.push({
      id: nodeId,
      nodeType: 'observation',
      label: labelSource.substring(0, 200),
      qualityScore: computeObservationQuality(observation),
      contentHash:
        observation.contentHash ?? sha256prefix(observation.narrative ?? observation.title ?? ''),
      lastActivityAt: observation.updatedAt ?? observation.createdAt ?? now,
      metadataJson: JSON.stringify({
        sourceType: observation.sourceType,
        agent: observation.agent,
        sessionId: observation.sourceSessionId,
      }),
      createdAt: observation.createdAt ?? now,
      updatedAt: observation.updatedAt ?? null,
    });
    byType['observation'] = (byType['observation'] ?? 0) + 1;

    // Observation → session produced_by edge
    if (observation.sourceSessionId) {
      const sessionNodeId = `session:${observation.sourceSessionId}`;
      scheduleStub(
        sessionNodeId,
        'session',
        `Session ${observation.sourceSessionId.substring(0, 30)}`,
      );
      scheduleEdge({
        fromId: nodeId,
        toId: sessionNodeId,
        edgeType: 'produced_by',
        weight: 1.0,
        provenance: 'backfill:observation.sourceSessionId',
        createdAt: now,
      });
    }

    // Observation text → task applies_to edges
    const fullText = [observation.title, observation.subtitle, observation.narrative]
      .filter(Boolean)
      .join(' ');
    const taskRefs = extractTaskRefs(fullText);
    for (const taskId of taskRefs) {
      const taskNodeId = `task:${taskId}`;
      scheduleStub(taskNodeId, 'task', taskId);
      scheduleEdge({
        fromId: nodeId,
        toId: taskNodeId,
        edgeType: 'applies_to',
        weight: 0.8,
        provenance: 'backfill:observation.text-task-ref',
        createdAt: now,
      });
    }
  }

  // ── 5. Sticky Notes ───────────────────────────────────────────────────────
  for (const sticky of stickyNotes) {
    const nodeId = `sticky:${sticky.id}`;
    const labelSource = sticky.content?.substring(0, 200) ?? 'Untitled sticky';
    pendingNodes.push({
      id: nodeId,
      nodeType: 'sticky',
      label: labelSource.substring(0, 200),
      qualityScore: 0.6,
      contentHash: sha256prefix(sticky.content ?? ''),
      lastActivityAt: sticky.updatedAt ?? sticky.createdAt ?? now,
      metadataJson: JSON.stringify({
        status: sticky.status,
        priority: sticky.priority,
        color: sticky.color,
      }),
      createdAt: sticky.createdAt ?? now,
      updatedAt: sticky.updatedAt ?? null,
    });
    byType['sticky'] = (byType['sticky'] ?? 0) + 1;

    // Sticky notes with task refs → applies_to edges
    if (sticky.content) {
      const taskRefs = extractTaskRefs(sticky.content);
      for (const taskId of taskRefs) {
        const taskNodeId = `task:${taskId}`;
        scheduleStub(taskNodeId, 'task', taskId);
        scheduleEdge({
          fromId: nodeId,
          toId: taskNodeId,
          edgeType: 'applies_to',
          weight: 0.7,
          provenance: 'backfill:sticky.content-task-ref',
          createdAt: now,
        });
      }
    }
  }

  // ── Flush nodes (INSERT OR IGNORE) ─────────────────────────────────────────
  const BATCH_SIZE = 50;

  for (let i = 0; i < pendingNodes.length; i += BATCH_SIZE) {
    const batch = pendingNodes.slice(i, i + BATCH_SIZE);
    await db.insert(brainSchema.brainPageNodes).values(batch).onConflictDoNothing();
    nodesInserted += batch.length;
  }

  // Stub nodes count
  stubsCreated = createdStubs.size;

  // ── Flush edges (INSERT OR IGNORE) ─────────────────────────────────────────
  for (let i = 0; i < pendingEdges.length; i += BATCH_SIZE) {
    const batch = pendingEdges.slice(i, i + BATCH_SIZE);
    await db.insert(brainSchema.brainPageEdges).values(batch).onConflictDoNothing();
    edgesInserted += batch.length;
  }

  // ── After counts ──────────────────────────────────────────────────────────
  const [afterNodes, afterEdges] = await Promise.all([
    db.select({ id: brainSchema.brainPageNodes.id }).from(brainSchema.brainPageNodes),
    db.select({ fromId: brainSchema.brainPageEdges.fromId }).from(brainSchema.brainPageEdges),
  ]);

  return {
    before: {
      nodes: beforeNodeCount,
      edges: beforeEdgeCount,
      decisions: decisions.length,
      patterns: patterns.length,
      learnings: learnings.length,
      observations: observations.length,
      stickyNotes: stickyNotes.length,
    },
    after: {
      nodes: afterNodes.length,
      edges: afterEdges.length,
    },
    nodesInserted,
    edgesInserted,
    stubsCreated,
    byType,
  };
}

// ============================================================================
// Staged Backfill (T1003)
// ============================================================================

/**
 * Generate a unique backfill run ID.
 * Format: `bfr-<base36-timestamp>-<random4hex>`
 */
function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `bfr-${ts}-${rand}`;
}

/**
 * Result of a staged backfill run creation.
 *
 * A staged run does NOT commit any rows to live tables. The caller must call
 * `approveBackfillRun` to commit or `rollbackBackfillRun` to discard.
 *
 * @task T1003
 */
export interface StagedBackfillRunResult {
  /** The new run record. */
  run: BrainBackfillRunRow;
  /**
   * True when no rows matched the source (run was staged with rowsAffected=0).
   * Callers may still approve or rollback a zero-row run.
   */
  empty: boolean;
}

const stagedSourceTableSchema = z.enum([
  'brain_decisions',
  'brain_patterns',
  'brain_learnings',
  'brain_observations',
  'brain_sticky_notes',
]);
const stagedNodeSchema = z.object({
  id: z.string(),
  node_type: z.string(),
  label: z.string(),
  quality_score: z.number(),
  content_hash: z.string(),
  metadata_json: z.string(),
  created_at: z.string(),
  last_activity_at: z.string(),
  updated_at: z.null(),
});
const stagedSnapshotSchema = z.object({
  version: z.literal(2),
  projectRoot: z.string(),
  candidates: z
    .array(
      z.object({
        id: z.string(),
        sourceTable: stagedSourceTableSchema,
        sourceId: z.string(),
        sourceHash: z.string(),
        edgeHash: z.string(),
        node: stagedNodeSchema,
      }),
    )
    .max(500),
  created: z
    .array(z.object({ id: z.string(), rowHash: z.string(), edgeHash: z.string() }))
    .max(500),
});
const stagedRunSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  created_at: z.string(),
  approved_at: z.string().nullable(),
  rows_affected: z.number(),
  rollback_snapshot_json: z.string().nullable(),
  source: z.string(),
  target_table: z.string(),
  approved_by: z.string().nullable(),
});
const typedSourceSchema = z.record(z.string(), z.union([z.string(), z.number(), z.null()]));
const sourceKinds = {
  brain_decisions: 'decision',
  brain_patterns: 'pattern',
  brain_learnings: 'learning',
  brain_observations: 'observation',
  brain_sticky_notes: 'sticky',
} as const;
const volatileSourceFields = new Set([
  'access_count',
  'last_accessed_at',
  'citation_count',
  'last_cited_at',
  'updated_at',
  'retrieval_count',
  'last_retrieved_at',
  'last_activity_at',
  'reinforcement_count',
]);

/** Hash source content and provenance without treating retrieval counters as an edit. */
function stagedSourceHash(row: z.infer<typeof typedSourceSchema>): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        Object.entries(row)
          .filter(([key]) => !volatileSourceFields.has(key))
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest('hex');
}

/** Fingerprint exact graph rows, including concurrent relationship changes. */
function stagedGraphHash(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Read all incident edges without modifying historical relationships. */
function stagedEdgesHash(db: NonNullable<ReturnType<typeof getBrainNativeDb>>, id: string): string {
  return stagedGraphHash(
    db
      .prepare(
        'SELECT * FROM main.brain_page_edges WHERE from_id = ? OR to_id = ? ORDER BY from_id, to_id, edge_type',
      )
      .all(id, id),
  );
}

/** Reject legacy and cross-project snapshots rather than guessing which rows may be removed. */
function readStagedSnapshot(
  raw: z.infer<typeof stagedRunSchema>,
  projectRoot: string,
): z.infer<typeof stagedSnapshotSchema> {
  if (raw.target_table !== 'brain_page_nodes')
    throw new Error('Staged backfill supports derived brain_page_nodes only.');
  const parsed = stagedSnapshotSchema.safeParse(JSON.parse(raw.rollback_snapshot_json ?? 'null'));
  if (!parsed.success)
    throw new Error(
      'Backfill snapshot lacks exact source and recovery preconditions; discard this staged run and stage a new run. Legacy approved runs require their canonical backup.',
    );
  if (parsed.data.projectRoot !== realpathSync(projectRoot))
    throw new Error('Backfill project binding changed.');
  return parsed.data;
}

/** Read a validated ledger row while the caller holds the writer transaction. */
function readStagedRun(
  db: NonNullable<ReturnType<typeof getBrainNativeDb>>,
  runId: string,
): z.infer<typeof stagedRunSchema> {
  const row = db.prepare('SELECT * FROM main.brain_backfill_runs WHERE id = ?').get(runId);
  if (!row) throw new Error(`Backfill run '${runId}' not found`);
  return stagedRunSchema.parse(row);
}

/**
 * Stage a graph backfill run against brain_page_nodes / brain_page_edges.
 *
 * Discovers all candidate node IDs from typed tables (decisions, patterns,
 * learnings, observations, sticky notes) that are NOT yet in brain_page_nodes.
 * Captures exact nodes, source hashes, incident-edge fingerprints and project binding in
 * `rollback_snapshot_json`, and creates a `brain_backfill_runs`
 * row with status='staged'. The ledger is written, but derived graph rows are unchanged.
 *
 * Pass `source` as a human-readable descriptor (e.g. a file path or session ID).
 * Pass `kind` as the backfill kind (e.g. 'graph-backfill', 'observation-promotion').
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts - Optional overrides for source, kind, and target table.
 * @returns StagedBackfillRunResult with the staged run record.
 *
 * @task T1003
 * @remarks The snapshot captures exact source and relationship preconditions without mutating derived nodes.
 * @example
 * ```ts
 * const staged = await stagedBackfillRun(projectRoot, undefined);
 * ```
 */
export async function stagedBackfillRun(
  projectRoot: string,
  opts?: KnowledgeBackfillOptions,
): Promise<StagedBackfillRunResult> {
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb(projectRoot);
  if (!db) throw new Error('brain.db native handle unavailable');
  if (opts?.targetTable && opts.targetTable !== 'brain_page_nodes')
    throw new Error('Staged backfill supports derived brain_page_nodes only.');
  const selected =
    opts?.nodeIds === undefined
      ? undefined
      : z.array(z.string().min(1)).min(1).max(500).parse(opts.nodeIds);
  if (selected && new Set(selected).size !== selected.length)
    throw new Error('Backfill nodeIds must not contain duplicates.');
  db.exec('BEGIN IMMEDIATE');
  try {
    const now = new Date().toISOString();
    const snapshot: z.infer<typeof stagedSnapshotSchema> = {
      version: 2,
      projectRoot: realpathSync(projectRoot),
      candidates: [],
      created: [],
    };
    for (const sourceTable of stagedSourceTableSchema.options) {
      const kind = sourceKinds[sourceTable];
      const selection = selected
        ? ` AND (? || ':' || source.id) IN (${selected.map(() => '?').join(',')})`
        : '';
      const rows = db
        .prepare(`SELECT source.* FROM main.${sourceTable} source
        LEFT JOIN main.brain_page_nodes node ON node.id = ? || ':' || source.id
        WHERE node.id IS NULL${selection} ORDER BY source.id LIMIT 501`)
        .all(kind, ...(selected ? [kind, ...selected] : []));
      for (const value of rows) {
        const source = typedSourceSchema.parse(value);
        if (typeof source.id !== 'string') throw new Error('Backfill source identifier is invalid');
        const id = `${kind}:${source.id}`;
        if (
          selected &&
          (source.invalid_at != null ||
            (kind === 'decision' &&
              (source.superseded_by != null || source.confirmation_state === 'superseded')))
        )
          throw new Error(`Selected backfill source ${id} is not currently eligible.`);
        const sourceHash = stagedSourceHash(source);
        const label =
          source.decision ?? source.pattern ?? source.insight ?? source.title ?? source.content;
        if (typeof label !== 'string' || !label.trim())
          throw new Error(
            `Backfill source ${id} has no substantive label; resolve it before staging.`,
          );
        snapshot.candidates.push({
          id,
          sourceId: source.id,
          sourceTable,
          sourceHash,
          edgeHash: stagedEdgesHash(db, id),
          node: {
            id,
            node_type: kind,
            label: label.slice(0, 200),
            quality_score: typeof source.quality_score === 'number' ? source.quality_score : 0.5,
            content_hash: sourceHash,
            metadata_json: JSON.stringify({
              sourceTable,
              sourceId: source.id,
              sourceHash,
              derived: true,
            }),
            created_at: now,
            last_activity_at: now,
            updated_at: null,
          },
        });
        if (snapshot.candidates.length > 500)
          throw new Error(
            'More than 500 missing nodes require a bounded source selection before staging.',
          );
      }
    }
    if (selected && snapshot.candidates.length !== selected.length) {
      const found = new Set(snapshot.candidates.map((candidate) => candidate.id));
      throw new Error(
        `Selected backfill IDs are missing, already indexed, or unsupported: ${selected.filter((id) => !found.has(id)).join(', ')}`,
      );
    }
    const id = generateRunId();
    db.prepare(`INSERT INTO main.brain_backfill_runs
      (id, kind, status, created_at, rows_affected, rollback_snapshot_json, source, target_table)
      VALUES (?, ?, 'staged', ?, ?, ?, ?, 'brain_page_nodes')`).run(
      id,
      opts?.kind ?? 'graph-backfill',
      now,
      snapshot.candidates.length,
      JSON.stringify(snapshot),
      opts?.source ?? 'staged-run',
    );
    const run = mapRunRow(readStagedRun(db, id));
    db.exec('COMMIT');
    return { run, empty: snapshot.candidates.length === 0 };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Approve a staged backfill run, committing its rows to live brain tables.
 *
 * Reads the staged run under a writer transaction, validates its exact source
 * and graph preconditions, then inserts only its reviewed derived nodes. The
 * same transaction records created-row hashes and approval metadata for recovery.
 * Historical edges remain unchanged.
 *
 * Double-approve is idempotent: returns `{ alreadySettled: true }` if the run
 * is already approved or rolled-back.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param runId - The brain_backfill_runs.id to approve.
 * @param approvedBy - Optional identity of the approver (defaults to 'owner').
 * @returns Result with the updated run record and graph backfill stats.
 *
 * @task T1003
 * @remarks Approval inserts only the reviewed nodes and records recovery hashes atomically; stale source or graph state is rejected.
 * @example
 * ```ts
 * const applied = await approveBackfillRun(projectRoot, runId, 'calling-agent');
 * ```
 */
export async function approveBackfillRun(
  projectRoot: string,
  runId: string,
  approvedBy?: string,
): Promise<{
  run: BrainBackfillRunRow;
  alreadySettled: boolean;
  backfillResult?: BrainBackfillResult;
}> {
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb(projectRoot);
  if (!db) throw new Error('brain.db native handle unavailable');
  db.exec('BEGIN IMMEDIATE');
  try {
    const raw = readStagedRun(db, runId);
    if (raw.status === 'approved' || raw.status === 'rolled-back') {
      db.exec('COMMIT');
      return { run: mapRunRow(raw), alreadySettled: true };
    }
    if (raw.status !== 'staged') throw new Error('Backfill run is not staged.');
    const snapshot = readStagedSnapshot(raw, projectRoot);
    if (snapshot.created.length)
      throw new Error('Staged backfill unexpectedly contains committed nodes.');
    const beforeNodes = Number(
      db.prepare('SELECT COUNT(*) AS count FROM main.brain_page_nodes').get()?.count,
    );
    const beforeEdges = Number(
      db.prepare('SELECT COUNT(*) AS count FROM main.brain_page_edges').get()?.count,
    );
    const typedCounts = Object.fromEntries(
      stagedSourceTableSchema.options.map((table) => [
        table,
        Number(db.prepare(`SELECT COUNT(*) AS count FROM main.${table}`).get()?.count),
      ]),
    );
    for (const candidate of snapshot.candidates) {
      const current = typedSourceSchema.parse(
        db
          .prepare(`SELECT * FROM main.${candidate.sourceTable} WHERE id = ?`)
          .get(candidate.sourceId),
      );
      if (
        candidate.id !== `${sourceKinds[candidate.sourceTable]}:${candidate.sourceId}` ||
        candidate.node.id !== candidate.id ||
        stagedSourceHash(current) !== candidate.sourceHash ||
        db.prepare('SELECT id FROM main.brain_page_nodes WHERE id = ?').get(candidate.id) ||
        stagedEdgesHash(db, candidate.id) !== candidate.edgeHash
      )
        throw new Error(`Backfill proposal is stale for ${candidate.id}; stage a new run.`);
    }
    const insert = db.prepare(`INSERT INTO main.brain_page_nodes
      (id, node_type, label, quality_score, content_hash, metadata_json, created_at, last_activity_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const byType: Record<string, number> = {};
    for (const candidate of snapshot.candidates) {
      const node = candidate.node;
      insert.run(
        node.id,
        node.node_type,
        node.label,
        node.quality_score,
        node.content_hash,
        node.metadata_json,
        node.created_at,
        node.last_activity_at,
        node.updated_at,
      );
      const created = db.prepare('SELECT * FROM main.brain_page_nodes WHERE id = ?').get(node.id);
      if (!created) throw new Error('Created backfill node is unreadable');
      snapshot.created.push({
        id: node.id,
        rowHash: stagedGraphHash(created),
        edgeHash: stagedEdgesHash(db, node.id),
      });
      byType[node.node_type] = (byType[node.node_type] ?? 0) + 1;
    }
    db.prepare(
      `UPDATE main.brain_backfill_runs SET status = 'approved', approved_at = ?, approved_by = ?, rollback_snapshot_json = ? WHERE id = ?`,
    ).run(new Date().toISOString(), approvedBy ?? 'owner', JSON.stringify(snapshot), runId);
    const run = mapRunRow(readStagedRun(db, runId));
    db.exec('COMMIT');
    return {
      run,
      alreadySettled: false,
      backfillResult: {
        before: {
          nodes: beforeNodes,
          edges: beforeEdges,
          decisions: typedCounts['brain_decisions'] ?? 0,
          patterns: typedCounts['brain_patterns'] ?? 0,
          learnings: typedCounts['brain_learnings'] ?? 0,
          observations: typedCounts['brain_observations'] ?? 0,
          stickyNotes: typedCounts['brain_sticky_notes'] ?? 0,
        },
        after: { nodes: beforeNodes + snapshot.created.length, edges: beforeEdges },
        nodesInserted: snapshot.created.length,
        edgesInserted: 0,
        stubsCreated: 0,
        byType,
      },
    };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Rollback a staged backfill run, discarding staged rows.
 *
 * If the run is still 'staged', marks it as 'rolled-back' (no rows were ever
 * committed, so no DELETE is required).
 *
 * If the run is 'approved', reads `rollback_snapshot_json` and DELETEs the
 * committed rows from the target table, then marks the run as 'rolled-back'.
 *
 * Idempotent: rolling back an already-rolled-back run returns
 * `{ alreadySettled: true }` without error.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param runId - The brain_backfill_runs.id to roll back.
 * @returns Result with the updated run record and optional delete count.
 *
 * @task T1003
 * @remarks Recovery removes only unchanged nodes created by this run and refuses concurrent node or edge edits.
 * @example
 * ```ts
 * const restored = await rollbackBackfillRun(projectRoot, runId);
 * ```
 */
export async function rollbackBackfillRun(
  projectRoot: string,
  runId: string,
): Promise<{
  run: BrainBackfillRunRow;
  alreadySettled: boolean;
  deletedRows: number;
}> {
  await getBrainDb(projectRoot);
  const db = getBrainNativeDb(projectRoot);
  if (!db) throw new Error('brain.db native handle unavailable');
  db.exec('BEGIN IMMEDIATE');
  try {
    const raw = readStagedRun(db, runId);
    if (raw.status === 'rolled-back') {
      db.exec('COMMIT');
      return { run: mapRunRow(raw), alreadySettled: true, deletedRows: 0 };
    }
    let deletedRows = 0;
    if (raw.status === 'approved') {
      const snapshot = readStagedSnapshot(raw, projectRoot);
      if (snapshot.created.length !== snapshot.candidates.length)
        throw new Error('Backfill receipt does not cover every created node.');
      for (const created of snapshot.created) {
        const current = db
          .prepare('SELECT * FROM main.brain_page_nodes WHERE id = ?')
          .get(created.id);
        if (
          !current ||
          stagedGraphHash(current) !== created.rowHash ||
          stagedEdgesHash(db, created.id) !== created.edgeHash
        )
          throw new Error(
            `Backfill rollback is stale for ${created.id}; preserve concurrent changes and inspect the canonical backup.`,
          );
      }
      for (const created of snapshot.created) {
        const result = db.prepare('DELETE FROM main.brain_page_nodes WHERE id = ?').run(created.id);
        deletedRows += Number(result.changes);
      }
    } else if (raw.status !== 'staged')
      throw new Error('Backfill run cannot be rolled back from its current state.');
    db.prepare("UPDATE main.brain_backfill_runs SET status = 'rolled-back' WHERE id = ?").run(
      runId,
    );
    const run = mapRunRow(readStagedRun(db, runId));
    db.exec('COMMIT');
    return { run, alreadySettled: false, deletedRows };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * List backfill runs, optionally filtered by status.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts - Optional status filter and limit.
 * @returns Array of run records, ordered by created_at DESC.
 *
 * @task T1003
 */
export async function listBackfillRuns(
  projectRoot: string,
  opts?: { status?: string; limit?: number },
): Promise<BrainBackfillRunRow[]> {
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb(projectRoot);
  if (!nativeDb) {
    throw new Error('brain.db native handle unavailable');
  }

  const limit = opts?.limit ?? 50;
  const status = opts?.status;

  interface RunRow {
    id: string;
    kind: string;
    status: string;
    created_at: string;
    approved_at: string | null;
    rows_affected: number;
    rollback_snapshot_json: string | null;
    source: string;
    target_table: string;
    approved_by: string | null;
  }

  let rawRows: RunRow[];
  if (status) {
    rawRows = nativeDb
      .prepare(
        `SELECT * FROM brain_backfill_runs WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(status, limit) as unknown as RunRow[];
  } else {
    rawRows = nativeDb
      .prepare(`SELECT * FROM brain_backfill_runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as unknown as RunRow[];
  }

  return rawRows.map(mapRunRow);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Map a raw SQLite row from brain_backfill_runs to a typed BrainBackfillRunRow.
 */
function mapRunRow(raw: {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  approved_at: string | null;
  rows_affected: number;
  rollback_snapshot_json: string | null;
  source: string;
  target_table: string;
  approved_by: string | null;
}): BrainBackfillRunRow {
  return {
    id: raw.id,
    kind: raw.kind,
    status: raw.status,
    createdAt: raw.created_at,
    approvedAt: raw.approved_at,
    rowsAffected: raw.rows_affected,
    rollbackSnapshotJson: raw.rollback_snapshot_json,
    source: raw.source,
    targetTable: raw.target_table,
    approvedBy: raw.approved_by,
  };
}
