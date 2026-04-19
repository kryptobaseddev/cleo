/**
 * Decision Memory module for CLEO BRAIN.
 * Uses brain.db via BrainDataAccessor for persistent storage.
 *
 * Provides functions to store, recall, search, and update decisions
 * with sequential ID generation (D001, D002, ...).
 *
 * @task T5155
 * @epic T5149
 */

import { createHash } from 'node:crypto';
import { taskExistsInTasksDb } from '../store/cross-db-cleanup.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainDecisionRow, NewBrainDecisionRow } from '../store/memory-schema.js';
import { getDb } from '../store/sqlite.js';
import { autoCrossLinkDecision } from './decision-cross-link.js';
import { addGraphEdge, upsertGraphNode } from './graph-auto-populate.js';
import { computeDecisionQuality } from './quality-scoring.js';
import { detectSupersession, supersedeMemory } from './temporal-supersession.js';

/** Parameters for storing a new decision. */
export interface StoreDecisionParams {
  type: BrainDecisionRow['type'];
  decision: string;
  rationale: string;
  confidence: BrainDecisionRow['confidence'];
  outcome?: BrainDecisionRow['outcome'];
  alternatives?: string[];
  contextEpicId?: string;
  contextTaskId?: string;
  contextPhase?: string;
}

/** Parameters for searching decisions. */
export interface SearchDecisionParams {
  type?: BrainDecisionRow['type'];
  confidence?: BrainDecisionRow['confidence'];
  outcome?: BrainDecisionRow['outcome'];
  query?: string;
  limit?: number;
}

/** Parameters for listing decisions. */
export interface ListDecisionParams {
  limit?: number;
  offset?: number;
}

/**
 * Generate the next sequential decision ID (D001, D002, ...).
 * Reads the highest existing ID from brain_decisions to determine next.
 */
async function nextDecisionId(projectRoot: string): Promise<string> {
  const { getBrainDb } = await import('../store/memory-sqlite.js');
  const { brainDecisions } = await import('../store/memory-schema.js');
  const { desc } = await import('drizzle-orm');
  const db = await getBrainDb(projectRoot);
  const rows = await db
    .select({ id: brainDecisions.id })
    .from(brainDecisions)
    .orderBy(desc(brainDecisions.id))
    .limit(1);

  if (rows.length === 0) {
    return 'D001';
  }

  const lastId = rows[0].id;
  const num = parseInt(lastId.slice(1), 10);
  if (Number.isNaN(num)) {
    return 'D001';
  }
  return `D${String(num + 1).padStart(3, '0')}`;
}

/**
 * Store a new decision or update an existing one if a duplicate is found.
 * Duplicate detection: same decision text (case-insensitive).
 *
 * @task T5155
 */
export async function storeDecision(
  projectRoot: string,
  params: StoreDecisionParams,
): Promise<BrainDecisionRow> {
  if (!params.decision?.trim()) {
    throw new Error('Decision text is required');
  }
  if (!params.rationale?.trim()) {
    throw new Error('Rationale is required');
  }

  const accessor = await getBrainAccessor(projectRoot);

  // Check for duplicate (same decision text, case-insensitive)
  const existing = await accessor.findDecisions({ type: params.type });
  const duplicate = existing.find(
    (d) => d.decision.toLowerCase() === params.decision.toLowerCase(),
  );

  if (duplicate) {
    // Update the existing decision
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    await accessor.updateDecision(duplicate.id, {
      rationale: params.rationale.trim(),
      confidence: params.confidence,
      outcome: params.outcome ?? duplicate.outcome,
      alternativesJson: params.alternatives
        ? JSON.stringify(params.alternatives)
        : duplicate.alternativesJson,
      updatedAt: now,
    });
    const updated = await accessor.getDecision(duplicate.id);

    // Refresh the graph node for the updated decision (best-effort).
    const updatedQuality = computeDecisionQuality({
      confidence: params.confidence,
      rationale: params.rationale.trim(),
      contextTaskId: params.contextTaskId ?? null,
    });
    upsertGraphNode(
      projectRoot,
      `decision:${duplicate.id}`,
      'decision',
      params.decision.trim().substring(0, 200),
      updatedQuality,
      params.decision.trim() + params.rationale.trim(),
      { type: params.type, confidence: params.confidence },
    ).catch(() => {
      /* best-effort */
    });

    return updated!;
  }

  // Create new decision with sequential ID
  const id = await nextDecisionId(projectRoot);

  // Write-guard: validate cross-db task references before inserting
  let validEpicId = params.contextEpicId;
  let validTaskId = params.contextTaskId;
  if (validEpicId || validTaskId) {
    const tasksDb = await getDb(projectRoot);
    if (validEpicId && !(await taskExistsInTasksDb(validEpicId, tasksDb))) {
      validEpicId = undefined;
    }
    if (validTaskId && !(await taskExistsInTasksDb(validTaskId, tasksDb))) {
      validTaskId = undefined;
    }
  }

  // T549 Wave 1-A: Tier routing for decisions.
  // Decisions are always medium-term semantic entries — they are intentional acts,
  // always manually entered via cleo memory decision-store or the CLI.
  // sourceConfidence = 'owner' (decisions are owner-stated facts by definition)
  // verified = true (the act of deciding IS verification)
  // memoryTier = 'medium' (decisions skip short-term; may promote to long after 7d+outcome:success)
  // memoryType = 'semantic' (decisions are declarative architectural facts)
  const memoryTier = 'medium' as const;
  const memoryType = 'semantic' as const;
  const sourceConfidence = 'owner' as const;
  const verified = true;

  // Compute quality score from confidence level, rationale richness, task linkage,
  // and T549 source multiplier (owner = 1.0, medium tier = +0.05).
  const qualityScore = computeDecisionQuality({
    confidence: params.confidence,
    rationale: params.rationale.trim(),
    contextTaskId: validTaskId ?? null,
    sourceConfidence,
    memoryTier,
  });

  // T737: compute content hash for hash-dedup gating (mirrors brain_observations pattern)
  const contentHashValue = createHash('sha256')
    .update((params.decision.trim() + '\n' + params.rationale.trim()).toLowerCase())
    .digest('hex')
    .slice(0, 16);

  const row: NewBrainDecisionRow = {
    id,
    type: params.type,
    decision: params.decision.trim(),
    rationale: params.rationale.trim(),
    confidence: params.confidence,
    outcome: params.outcome,
    alternativesJson: params.alternatives ? JSON.stringify(params.alternatives) : undefined,
    contextEpicId: validEpicId,
    contextTaskId: validTaskId,
    contextPhase: params.contextPhase,
    qualityScore,
    // T549 Wave 1-A: tier/type/confidence assigned at write time
    memoryTier,
    memoryType,
    sourceConfidence,
    verified,
    // T737: content hash for dedup gating
    contentHash: contentHashValue,
  };

  const saved = await accessor.addDecision(row);

  // Auto-populate graph node + edges for the new decision (best-effort, T537).
  // All graph writes run fire-and-forget so they never block the return.
  try {
    await upsertGraphNode(
      projectRoot,
      `decision:${saved.id}`,
      'decision',
      saved.decision.substring(0, 200),
      qualityScore,
      saved.decision + saved.rationale,
      { type: saved.type, confidence: saved.confidence },
    );

    // Link decision → task when a task context is present.
    if (validTaskId) {
      await upsertGraphNode(projectRoot, `task:${validTaskId}`, 'task', validTaskId, 1.0, '');
      await addGraphEdge(
        projectRoot,
        `decision:${saved.id}`,
        `task:${validTaskId}`,
        'applies_to',
        1.0,
        'auto:store-decision',
      );
    }

    // Link decision → epic when an epic context is present.
    if (validEpicId) {
      await upsertGraphNode(projectRoot, `epic:${validEpicId}`, 'epic', validEpicId, 1.0, '');
      await addGraphEdge(
        projectRoot,
        `decision:${saved.id}`,
        `epic:${validEpicId}`,
        'applies_to',
        1.0,
        'auto:store-decision',
      );
    }

    // Cross-link decision → referenced file/symbol nodes (T626 phase 1).
    // Fire-and-forget — autoCrossLinkDecision swallows its own errors.
    autoCrossLinkDecision(projectRoot, saved.id, saved.decision, saved.rationale).catch(() => {
      /* best-effort */
    });
  } catch {
    /* Graph population is best-effort — never block the primary return */
  }

  // Detect supersession: check if this new decision supersedes any existing ones.
  // Fire-and-forget — never block the primary return.
  detectSupersession(projectRoot, {
    id: saved.id,
    text: saved.decision + ' ' + saved.rationale,
    createdAt: saved.createdAt ?? new Date().toISOString().replace('T', ' ').slice(0, 19),
  })
    .then((candidates) => {
      for (const candidate of candidates) {
        supersedeMemory(
          projectRoot,
          candidate.existingId,
          saved.id,
          'auto:decision-supersedes — high overlap detected at store time',
        ).catch(() => {
          /* best-effort */
        });
      }
    })
    .catch(() => {
      /* best-effort */
    });

  return saved;
}

/**
 * Recall a specific decision by ID.
 *
 * @task T5155
 */
export async function recallDecision(
  projectRoot: string,
  id: string,
): Promise<BrainDecisionRow | null> {
  const accessor = await getBrainAccessor(projectRoot);
  return accessor.getDecision(id);
}

/**
 * Search decisions by type, confidence, outcome, and/or free-text query.
 * Query searches across decision + rationale fields using LIKE.
 *
 * @task T5155
 */
export async function searchDecisions(
  projectRoot: string,
  params: SearchDecisionParams = {},
): Promise<BrainDecisionRow[]> {
  const accessor = await getBrainAccessor(projectRoot);

  // Use the accessor for structured filters
  let results = await accessor.findDecisions({
    type: params.type,
    confidence: params.confidence,
    outcome: params.outcome ?? undefined,
    limit: params.query ? undefined : params.limit,
  });

  // Apply free-text search on top
  if (params.query) {
    const q = params.query.toLowerCase();
    results = results.filter(
      (d) => d.decision.toLowerCase().includes(q) || d.rationale.toLowerCase().includes(q),
    );
  }

  if (params.limit && params.limit > 0) {
    results = results.slice(0, params.limit);
  }

  return results;
}

/**
 * List decisions with pagination.
 *
 * @task T5155
 */
export async function listDecisions(
  projectRoot: string,
  params: ListDecisionParams = {},
): Promise<{ decisions: BrainDecisionRow[]; total: number }> {
  const accessor = await getBrainAccessor(projectRoot);

  // Get all decisions for total count
  const all = await accessor.findDecisions({});
  const total = all.length;

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 50;

  const decisions = all.slice(offset, offset + limit);

  return { decisions, total };
}

/**
 * Update the outcome of a decision after learning from results.
 *
 * @task T5155
 */
export async function updateDecisionOutcome(
  projectRoot: string,
  id: string,
  outcome: BrainDecisionRow['outcome'],
): Promise<BrainDecisionRow> {
  const accessor = await getBrainAccessor(projectRoot);
  const existing = await accessor.getDecision(id);

  if (!existing) {
    throw new Error(`Decision not found: ${id}`);
  }

  await accessor.updateDecision(id, { outcome });
  const updated = await accessor.getDecision(id);
  return updated!;
}
