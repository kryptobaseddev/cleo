/**
 * BRAIN Reasoning — causal trace through task dependency chains.
 *
 * `reasonWhy(taskId)` walks upstream through a task's blocker chain,
 * enriching each node with related brain_decisions. Leaf tasks with
 * no further unresolved blockers are identified as root causes.
 *
 * @task T5390
 * @epic T5149
 */

import { readJsonRequired } from '../../store/json.js';
import { getTaskPath } from '../paths.js';
import { getBrainAccessor } from '../../store/brain-accessor.js';
import { searchSimilar } from './brain-similarity.js';
import { searchBrain } from './brain-search.js';
import { getBrainDb } from '../../store/brain-sqlite.js';
import type { TaskFile } from '../../types/task.js';
import type { BrainDecisionRow } from '../../store/brain-schema.js';

// ============================================================================
// Types
// ============================================================================

export interface BlockerNode {
  taskId: string;
  status: string;
  reason?: string;
  decisions: Array<{ id: string; title: string; rationale?: string }>;
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
export async function reasonWhy(taskId: string, projectRoot: string): Promise<CausalTrace> {
  const taskPath = getTaskPath(projectRoot);
  const data = await readJsonRequired<TaskFile>(taskPath);
  const taskMap = new Map(data.tasks.map(t => [t.id, t]));

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
    const unresolvedDeps = (task.depends ?? []).filter(depId => {
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
      let decisions: Array<{ id: string; title: string; rationale?: string }> = [];
      if (accessor) {
        const relatedDecisions = await findDecisionsForTask(accessor, depId);
        decisions = relatedDecisions.map(d => ({
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
  const blockerIds = new Set(blockers.map(b => b.taskId));
  const rootCauses = blockers
    .filter(b => {
      const task = taskMap.get(b.taskId);
      if (!task?.depends?.length) return true;
      return task.depends.every(depId => {
        const dep = taskMap.get(depId);
        return !dep || completedStatuses.has(dep.status) || !blockerIds.has(depId);
      });
    })
    .map(b => b.taskId);

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

  // Load the source entry's text
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
    return vecResults
      .filter(r => r.id !== entryId)
      .slice(0, maxResults);
  }

  // FTS5 fallback: extract key terms and search
  const terms = sourceText
    .split(/\s+/)
    .filter(t => t.length > 3)
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
