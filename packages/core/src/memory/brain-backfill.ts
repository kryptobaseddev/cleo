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
 * back-fill core. Staged runs write row IDs to brain_backfill_runs first;
 * actual mutations happen only on approve.
 *
 * @task T530
 * @epic T523
 */

import { createHash, randomBytes } from 'node:crypto';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type {
  BrainBackfillRunRow,
  BrainDecisionRow,
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
  NewBrainPageEdgeRow,
  NewBrainPageNodeRow,
} from '../store/memory-schema.js';
import * as brainSchema from '../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';

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

/**
 * Stage a graph backfill run against brain_page_nodes / brain_page_edges.
 *
 * Discovers all candidate node IDs from typed tables (decisions, patterns,
 * learnings, observations, sticky notes) that are NOT yet in brain_page_nodes.
 * Writes the list to `rollback_snapshot_json` and creates a `brain_backfill_runs`
 * row with status='staged'. No rows are inserted into brain tables.
 *
 * Pass `source` as a human-readable descriptor (e.g. a file path or session ID).
 * Pass `kind` as the backfill kind (e.g. 'graph-backfill', 'observation-promotion').
 *
 * @param projectRoot - Absolute path to the project root.
 * @param opts - Optional overrides for source, kind, and target table.
 * @returns StagedBackfillRunResult with the staged run record.
 *
 * @task T1003
 */
export async function stagedBackfillRun(
  projectRoot: string,
  opts?: {
    source?: string;
    kind?: string;
    targetTable?: string;
  },
): Promise<StagedBackfillRunResult> {
  const db = await getBrainDb(projectRoot);
  const accessor = await getBrainAccessor(projectRoot);

  const source = opts?.source ?? 'staged-run';
  const kind = opts?.kind ?? 'graph-backfill';
  const targetTable = opts?.targetTable ?? 'brain_page_nodes';

  // Gather candidate IDs not yet in brain_page_nodes
  const [decisions, patterns, learnings, observations, stickyNotes] = await Promise.all([
    accessor.findDecisions(),
    accessor.findPatterns(),
    accessor.findLearnings(),
    accessor.findObservations(),
    accessor.findStickyNotes(),
  ]);

  // Collect candidate node IDs
  const candidates: string[] = [
    ...decisions.map((d) => `decision:${d.id}`),
    ...patterns.map((p) => `pattern:${p.id}`),
    ...learnings.map((l) => `learning:${l.id}`),
    ...observations.map((o) => `observation:${o.id}`),
    ...stickyNotes.map((s) => `sticky:${s.id}`),
  ];

  // Filter out IDs already present in brain_page_nodes
  const existingNodes = await db
    .select({ id: brainSchema.brainPageNodes.id })
    .from(brainSchema.brainPageNodes);
  const existingSet = new Set(existingNodes.map((n) => n.id));
  const pendingIds = candidates.filter((id) => !existingSet.has(id));

  const runId = generateRunId();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const run: BrainBackfillRunRow = {
    id: runId,
    kind,
    status: 'staged',
    createdAt: now,
    approvedAt: null,
    rowsAffected: pendingIds.length,
    rollbackSnapshotJson: JSON.stringify(pendingIds),
    source,
    targetTable,
    approvedBy: null,
  };

  await db.insert(brainSchema.brainBackfillRuns).values(run);

  return {
    run,
    empty: pendingIds.length === 0,
  };
}

/**
 * Approve a staged backfill run, committing its rows to live brain tables.
 *
 * Reads the run record, validates that it is in 'staged' status, then triggers
 * `backfillBrainGraph` to perform the actual INSERT OR IGNORE work. Finally,
 * updates the run row to status='approved' with the current timestamp.
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
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) {
    throw new Error('brain.db native handle unavailable');
  }

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

  const rawRun = nativeDb
    .prepare('SELECT * FROM brain_backfill_runs WHERE id = ? LIMIT 1')
    .get(runId) as unknown as RunRow | undefined;

  if (!rawRun) {
    throw new Error(`Backfill run '${runId}' not found`);
  }

  // If already settled, return as-is
  if (rawRun.status === 'approved' || rawRun.status === 'rolled-back') {
    const run = mapRunRow(rawRun);
    return { run, alreadySettled: true };
  }

  // Execute the actual backfill
  const backfillResult = await backfillBrainGraph(projectRoot);

  // Mark run as approved
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const approver = approvedBy ?? 'owner';
  nativeDb
    .prepare(
      `UPDATE brain_backfill_runs
       SET status = 'approved', approved_at = ?, approved_by = ?
       WHERE id = ?`,
    )
    .run(now, approver, runId);

  // Re-fetch updated run
  const updatedRaw = nativeDb
    .prepare('SELECT * FROM brain_backfill_runs WHERE id = ? LIMIT 1')
    .get(runId) as unknown as RunRow;

  return {
    run: mapRunRow(updatedRaw),
    alreadySettled: false,
    backfillResult,
  };
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
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) {
    throw new Error('brain.db native handle unavailable');
  }

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

  const rawRun = nativeDb
    .prepare('SELECT * FROM brain_backfill_runs WHERE id = ? LIMIT 1')
    .get(runId) as unknown as RunRow | undefined;

  if (!rawRun) {
    throw new Error(`Backfill run '${runId}' not found`);
  }

  // Already rolled back — idempotent no-op
  if (rawRun.status === 'rolled-back') {
    return { run: mapRunRow(rawRun), alreadySettled: true, deletedRows: 0 };
  }

  let deletedRows = 0;

  // If already approved, we need to DELETE committed rows from the target table
  if (rawRun.status === 'approved' && rawRun.rollback_snapshot_json) {
    let ids: string[] = [];
    try {
      ids = JSON.parse(rawRun.rollback_snapshot_json) as string[];
    } catch {
      // Malformed snapshot — proceed without deleting
    }

    if (ids.length > 0) {
      const targetTable = rawRun.target_table;
      // Validate table name against known brain tables (prevent SQL injection)
      const allowedTables = [
        'brain_page_nodes',
        'brain_observations',
        'brain_decisions',
        'brain_patterns',
        'brain_learnings',
        'brain_transcript_events',
      ] as const;
      if ((allowedTables as readonly string[]).includes(targetTable)) {
        // SQLite has a limit of ~999 bound params — chunk if needed
        const CHUNK = 200;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const chunk = ids.slice(i, i + CHUNK);
          const placeholders = chunk.map(() => '?').join(',');
          const result = nativeDb
            .prepare(`DELETE FROM ${targetTable} WHERE id IN (${placeholders})`)
            .run(...chunk) as { changes: number };
          deletedRows += result.changes ?? 0;
        }
      }
    }
  }

  // Mark run as rolled-back
  nativeDb.prepare(`UPDATE brain_backfill_runs SET status = 'rolled-back' WHERE id = ?`).run(runId);

  const updatedRaw = nativeDb
    .prepare('SELECT * FROM brain_backfill_runs WHERE id = ? LIMIT 1')
    .get(runId) as unknown as RunRow;

  return { run: mapRunRow(updatedRaw), alreadySettled: false, deletedRows };
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
  const nativeDb = getBrainNativeDb();
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
