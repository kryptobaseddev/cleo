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

import { getBrainAccessor } from '../../store/brain-accessor.js';
import { getBrainDb } from '../../store/brain-sqlite.js';
import { brainDecisions } from '../../store/brain-schema.js';
import type {
  BrainDecisionRow,
  NewBrainDecisionRow,
} from '../../store/brain-schema.js';
import { desc } from 'drizzle-orm';

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
  if (isNaN(num)) {
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
  if (!params.decision || !params.decision.trim()) {
    throw new Error('Decision text is required');
  }
  if (!params.rationale || !params.rationale.trim()) {
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
    return updated!;
  }

  // Create new decision with sequential ID
  const id = await nextDecisionId(projectRoot);
  const row: NewBrainDecisionRow = {
    id,
    type: params.type,
    decision: params.decision.trim(),
    rationale: params.rationale.trim(),
    confidence: params.confidence,
    outcome: params.outcome,
    alternativesJson: params.alternatives ? JSON.stringify(params.alternatives) : undefined,
    contextEpicId: params.contextEpicId,
    contextTaskId: params.contextTaskId,
    contextPhase: params.contextPhase,
  };

  return accessor.addDecision(row);
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
      (d) =>
        d.decision.toLowerCase().includes(q) ||
        d.rationale.toLowerCase().includes(q),
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
