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
import {
  CANONICAL_TYPE_TAGS,
  DecisionValidatorFailedError,
  type DialecticInsights,
  TaxonomyError,
  TaxonomyRegistry,
} from '@cleocode/contracts';
import type { DecideOptions } from '../decide/client.js';
import type { DecisionSiteMode } from '../decide/site.js';
import { getLogger } from '../logger.js';
import { taskExistsInTasksDb } from '../store/cross-db-cleanup.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type { BrainDecisionRow, NewBrainDecisionRow } from '../store/schema/memory-schema.js';
import { getDb } from '../store/sqlite.js';
import { autoCrossLinkDecision } from './decision-cross-link.js';
import { addGraphEdge, upsertGraphNode } from './graph-auto-populate.js';
import { computeDecisionQuality } from './quality-scoring.js';

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
  /**
   * Explicitly request the full conflict validation: the generative (T1828)
   * check and rejection below the confidence threshold. Without it an ADR
   * write still runs the System One contradiction site advisorily (T12715):
   * no generative model call, never rejects.
   */
  validateWithLlm?: boolean;
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
 * Options for {@link validateDecisionConflicts}: the System One contradiction
 * check (T12493). Every field is optional; production callers pass only
 * `projectRoot`.
 */
export interface ValidateDecisionConflictsOptions {
  /** Explicit mode; overrides `decide.sites.decisionContradiction` when a provider is configured. */
  mode?: DecisionSiteMode;
  /** Explicit opt-in for the generative (T1828) check; overrides `decide.generativeFallback.decisionContradiction`. */
  llmTier?: boolean;
  /** Provider, connection, budget, cache and audit wiring forwarded to `decide()`. Tests inject a stub here. */
  decide?: DecideOptions;
  /** Project root for config lookup and the audit sink. */
  projectRoot?: string;
  /** Bound on the whole generative path, ms. Default {@link GENERATIVE_CONTRADICTION_TIMEOUT_MS}; tests shorten it. */
  generativeTimeoutMs?: number;
}

/** Word-Jaccard score at which a prior decision counts as a near-duplicate collision. */
const DECISION_COLLISION_THRESHOLD = 0.65;

/**
 * Bound on the WHOLE generative (T1828) contradiction check, in ms: module
 * load, backend resolution (Ollama probes, credential lookup) and the model
 * call. It used to run with no timeout at all. On expiry the validator stops
 * waiting and takes the no-signal result; a backend probe still in flight may
 * finish in the background.
 */
const GENERATIVE_CONTRADICTION_TIMEOUT_MS = 15_000;

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
 * Non-ADR writes skip validation entirely. `storeDecision` runs it on every
 * ADR write (T12715): advisorily with `llmTier: false` by default (the System
 * One site only — shadow unless promoted, off without a provider; never
 * rejects), and in full — generative check and rejection — only when
 * `validateWithLlm: true` is explicitly supplied.
 *
 * ## Env skip
 *
 * When `process.env.CLEO_ENV === 'test'`, returns a synthetic passing result
 * (`confidence: 1.0`, empty violation arrays) immediately so that unit test
 * suites that do not want to make real LLM calls are not affected.
 *
 * ## Contradiction check (T12493)
 *
 * 1. System One: ONE `decide()` request asking how each of the top 3 prior
 *    decisions (by word-Jaccard score) relates to the candidate — a `choice`
 *    of `contradicts | supersedes | refines | unrelated` — bounded at
 *    300 ms end to end. Mode comes from
 *    `decide.sites.decisionContradiction`: `shadow` (the default once a
 *    provider is configured) audits the answers and acts on the heuristic;
 *    `on` acts on them when every answer is confident. Unconfigured → `off`,
 *    no network call. Contradictions come only from typed answers.
 * 2. Generative fallback (T1828): `evaluateDialectic()`, whose prose insights
 *    are scanned for decision ids. It runs only when the decision did not act
 *    and `decide.generativeFallback.decisionContradiction` resolves true. When
 *    the key is unset it is on in every mode except `on` (unconfigured, `off`
 *    and `shadow` keep today's behaviour; only `on` replaces it). The whole
 *    path, backend resolution included, is bounded at 15 s.
 *
 * When neither answers, confidence is the deterministic result
 * (1.0 minus 0.15 per collision), so writes are never silently blocked due to
 * infrastructure absence.
 *
 * ## Rejection
 *
 * If `confidence < threshold` (default 0.7, configurable via
 * `decisions.validatorConfidenceThreshold` in `.cleo/config.json`),
 * the caller MUST throw {@link DecisionValidatorFailedError}.
 *
 * @param params        - The store params for the candidate decision.
 * @param existingDecisions - Snapshot of existing decisions for conflict checking.
 * @param options - System One mode, generative opt-in and `decide()` wiring (T12493).
 * @returns Validation result with conflict lists and overall confidence.
 *
 * @task T1828
 * @task T12493
 */
export async function validateDecisionConflicts(
  params: Pick<StoreDecisionParams, 'decision' | 'rationale' | 'type' | 'adrPath' | 'supersedes'>,
  existingDecisions: Pick<BrainDecisionRow, 'id' | 'decision' | 'rationale' | 'supersedes'>[],
  options: ValidateDecisionConflictsOptions = {},
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
  const scored: Array<{ existing: (typeof existingDecisions)[number]; score: number }> = [];
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
    scored.push({ existing, score: jaccard });
    if (jaccard >= DECISION_COLLISION_THRESHOLD) {
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

  // --- Pass 3: contradiction check — System One, then the generative path ---
  // No model answer → the deterministic result (what the generative path
  // yields when it finds no contradiction signal).
  let llmConfidence = Math.max(0, 1.0 - collisions.length * 0.15);
  let decided = false;
  let llmTier = false;
  try {
    const { resolveDecisionSiteSettings } = await import('../decide/site.js');
    const {
      askContradictionDecision,
      DECISION_CONTRADICTION_LLM_KEY,
      DECISION_CONTRADICTION_MODE_KEY,
      MAX_CONTRADICTION_CANDIDATES,
    } = await import('./decision-contradiction.js');
    const settings = await resolveDecisionSiteSettings({
      modeKey: DECISION_CONTRADICTION_MODE_KEY,
      llmTierKey: DECISION_CONTRADICTION_LLM_KEY,
      mode: options.mode,
      llmTier: options.llmTier,
      // Shadow must be behaviour-neutral: the generative check keeps its
      // pre-T12493 default (on) everywhere except `on`, which replaces it.
      llmTierDefault: (mode) => mode !== 'on',
      wiring: options.decide,
      projectRoot: options.projectRoot,
    });
    llmTier = settings.llmTier;

    const candidates = scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_CONTRADICTION_CANDIDATES)
      .map(({ existing, score }) => ({
        id: existing.id,
        decision: existing.decision,
        rationale: existing.rationale,
        score,
      }));

    if (settings.mode !== 'off' && candidates.length > 0) {
      const verdict = await askContradictionDecision(
        {
          type: params.type,
          decision: params.decision,
          rationale: params.rationale,
          supersedes: params.supersedes,
          supersessionValid: params.supersedes !== undefined && supersessionViolations.length === 0,
        },
        candidates,
        {
          mode: settings.mode,
          heuristicVerdict: collisions.length > 0 ? 'collision' : 'clear',
          collisionThreshold: DECISION_COLLISION_THRESHOLD,
          decide: options.decide,
          projectRoot: options.projectRoot,
        },
      );
      if (settings.mode === 'on' && verdict?.confident) {
        decided = true;
        for (const id of verdict.contradictions) {
          contradictions.push(id);
          llmConfidence = Math.min(
            llmConfidence,
            1 - (verdict.contradictionProbabilities[id] ?? 1),
          );
        }
      }
    }
  } catch {
    // Settings or module load failed — the deterministic result stands.
  }

  // Generative path (T1828): only when the decision did not act.
  if (!decided && llmTier) {
    llmConfidence = 1.0;
    const generativeDeadline = AbortSignal.timeout(
      options.generativeTimeoutMs ?? GENERATIVE_CONTRADICTION_TIMEOUT_MS,
    );
    // Resolves with no insights when the deadline fires, whatever phase the
    // generative path is in (the evaluator honours the signal only in its
    // model call, not in backend resolution).
    const expired = new Promise<DialecticInsights>((resolve) => {
      const empty = (): void => resolve({ globalTraits: [], peerInsights: [] });
      if (generativeDeadline.aborted) empty();
      else generativeDeadline.addEventListener('abort', empty, { once: true });
    });
    try {
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

      const evaluate = async (): Promise<DialecticInsights> => {
        const { evaluateDialectic } = await import('./dialectic-evaluator.js');
        return evaluateDialectic(
          {
            userMessage,
            systemResponse,
            activePeerId: 'decision-validator',
            sessionId: `validate:${createHash('sha256').update(params.decision).digest('hex').slice(0, 8)}`,
          },
          { abortSignal: generativeDeadline },
        );
      };
      const insights = await Promise.race([evaluate(), expired]);

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
 * Maximum number of `INSERT` re-attempts when a sequential decision ID
 * collides with a row written by a concurrent agent (T11552).
 *
 * The bound is deliberately generous: a real collision is resolved on the
 * first retry (the loser re-reads the now-higher `MAX(id)` and advances), and
 * the only way to exhaust this budget is dozens of agents racing the same
 * insert in the same instant — at which point surfacing the error is correct
 * (we never silently drop the decision).
 */
const DECISION_ID_INSERT_MAX_RETRIES = 16;

/**
 * Detect whether an error is a SQLite UNIQUE / PRIMARY-KEY constraint failure
 * on `brain_decisions.id` (T11552).
 *
 * node:sqlite raises a generic `Error` (`code: 'ERR_SQLITE_ERROR'`,
 * `errcode: 1555` = `SQLITE_CONSTRAINT_PRIMARYKEY`) whose message is
 * `"UNIQUE constraint failed: brain_decisions.id"`. We match on both the
 * numeric errcode and the message so the detector survives driver phrasing
 * changes.
 *
 * @param err - The thrown error to classify.
 * @returns `true` when the error is an id-uniqueness collision.
 *
 * @task T11552
 */
function isDecisionIdCollision(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const errcode = (err as { errcode?: number }).errcode;
  // 1555 = SQLITE_CONSTRAINT_PRIMARYKEY, 2067 = SQLITE_CONSTRAINT_UNIQUE.
  if (errcode === 1555 || errcode === 2067) {
    return /brain_decisions\.id/.test(err.message);
  }
  return /UNIQUE constraint failed/i.test(err.message) && /brain_decisions\.id/.test(err.message);
}

/**
 * Normalize decision text for self-identity comparison: trimmed, lower-cased,
 * internal whitespace collapsed.
 */
function normalizeDecisionText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Advisory contradiction check for an ADR write without `validateWithLlm`
 * (T12715): runs the `memory.decision-contradiction` System One site with the
 * generative tier off. In `shadow` (the default once a provider is
 * configured) the site only audits its answers; in `on` a confident
 * contradiction is logged as a warning. Unconfigured → `off`, no network
 * call. Never throws and never blocks the write (registry: "Advisory: a
 * contradiction is reported, never blocks the write").
 *
 * @param projectRoot - Project root for the brain accessor, config and audit.
 * @param params - The decision being stored.
 * @param options - Test wiring forwarded to {@link validateDecisionConflicts}.
 * @returns The contradicting decision ids that were reported (empty when none).
 *
 * @task T12715
 */
export async function adviseDecisionConflicts(
  projectRoot: string,
  params: Pick<StoreDecisionParams, 'decision' | 'rationale' | 'type' | 'adrPath' | 'supersedes'>,
  options: Pick<ValidateDecisionConflictsOptions, 'decide' | 'mode'> = {},
): Promise<string[]> {
  try {
    const accessor = await getBrainAccessor(projectRoot);
    const all = await accessor.findDecisions({});
    // A re-store of identical text takes the duplicate-update path in
    // storeDecision (same type, case-insensitive text match): there is no new
    // decision to check, so skip the billed call entirely.
    const lowered = params.decision.toLowerCase();
    if (
      all.some(
        (d) => (!params.type || d.type === params.type) && d.decision.toLowerCase() === lowered,
      )
    ) {
      return [];
    }
    // Never compare a decision against its own stored copy (Jaccard 1.0 makes
    // it the top candidate, and `on` mode would report it as contradicting
    // itself).
    const self = normalizeDecisionText(params.decision);
    const existing = all.filter((d) => normalizeDecisionText(d.decision) !== self);
    if (existing.length === 0) {
      return [];
    }
    const result = await validateDecisionConflicts(
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
      { ...options, projectRoot, llmTier: false },
    );
    if (result.contradictions.length > 0) {
      getLogger('memory').warn(
        { contradictions: result.contradictions, adrPath: params.adrPath },
        'New decision may contradict stored decisions (System One, advisory)',
      );
    }
    return result.contradictions;
  } catch {
    return [];
  }
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

  // T11186: Taxonomy validation — enforce canonical type tags.
  // Only validates when type is provided and the taxonomy registry is available.
  if (params.type) {
    const registry = TaxonomyRegistry.default;
    const invalid = registry.validate([params.type]);
    if (invalid.length > 0) {
      throw new TaxonomyError(
        `Invalid decision type '${params.type}'. ` +
          `Valid types: ${CANONICAL_TYPE_TAGS.join(', ')}. ` +
          `Use 'cleo taxonomy list --axis type' to see all valid type tags.`,
        invalid,
      );
    }
  }

  // Optional synthesis is separate from recording sourced decisions. An ADR
  // reference supplies evidence; it is not consent to invoke a background
  // generative model. Without the explicit opt-in the System One site still
  // runs, advisorily (T12715): bounded at 300 ms, shadow by default, no
  // generative call, never blocks the write.
  if (params.validateWithLlm !== true && !params._skipGate && params.adrPath) {
    await adviseDecisionConflicts(projectRoot, params);
  }
  if (params.validateWithLlm === true && !params._skipGate && params.adrPath) {
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
      { projectRoot },
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

  // The sequential `id` is allocated atomically inside the INSERT by
  // addDecisionWithSequentialId (T11552); this placeholder is always
  // overridden and never reaches the database.
  const row: NewBrainDecisionRow = {
    id: 'D000', // placeholder — overridden by the atomic in-SQL id allocation
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

  // T11552: Insert with the sequential id allocated ATOMICALLY inside the
  // INSERT statement (see BrainDataAccessor.addDecisionWithSequentialId).
  //
  // The original defect: storeDecision read `MAX(id)+1` in application code
  // (an async fn with `await` boundaries) and only later INSERTed. Two
  // concurrent agents both read e.g. `D042`, both proposed `D043`, and the
  // second INSERT hit the `id` PRIMARY KEY → `UNIQUE constraint failed:
  // brain_decisions.id`, dropping the decision and forcing CLEO_OWNER_OVERRIDE.
  //
  // Computing the id with a `MAX(...)+1` subquery *inside* the INSERT collapses
  // the read and write into one indivisible node:sqlite statement, so no two
  // callers can interleave between them. This is data-preserving (a real
  // INSERT, never `INSERT OR IGNORE`) and correct past `D999 → D1000`.
  //
  // The bounded retry below is defense-in-depth for the genuine cross-PROCESS
  // case (a separate OS process on its own DB connection committing between our
  // statement's plan and execution), which surfaces as the same collision; on
  // a single connection the first attempt always succeeds.
  let saved: BrainDecisionRow | undefined;
  let lastCollision: unknown;
  for (let attempt = 0; attempt < DECISION_ID_INSERT_MAX_RETRIES; attempt++) {
    try {
      saved = await accessor.addDecisionWithSequentialId(row);
      break;
    } catch (err) {
      if (isDecisionIdCollision(err)) {
        // A concurrent writer in another process committed between our read
        // and write — re-run the atomic allocation, which now sees the higher
        // committed MAX(id).
        lastCollision = err;
        continue;
      }
      throw err;
    }
  }
  if (!saved) {
    throw new Error(
      `Failed to allocate a unique brain_decisions.id after ` +
        `${DECISION_ID_INSERT_MAX_RETRIES} attempts under concurrent writes` +
        (lastCollision instanceof Error ? `: ${lastCollision.message}` : ''),
    );
  }

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

  // Similarity identifies reconciliation candidates; it cannot establish authority.
  // Replacement requires an explicit sourced operation from the calling agent.

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
