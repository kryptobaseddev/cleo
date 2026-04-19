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
 * @task T530
 * @epic T523
 */

import { createHash } from 'node:crypto';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type {
  BrainDecisionRow,
  BrainLearningRow,
  BrainObservationRow,
  BrainPatternRow,
  NewBrainPageEdgeRow,
  NewBrainPageNodeRow,
} from '../store/memory-schema.js';
import * as brainSchema from '../store/memory-schema.js';
import { getBrainDb } from '../store/memory-sqlite.js';

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
