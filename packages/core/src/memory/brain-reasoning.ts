/**
 * BRAIN Reasoning — causal trace through task dependency chains and code symbols.
 *
 * `reasonWhy(taskId)` walks upstream through a task's blocker chain,
 * enriching each node with related brain_decisions. Leaf tasks with
 * no further unresolved blockers are identified as root causes.
 *
 * `reasonWhySymbol(symbolId)` traces a code symbol through BRAIN edges
 * (code_reference, documents, applies_to) to brain decisions and their
 * originating tasks, returning a human-readable narrative and chain.
 *
 * @task T5390, T1069
 * @epic T5149, T1042
 */

import type { CodeReasonTrace, ReasonTraceStep } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainDecisionRow } from '../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { typedAll, typedGet } from '../store/typed-query.js';
import type { BrainDecisionNode } from './brain-row-types.js';
import { searchBrain } from './brain-search.js';
import { searchSimilar } from './brain-similarity.js';
import { EDGE_TYPES } from './edge-types.js';

// ============================================================================
// Types
// ============================================================================

export interface BlockerNode {
  taskId: string;
  status: string;
  reason?: string;
  decisions: BrainDecisionNode[];
}

export interface CausalTrace {
  taskId: string;
  blockers: BlockerNode[];
  rootCauses: string[];
  depth: number;
}

// ============================================================================
// Implementation
// ============================================================================

const MAX_DEPTH = 10;

/**
 * Build a causal trace for why a task is blocked.
 *
 * Walks upstream through `depends` fields, collecting unresolved blockers
 * and their associated brain decisions. Leaf blockers (no further unresolved
 * deps) are reported as root causes.
 */
export async function reasonWhy(
  taskId: string,
  projectRoot: string,
  taskAccessor?: DataAccessor,
): Promise<CausalTrace> {
  const acc = taskAccessor ?? (await getAccessor(projectRoot));
  const { tasks: reasonTasks } = await acc.queryTasks({});
  const taskMap = new Map(reasonTasks.map((t) => [t.id, t]));

  const completedStatuses = new Set(['done', 'cancelled']);

  let accessor: Awaited<ReturnType<typeof getBrainAccessor>> | null = null;
  try {
    accessor = await getBrainAccessor(projectRoot);
  } catch {
    // brain.db may not exist — proceed without decisions
  }

  const visited = new Set<string>();
  const blockers: BlockerNode[] = [];
  let maxDepthReached = 0;

  async function walk(id: string, depth: number): Promise<void> {
    if (visited.has(id)) return;
    if (depth > MAX_DEPTH) return;
    visited.add(id);

    if (depth > maxDepthReached) {
      maxDepthReached = depth;
    }

    const task = taskMap.get(id);
    if (!task) return;

    // Collect unresolved dependencies
    const unresolvedDeps = (task.depends ?? []).filter((depId) => {
      const dep = taskMap.get(depId);
      return dep && !completedStatuses.has(dep.status);
    });

    if (unresolvedDeps.length === 0 && id !== taskId) {
      // This is a leaf blocker — no further unresolved deps
      return;
    }

    for (const depId of unresolvedDeps) {
      if (visited.has(depId)) continue;

      const dep = taskMap.get(depId)!;

      // Query brain decisions related to this blocker
      let decisions: BrainDecisionNode[] = [];
      if (accessor) {
        const relatedDecisions = await findDecisionsForTask(accessor, depId);
        decisions = relatedDecisions.map((d) => ({
          id: d.id,
          title: d.decision,
          rationale: d.rationale,
        }));
      }

      blockers.push({
        taskId: depId,
        status: dep.status,
        reason: dep.blockedBy ?? undefined,
        decisions,
      });

      await walk(depId, depth + 1);
    }
  }

  await walk(taskId, 0);

  // Root causes: leaf blockers whose own deps are all resolved or absent
  const blockerIds = new Set(blockers.map((b) => b.taskId));
  const rootCauses = blockers
    .filter((b) => {
      const task = taskMap.get(b.taskId);
      if (!task?.depends?.length) return true;
      return task.depends.every((depId) => {
        const dep = taskMap.get(depId);
        return !dep || completedStatuses.has(dep.status) || !blockerIds.has(depId);
      });
    })
    .map((b) => b.taskId);

  return {
    taskId,
    blockers,
    rootCauses,
    depth: maxDepthReached,
  };
}

/**
 * Query brain_decisions for a specific task context.
 */
async function findDecisionsForTask(
  accessor: Awaited<ReturnType<typeof getBrainAccessor>>,
  taskId: string,
): Promise<BrainDecisionRow[]> {
  return accessor.findDecisions({ contextTaskId: taskId });
}

// ============================================================================
// reasonWhySymbol — trace code symbol through brain decisions to tasks
// ============================================================================

/** Raw row types for reasonWhySymbol internal queries. */
interface RawBrainEdge {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
}

interface RawBrainNode {
  id: string;
  node_type: string;
  label: string;
  quality_score: number;
}

interface RawDecisionRow {
  id: string;
  decision: string;
  rationale: string | null;
  context_task_id: string | null;
}

interface RawLearningRow {
  id: string;
  insight: string;
}

/**
 * Trace why a code symbol exists / is structured this way.
 *
 * Walks: symbol → reverse `code_reference`/`documents`/`applies_to` edges
 * to brain_page_nodes (observations + decisions) → those decisions'
 * `context_task_id` → tasks → `task_touches_symbol` edges to other symbols.
 *
 * Returns a typed `CodeReasonTrace` with a narrative and step chain.
 *
 * @param symbolId - Nexus node ID or symbol name (looked up in nexus.db)
 * @param projectRoot - Absolute path to project root
 * @returns Code reason trace (never throws — empty chain on error)
 */
export async function reasonWhySymbol(
  symbolId: string,
  projectRoot: string,
): Promise<CodeReasonTrace> {
  const emptyResult: CodeReasonTrace = {
    symbolId,
    narrative: `No reasoning context found for symbol '${symbolId}'.`,
    chain: [],
  };

  try {
    await getBrainDb(projectRoot);
    const brainNative = getBrainNativeDb();
    if (!brainNative) return emptyResult;

    // Edge types that connect brain nodes to code symbols
    const codeEdgeTypes = [
      EDGE_TYPES.CODE_REFERENCE,
      EDGE_TYPES.DOCUMENTS,
      EDGE_TYPES.APPLIES_TO,
      EDGE_TYPES.MENTIONS,
    ] as const;

    const placeholders = codeEdgeTypes.map(() => '?').join(', ');

    // 1. Find brain nodes that reference this symbol (reverse edges)
    const reverseEdges = typedAll<RawBrainEdge>(
      brainNative.prepare(
        `SELECT from_id, to_id, edge_type, weight
         FROM brain_page_edges
         WHERE to_id = ? AND edge_type IN (${placeholders})
         LIMIT 30`,
      ),
      symbolId,
      ...codeEdgeTypes,
    );

    if (reverseEdges.length === 0) {
      return emptyResult;
    }

    const chain: ReasonTraceStep[] = [];
    const visitedBrainIds = new Set<string>();
    const decisionTaskIds: string[] = [];

    // 2. Walk each brain node that references this symbol
    for (const edge of reverseEdges) {
      const brainNodeId = edge.from_id;
      if (visitedBrainIds.has(brainNodeId)) continue;
      visitedBrainIds.add(brainNodeId);

      const brainNode = typedGet<RawBrainNode>(
        brainNative.prepare(
          `SELECT id, node_type, label, quality_score
           FROM brain_page_nodes WHERE id = ? LIMIT 1`,
        ),
        brainNodeId,
      );
      if (!brainNode) continue;

      if (brainNode.node_type === 'decision') {
        // Fetch decision details including context_task_id
        const decId = brainNodeId.replace(/^decision:/, '');
        const decRow = typedGet<RawDecisionRow>(
          brainNative.prepare(
            `SELECT id, decision, rationale, context_task_id
             FROM brain_decisions WHERE id = ? LIMIT 1`,
          ),
          decId,
        );

        const refs: string[] = [];
        if (decRow?.context_task_id) {
          decisionTaskIds.push(decRow.context_task_id);
          refs.push(decRow.context_task_id);
        }

        chain.push({
          type: 'decision',
          id: brainNodeId,
          title: decRow?.decision ?? brainNode.label,
          refs,
        });
      } else if (brainNode.node_type === 'learning') {
        const learnId = brainNodeId.replace(/^learning:/, '');
        const learnRow = typedGet<RawLearningRow>(
          brainNative.prepare(`SELECT id, insight FROM brain_learnings WHERE id = ? LIMIT 1`),
          learnId,
        );
        chain.push({
          type: 'observation',
          id: brainNodeId,
          title: learnRow?.insight ?? brainNode.label,
          refs: [],
        });
      } else {
        chain.push({
          type: 'observation',
          id: brainNodeId,
          title: brainNode.label,
          refs: [],
        });
      }
    }

    // 3. Walk context tasks from decisions
    const uniqueTaskIds = [...new Set(decisionTaskIds)];
    for (const taskId of uniqueTaskIds.slice(0, 5)) {
      // Get task title from brain_memory_links or just use the ID
      const taskLabel = await getTaskTitleFromBrain(brainNative, taskId);

      // Find symbols this task also touches via task_touches_symbol
      const touchedSymbols = typedAll<{ to_id: string }>(
        brainNative.prepare(
          `SELECT to_id FROM brain_page_edges
           WHERE from_id = ? AND edge_type = ?
           LIMIT 10`,
        ),
        `task:${taskId}`,
        EDGE_TYPES.TASK_TOUCHES_SYMBOL,
      );

      chain.push({
        type: 'task',
        id: taskId,
        title: taskLabel ?? taskId,
        refs: touchedSymbols.map((s) => s.to_id),
      });
    }

    if (chain.length === 0) return emptyResult;

    // 4. Build narrative
    const decisionSteps = chain.filter((s) => s.type === 'decision');
    const taskSteps = chain.filter((s) => s.type === 'task');
    const observationSteps = chain.filter((s) => s.type === 'observation');

    let narrative = `Symbol '${symbolId}' has ${chain.length} context entries in BRAIN.`;

    if (decisionSteps.length > 0) {
      const firstDecision = decisionSteps[0]!;
      narrative += ` A key decision was: "${firstDecision.title.slice(0, 100)}"`;
      if (taskSteps.length > 0) {
        narrative += ` (from task ${taskSteps[0]!.id})`;
      }
      narrative += '.';
    }

    if (observationSteps.length > 0) {
      narrative += ` There ${observationSteps.length === 1 ? 'is' : 'are'} ${observationSteps.length} related observation${observationSteps.length === 1 ? '' : 's'}.`;
    }

    return {
      symbolId,
      narrative,
      chain,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[brain-reasoning] reasonWhySymbol failed:', msg);
    return emptyResult;
  }
}

/**
 * Look up a task title from brain_memory_links or return null.
 */
async function getTaskTitleFromBrain(
  brainNative: NonNullable<ReturnType<typeof getBrainNativeDb>>,
  taskId: string,
): Promise<string | null> {
  try {
    // Try to find any decision linked to this task and use that as context
    const link = typedGet<{ memory_id: string; memory_type: string }>(
      brainNative.prepare(
        `SELECT memory_id, memory_type FROM brain_memory_links WHERE task_id = ? LIMIT 1`,
      ),
      taskId,
    );
    if (link) {
      return `Task ${taskId} (${link.memory_type} context)`;
    }
  } catch {
    // ignore
  }
  return null;
}

// ============================================================================
// reason.similar — Find semantically similar entries
// ============================================================================

export interface SimilarEntry {
  id: string;
  distance: number;
  type: string;
  title: string;
  text: string;
}

/**
 * Find entries similar to a given brain.db entry.
 *
 * 1. Loads the source entry's text from brain.db.
 * 2. Calls searchSimilar() for vector-based similarity if embeddings exist.
 * 3. Falls back to FTS5 keyword search if no embeddings are available.
 * 4. Filters out the source entry itself.
 *
 * @param entryId - ID of the brain.db entry to find similar entries for
 * @param projectRoot - Project root directory
 * @param limit - Maximum results to return (default 10)
 * @returns Array of similar entries ranked by distance/relevance
 */
export async function reasonSimilar(
  entryId: string,
  projectRoot: string,
  limit?: number,
): Promise<SimilarEntry[]> {
  const maxResults = limit ?? 10;

  // Load the source entry's text — initialize brain.db before accessor use
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const accessor = await getBrainAccessor(projectRoot);

  let sourceText: string | null = null;

  if (entryId.startsWith('D-') || /^D\d/.test(entryId)) {
    const row = await accessor.getDecision(entryId);
    if (row) sourceText = `${row.decision} ${row.rationale}`;
  } else if (entryId.startsWith('P-') || /^P\d/.test(entryId)) {
    const row = await accessor.getPattern(entryId);
    if (row) sourceText = `${row.pattern} ${row.context}`;
  } else if (entryId.startsWith('L-') || /^L\d/.test(entryId)) {
    const row = await accessor.getLearning(entryId);
    if (row) sourceText = `${row.insight} ${row.source}`;
  } else {
    const row = await accessor.getObservation(entryId);
    if (row) sourceText = row.narrative ?? row.title;
  }

  if (!sourceText) return [];

  // Try vector similarity first
  const vecResults = await searchSimilar(sourceText, projectRoot, maxResults + 1);

  if (vecResults.length > 0) {
    return vecResults.filter((r) => r.id !== entryId).slice(0, maxResults);
  }

  // FTS5 fallback: extract key terms and search
  const terms = sourceText
    .split(/\s+/)
    .filter((t) => t.length > 3)
    .slice(0, 5)
    .join(' ');

  if (!terms) return [];

  const ftsResults = await searchBrain(projectRoot, terms, { limit: maxResults + 5 });

  const entries: SimilarEntry[] = [];

  for (const d of ftsResults.decisions) {
    if (d.id === entryId) continue;
    entries.push({
      id: d.id,
      distance: 0,
      type: 'decision',
      title: d.decision,
      text: `${d.decision} — ${d.rationale}`,
    });
  }

  for (const p of ftsResults.patterns) {
    if (p.id === entryId) continue;
    entries.push({
      id: p.id,
      distance: 0,
      type: 'pattern',
      title: p.pattern,
      text: `${p.pattern} — ${p.context}`,
    });
  }

  for (const l of ftsResults.learnings) {
    if (l.id === entryId) continue;
    entries.push({
      id: l.id,
      distance: 0,
      type: 'learning',
      title: l.insight,
      text: `${l.insight} (source: ${l.source})`,
    });
  }

  for (const o of ftsResults.observations) {
    if (o.id === entryId) continue;
    entries.push({
      id: o.id,
      distance: 0,
      type: 'observation',
      title: o.title,
      text: o.narrative ?? o.title,
    });
  }

  return entries.slice(0, maxResults);
}
