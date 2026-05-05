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
import { DecisionValidatorFailedError } from '@cleocode/contracts';
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
  /**
   * Relative or absolute path to the ADR document on disk.
   *
   * @see T1826 Decision Storage Consolidation
   */
  adrPath?: string;
  /**
   * ID of the `brain_decisions` row this decision supersedes.
   *
   * When provided, the referenced row's `supersededBy` is updated and its
   * `confirmationState` is set to `'superseded'`.
   */
  supersedes?: string;
  /**
   * Lifecycle state in the confirmation workflow.
   *
   * Defaults to `'proposed'` for new rows.
   */
  confirmationState?: BrainDecisionRow['confirmationState'];
  /**
   * Who approved / originated this decision.
   *
   * Defaults to `'agent'` for new rows.
   */
  decidedBy?: BrainDecisionRow['decidedBy'];
  /**
   * T992: Internal flag — when true, bypasses the verifyAndStore gate.
   * Set only by storeVerifiedCandidate in extraction-gate.ts to avoid
   * infinite recursion (gate → storeVerifiedCandidate → storeDecision → gate).
   * External callers MUST NOT set this flag.
   */
  _skipGate?: boolean;
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

/** Default confidence threshold for the ADR decision validator. */
const DEFAULT_VALIDATOR_CONFIDENCE_THRESHOLD = 0.7;

/**
 * Result shape returned by {@link validateDecisionConflicts}.
 *
 * @task T1828
 */
export interface DecisionValidationResult {
  /** Near-duplicate or collision entries found (by decision ID). */
  collisions: string[];
  /** Decisions that contradict the candidate (by decision ID). */
  contradictions: string[];
  /** Supersession-graph integrity violations detected. */
  supersession_graph_violations: string[];
  /** Overall validator confidence (0.0–1.0). */
  confidence: number;
}

/**
 * Read the configured confidence threshold for ADR decision validation.
 *
 * Checks `.cleo/config.json` key `decisions.validatorConfidenceThreshold`.
 * Falls back to {@link DEFAULT_VALIDATOR_CONFIDENCE_THRESHOLD} (0.7) when the
 * key is absent or the file is unreadable.
 *
 * @param projectRoot - Absolute project root directory.
 * @returns Configured threshold in [0.0, 1.0].
 *
 * @task T1828
 */
async function resolveValidatorThreshold(projectRoot: string): Promise<number> {
  try {
    const { getRawConfigValue } = await import('../config.js');
    const raw = await getRawConfigValue('decisions.validatorConfidenceThreshold', projectRoot);
    if (typeof raw === 'number' && raw >= 0 && raw <= 1) {
      return raw;
    }
  } catch {
    /* best-effort — fall through to default */
  }
  return DEFAULT_VALIDATOR_CONFIDENCE_THRESHOLD;
}

/**
 * Validate a candidate decision for collision, contradiction, and supersession-
 * graph integrity using the dialectic LLM evaluator.
 *
 * ## Scope
 *
 * Only runs for ADR-typed writes (where `adrPath` is provided on the params).
 * Non-ADR writes skip validation entirely.
 *
 * ## Env skip
 *
 * When `process.env.CLEO_ENV === 'test'`, returns a synthetic passing result
 * (`confidence: 1.0`, empty violation arrays) immediately so that unit test
 * suites that do not want to make real LLM calls are not affected.
 *
 * ## LLM call
 *
 * Uses `evaluateDialectic()` from `dialectic-evaluator.ts` (cold tier,
 * `claude-sonnet-4-6`).  The "user message" describes the candidate decision;
 * the "system response" summarises existing decisions to provide contradiction
 * context.  The LLM is prompted to identify conflicts and assign a confidence
 * score.
 *
 * When no LLM backend is available, the function returns `confidence: 1.0` so
 * that writes are never silently blocked due to infrastructure absence.
 *
 * ## Rejection
 *
 * If `confidence < threshold` (default 0.7, configurable via
 * `decisions.validatorConfidenceThreshold` in `.cleo/config.json`),
 * the caller MUST throw {@link DecisionValidatorFailedError}.
 *
 * @param params        - The store params for the candidate decision.
 * @param existingDecisions - Snapshot of existing decisions for conflict checking.
 * @returns Validation result with conflict lists and overall confidence.
 *
 * @task T1828
 */
export async function validateDecisionConflicts(
  params: Pick<StoreDecisionParams, 'decision' | 'rationale' | 'type' | 'adrPath' | 'supersedes'>,
  existingDecisions: Pick<BrainDecisionRow, 'id' | 'decision' | 'rationale' | 'supersedes'>[],
): Promise<DecisionValidationResult> {
  const PASS: DecisionValidationResult = {
    collisions: [],
    contradictions: [],
    supersession_graph_violations: [],
    confidence: 1.0,
  };

  // Skip in test environment to avoid real LLM calls.
  if (process.env['CLEO_ENV'] === 'test') {
    return PASS;
  }

  // Only validate ADR-typed writes.
  if (!params.adrPath) {
    return PASS;
  }

  const collisions: string[] = [];
  const contradictions: string[] = [];
  const supersessionViolations: string[] = [];

  // --- Pass 1: Detect near-duplicate collisions (deterministic, no LLM) ---
  const candidateLower = (params.decision.trim() + ' ' + params.rationale.trim()).toLowerCase();
  for (const existing of existingDecisions) {
    const existingLower = (
      existing.decision.trim() +
      ' ' +
      existing.rationale.trim()
    ).toLowerCase();
    // Simple Jaccard-approximation via shared 4-gram tokens
    const cTokens = new Set(candidateLower.match(/\b\w{4,}\b/g) ?? []);
    const eTokens = new Set(existingLower.match(/\b\w{4,}\b/g) ?? []);
    const intersection = [...cTokens].filter((t) => eTokens.has(t)).length;
    const union = new Set([...cTokens, ...eTokens]).size;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard >= 0.65) {
      collisions.push(existing.id);
    }
  }

  // --- Pass 2: Detect supersession-graph violations (deterministic) ---
  if (params.supersedes) {
    const target = existingDecisions.find((d) => d.id === params.supersedes);
    if (!target) {
      supersessionViolations.push(`supersedes:${params.supersedes}:not-found`);
    } else if (target.supersedes) {
      // Circular: target already superseded by something else
      supersessionViolations.push(
        `supersedes:${params.supersedes}:already-superseded-by:${target.supersedes}`,
      );
    }
  }

  // --- Pass 3: LLM contradiction check ---
  let llmConfidence = 1.0;
  try {
    const { evaluateDialectic } = await import('./dialectic-evaluator.js');

    // Build a synthetic turn: userMessage = candidate, systemResponse = existing summary
    const existingSummary =
      existingDecisions.length === 0
        ? 'No existing decisions in the database.'
        : existingDecisions
            .slice(0, 20) // cap at 20 to stay within context limits
            .map((d) => `[${d.id}] ${d.decision}: ${d.rationale}`)
            .join('\n');

    const userMessage =
      `Candidate ADR decision for conflict checking:\n` +
      `Type: ${params.type}\n` +
      `Decision: ${params.decision}\n` +
      `Rationale: ${params.rationale}\n` +
      (params.adrPath ? `ADR path: ${params.adrPath}\n` : '') +
      (collisions.length > 0
        ? `\nPossible near-duplicates detected: ${collisions.join(', ')}\n`
        : '');

    const systemResponse =
      `Existing architectural decisions in the system:\n${existingSummary}\n\n` +
      `Task: Identify whether the candidate decision contradicts any existing decisions. ` +
      `Assign a confidence score where 1.0 = no conflicts and 0.0 = severe contradiction.`;

    const insights = await evaluateDialectic({
      userMessage,
      systemResponse,
      activePeerId: 'decision-validator',
      sessionId: `validate:${createHash('sha256').update(params.decision).digest('hex').slice(0, 8)}`,
    });

    // Map dialectic confidence: if any peer insight has a low confidence flag
    // for contradiction, reflect that in the overall score.
    const contradictionInsights = insights.peerInsights.filter(
      (i) =>
        i.key.includes('contradict') || i.key.includes('conflict') || i.key.includes('collision'),
    );

    if (contradictionInsights.length > 0) {
      // Extract referenced decision IDs from insight values (heuristic: IDs look like D\d+)
      for (const insight of contradictionInsights) {
        const ids = insight.value.match(/\bD\d{3,}\b/g) ?? [];
        for (const id of ids) {
          if (!contradictions.includes(id)) {
            contradictions.push(id);
          }
        }
        // Lower confidence proportionally to how many contradiction signals were found
        llmConfidence = Math.min(llmConfidence, insight.confidence);
      }
    }

    // If LLM emitted no contradiction signals, keep confidence at 1.0 minus
    // small penalty for each deterministic collision found.
    if (contradictionInsights.length === 0) {
      llmConfidence = Math.max(0, 1.0 - collisions.length * 0.15);
    }
  } catch {
    // LLM unavailable — treat as passing to avoid blocking writes
    llmConfidence = 1.0;
  }

  // Overall confidence is the product of LLM confidence and supersession penalty.
  const supersessionPenalty = supersessionViolations.length * 0.3;
  const confidence = Math.max(0, llmConfidence - supersessionPenalty);

  return {
    collisions,
    contradictions,
    supersession_graph_violations: supersessionViolations,
    confidence,
  };
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

  // T1828: LLM conflict-validator hook for ADR-typed writes.
  // Runs BEFORE the verifyCandidate gate so bad writes are rejected early.
  // Skipped when: (a) CLEO_ENV=test, (b) no adrPath set (non-ADR write),
  // (c) _skipGate=true (internal bypass from storeVerifiedCandidate).
  if (!params._skipGate && params.adrPath) {
    const accessor = await getBrainAccessor(projectRoot);
    const existing = await accessor.findDecisions({});
    const validationResult = await validateDecisionConflicts(
      {
        decision: params.decision,
        rationale: params.rationale,
        type: params.type,
        adrPath: params.adrPath,
        supersedes: params.supersedes,
      },
      existing.map((d) => ({
        id: d.id,
        decision: d.decision,
        rationale: d.rationale,
        supersedes: d.supersedes,
      })),
    );

    const threshold = await resolveValidatorThreshold(projectRoot);

    if (validationResult.confidence < threshold) {
      const violations: string[] = [
        ...validationResult.collisions.map((id) => `collision:${id}`),
        ...validationResult.contradictions.map((id) => `contradiction:${id}`),
        ...validationResult.supersession_graph_violations,
      ];
      throw new DecisionValidatorFailedError(
        params.decision.trim().slice(0, 120),
        validationResult.confidence,
        violations,
      );
    }
  }

  // T992: Route through verifyCandidate gate unless called internally from
  // storeVerifiedCandidate (which already ran the gate before calling here).
  // Uses verifyCandidate (not verifyAndStore) to avoid double-writes — this
  // function handles its own storage in the code below.
  // Note: decisions use 'trusted:true' so only Check A (hash dedup) applies.
  if (!params._skipGate) {
    const { verifyCandidate } = await import('./extraction-gate.js');
    // Convert BrainDecisionRow confidence enum to numeric for gate
    const numericConf =
      params.confidence === 'high' ? 0.85 : params.confidence === 'medium' ? 0.65 : 0.45;
    const candidateText = (params.decision.trim() + '\n' + params.rationale.trim()).toLowerCase();
    const gateResult = await verifyCandidate(projectRoot, {
      text: candidateText,
      title: params.decision.trim().slice(0, 120),
      memoryType: 'semantic',
      tier: 'medium',
      confidence: numericConf,
      source: 'manual',
      sourceConfidence: 'owner',
      trusted: true,
    });
    if (gateResult.action !== 'stored') {
      // Gate merged or rejected — return existing decision if possible
      const existing = gateResult.id
        ? await (await getBrainAccessor(projectRoot)).getDecision(gateResult.id).catch(() => null)
        : null;
      if (existing) {
        return existing;
      }
      // Fallback: proceed with write so decisions (owner-level trust) are never silently dropped
    }
    // Gate approved — fall through to native storage below (no recursion needed).
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
    // T1826: Decision Storage Consolidation — ADR tracking + governance columns
    adrPath: params.adrPath,
    supersedes: params.supersedes,
    confirmationState: params.confirmationState,
    decidedBy: params.decidedBy,
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
