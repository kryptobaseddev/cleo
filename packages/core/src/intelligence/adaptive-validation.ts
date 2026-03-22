/**
 * Adaptive Validation module for the CLEO Intelligence dimension.
 *
 * Extends the prediction layer with:
 *   - Gate-level failure tracking: which verification gates fail most for which task types
 *   - Adaptive focus suggestions: recommend which gates to pay attention to given task attributes
 *   - Confidence scoring: compute and persist a 0-1 confidence score after task verification
 *   - Prediction storage: persist quality predictions back to brain as observations so
 *     subsequent sessions can learn from them
 *
 * All storage goes to existing brain tables (brain_observations, brain_learnings,
 * brain_patterns). No new tables required.
 *
 * @task T035
 * @epic T029
 * @module intelligence
 */

import { randomBytes } from 'node:crypto';
import type { Task, TaskVerification, VerificationGate } from '@cleocode/contracts';
import type { BrainDataAccessor } from '../store/brain-accessor.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { predictValidationOutcome } from './prediction.js';
import type { ValidationPrediction } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Ordered list of all supported verification gates.
 * Order reflects typical RCASD pipeline sequence.
 */
const ALL_GATES: VerificationGate[] = [
  'implemented',
  'testsPassed',
  'qaPassed',
  'cleanupDone',
  'securityPassed',
  'documented',
];

/** Minimum confidence threshold to consider a gate "high-risk" for focus. */
const GATE_RISK_THRESHOLD = 0.3;

// ============================================================================
// Types
// ============================================================================

/**
 * A gate-level focus recommendation produced by adaptive validation.
 */
export interface GateFocusRecommendation {
  /** The verification gate this recommendation applies to. */
  gate: VerificationGate;
  /**
   * Priority level: high gates should be checked first; low gates are lower
   * risk for this task type and can be reviewed last.
   */
  priority: 'high' | 'medium' | 'low';
  /** Human-readable rationale for this priority level. */
  rationale: string;
  /**
   * Estimated pass likelihood for this gate (0-1) based on historical
   * patterns and task metadata. Null when no historical data is available.
   */
  estimatedPassLikelihood: number | null;
}

/**
 * Full adaptive validation suggestion set for a task.
 */
export interface AdaptiveValidationSuggestion {
  /** Task ID this suggestion applies to. */
  taskId: string;
  /** Ordered gate recommendations (highest priority first). */
  gateFocus: GateFocusRecommendation[];
  /** Overall confidence that the task will pass all required gates. */
  overallConfidence: number;
  /**
   * Actionable tips derived from gate focus analysis.
   * Includes failure-pattern mitigations where available.
   */
  tips: string[];
}

/**
 * Result of scoring and persisting a completed verification round.
 */
export interface VerificationConfidenceScore {
  /** Task ID. */
  taskId: string;
  /**
   * Computed confidence score (0-1).
   *
   * Score derivation:
   *   - Gates passed vs required gates: up to 0.6
   *   - Failure log length (fewer failures = higher confidence): up to 0.2
   *   - Round number (fewer rounds = higher confidence): up to 0.2
   */
  confidenceScore: number;
  /** Whether the overall verification passed. */
  passed: boolean;
  /** IDs of gates that passed. */
  gatesPassed: VerificationGate[];
  /** IDs of gates that failed or are missing. */
  gatesFailed: VerificationGate[];
  /** Brain observation ID if the score was persisted (may be undefined on dry run). */
  observationId?: string;
  /** Brain learning ID if a learning was extracted (may be undefined). */
  learningId?: string;
}

/**
 * Parameters for storing a quality prediction as a brain observation.
 */
export interface StorePredictionOptions {
  /** Whether to skip persisting to brain (useful in tests). Default: false. */
  dryRun?: boolean;
  /** Session ID to attach to the observation (optional). */
  sessionId?: string;
  /** Project identifier to attach to the observation (optional). */
  project?: string;
}

// ============================================================================
// Adaptive Validation Gate Focus
// ============================================================================

/**
 * Suggest which verification gates to focus on for a task, ordered by risk.
 *
 * Uses:
 * - Historical failure patterns from brain_patterns filtered by task type/labels
 * - Task characteristics (size, type, labels, priority) to weight gate risk
 * - Existing gate state from task.verification to skip already-passed gates
 *
 * @param taskId - The task to analyze
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @returns Ordered gate focus recommendations and overall confidence
 */
export async function suggestGateFocus(
  taskId: string,
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
): Promise<AdaptiveValidationSuggestion> {
  const task = await taskAccessor.loadSingleTask(taskId);
  if (!task) {
    return {
      taskId,
      gateFocus: [],
      overallConfidence: 0,
      tips: [`Task ${taskId} not found — cannot generate gate focus suggestions.`],
    };
  }

  const gateFocus = await computeGateFocusRecommendations(task, brainAccessor);
  const overallConfidence = computeOverallConfidenceFromGates(gateFocus);
  const tips = buildAdaptiveTips(task, gateFocus);

  return {
    taskId,
    gateFocus,
    overallConfidence: Math.round(overallConfidence * 1000) / 1000,
    tips,
  };
}

// ============================================================================
// Confidence Scoring for Verification Gates
// ============================================================================

/**
 * Compute a confidence score for a completed verification round and persist
 * it to brain.db as an observation and learning.
 *
 * Called after `cleo verify` gates are set. Stores:
 * - A `brain_observations` row (type: 'discovery') with score, gates, task metadata
 * - A `brain_learnings` row if the result is notable (high pass or high failure)
 *
 * @param taskId - The task that was verified
 * @param verification - The task's current verification state
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @param options - Persistence and session options
 * @returns Computed confidence score with optional persisted observation/learning IDs
 */
export async function scoreVerificationConfidence(
  taskId: string,
  verification: TaskVerification,
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
  options: StorePredictionOptions = {},
): Promise<VerificationConfidenceScore> {
  const task = await taskAccessor.loadSingleTask(taskId);

  const gatesPassed: VerificationGate[] = [];
  const gatesFailed: VerificationGate[] = [];

  for (const gate of ALL_GATES) {
    const gateValue = verification.gates[gate];
    if (gateValue === true) {
      gatesPassed.push(gate);
    } else if (gateValue === false || gateValue === null) {
      gatesFailed.push(gate);
    }
    // undefined gates are ignored (not required)
  }

  const confidenceScore = computeVerificationConfidence(verification, gatesPassed, gatesFailed);

  if (options.dryRun) {
    return {
      taskId,
      confidenceScore,
      passed: verification.passed,
      gatesPassed,
      gatesFailed,
    };
  }

  // Persist observation to brain
  const observationId = await persistVerificationObservation(
    taskId,
    task,
    verification,
    confidenceScore,
    gatesPassed,
    gatesFailed,
    brainAccessor,
    options,
  );

  // Extract learning if notable
  const learningId = await maybeExtractLearning(
    taskId,
    task,
    verification,
    confidenceScore,
    gatesPassed,
    gatesFailed,
    brainAccessor,
  );

  return {
    taskId,
    confidenceScore,
    passed: verification.passed,
    gatesPassed,
    gatesFailed,
    observationId,
    learningId,
  };
}

// ============================================================================
// Quality Prediction Storage
// ============================================================================

/**
 * Store a validation prediction as a brain observation for future learning.
 *
 * Saves the full `ValidationPrediction` to brain_observations so that
 * accumulated predictions can later be analyzed to improve gate pass rates.
 *
 * @param prediction - The prediction to persist
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @param options - Dry-run and session options
 * @returns The created brain observation ID (or undefined on dry run)
 */
export async function storePrediction(
  prediction: ValidationPrediction,
  brainAccessor: BrainDataAccessor,
  options: StorePredictionOptions = {},
): Promise<string | undefined> {
  if (options.dryRun) return undefined;

  const id = `O-pred-${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const facts: string[] = [
    `taskId: ${prediction.taskId}`,
    `stage: ${prediction.stage}`,
    `passLikelihood: ${prediction.passLikelihood}`,
    `blockers: ${prediction.blockers.length}`,
    `suggestions: ${prediction.suggestions.length}`,
  ];

  await brainAccessor.addObservation({
    id,
    type: 'discovery',
    title: `Quality prediction: ${prediction.taskId} at ${prediction.stage} stage`,
    subtitle: `Pass likelihood: ${Math.round(prediction.passLikelihood * 100)}%`,
    narrative:
      prediction.blockers.length > 0
        ? `Blockers: ${prediction.blockers.join('; ')}`
        : 'No blockers identified.',
    factsJson: JSON.stringify(facts),
    conceptsJson: JSON.stringify(['quality-prediction', 'adaptive-validation', prediction.stage]),
    project: options.project ?? null,
    filesReadJson: null,
    filesModifiedJson: null,
    sourceSessionId: options.sessionId ?? null,
    sourceType: 'agent',
    contentHash: null,
    discoveryTokens: null,
    createdAt: now,
    updatedAt: null,
  });

  return id;
}

/**
 * Compute a prediction for a task and immediately persist it to brain.
 *
 * Convenience wrapper combining `predictValidationOutcome` and `storePrediction`.
 *
 * @param taskId - The task to predict and record
 * @param stage - The lifecycle stage being predicted
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @param options - Dry-run and session options
 * @returns The prediction with optional stored observation ID
 */
export async function predictAndStore(
  taskId: string,
  stage: string,
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
  options: StorePredictionOptions = {},
): Promise<ValidationPrediction & { observationId?: string }> {
  const prediction = await predictValidationOutcome(taskId, stage, taskAccessor, brainAccessor);
  const observationId = await storePrediction(prediction, brainAccessor, options);
  return { ...prediction, observationId };
}

// ============================================================================
// Internal: Gate Focus Computation
// ============================================================================

async function computeGateFocusRecommendations(
  task: Task,
  brainAccessor: BrainDataAccessor,
): Promise<GateFocusRecommendation[]> {
  const existingGates = task.verification?.gates ?? {};
  const taskLabels = new Set((task.labels ?? []).map((l) => l.toLowerCase()));
  const taskTitle = task.title.toLowerCase();

  // Load failure patterns to detect which gates commonly fail for similar tasks
  const failurePatterns = await brainAccessor.findPatterns({ type: 'failure', limit: 100 });
  const blockerPatterns = await brainAccessor.findPatterns({ type: 'blocker', limit: 50 });
  const allNegativePatterns = [...failurePatterns, ...blockerPatterns];

  const recommendations: GateFocusRecommendation[] = [];

  for (const gate of ALL_GATES) {
    // Skip gates already passed
    if (existingGates[gate] === true) continue;

    const gateRisk = computeGateRisk(gate, task, taskLabels, taskTitle, allNegativePatterns);

    const rationale = buildGateRationale(gate, gateRisk, task, existingGates[gate]);
    const mitigation = findGateMitigation(gate, taskLabels, taskTitle, allNegativePatterns);

    const priority: GateFocusRecommendation['priority'] =
      gateRisk >= 0.6 ? 'high' : gateRisk >= GATE_RISK_THRESHOLD ? 'medium' : 'low';

    recommendations.push({
      gate,
      priority,
      rationale: mitigation ? `${rationale} Suggestion: ${mitigation}` : rationale,
      estimatedPassLikelihood: gateRisk > 0 ? Math.round((1 - gateRisk) * 1000) / 1000 : null,
    });
  }

  // Sort: high first, then medium, then low; within same priority sort by risk desc
  const priorityOrder: Record<GateFocusRecommendation['priority'], number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  recommendations.sort(
    (a, b) =>
      priorityOrder[a.priority] - priorityOrder[b.priority] ||
      (a.estimatedPassLikelihood ?? 0.5) - (b.estimatedPassLikelihood ?? 0.5),
  );

  return recommendations;
}

function computeGateRisk(
  gate: VerificationGate,
  task: Task,
  taskLabels: Set<string>,
  taskTitle: string,
  negativePatterns: Array<{ pattern: string; context: string; successRate: number | null }>,
): number {
  let risk = 0;

  // Base risk by gate type + task attributes
  risk += getBaseGateRisk(gate, task);

  // Historical pattern risk: patterns that mention this gate and this task
  let matchCount = 0;
  let totalFailureRate = 0;

  for (const p of negativePatterns) {
    const patternText = p.pattern.toLowerCase();
    const contextText = p.context.toLowerCase();
    const gateText = gate.toLowerCase();

    const gateMatch = patternText.includes(gateText) || contextText.includes(gateText);
    const labelMatch =
      taskLabels.size > 0 &&
      [...taskLabels].some((l) => patternText.includes(l) || contextText.includes(l));
    const titleMatch = taskTitle
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => patternText.includes(w) || contextText.includes(w));

    if (gateMatch && (labelMatch || titleMatch)) {
      matchCount++;
      const failureRate = p.successRate !== null ? 1 - p.successRate : 0.5;
      totalFailureRate += failureRate;
    }
  }

  if (matchCount > 0) {
    const avgHistoricalFailureRate = totalFailureRate / matchCount;
    // Blend 30% base risk, 70% historical
    risk = risk * 0.3 + avgHistoricalFailureRate * 0.7;
  }

  return Math.min(Math.max(risk, 0), 1);
}

/**
 * Intrinsic risk per gate based on task characteristics alone (no history).
 */
function getBaseGateRisk(gate: VerificationGate, task: Task): number {
  const size = task.size ?? 'medium';
  const sizeFactor = size === 'large' ? 0.3 : size === 'medium' ? 0.2 : 0.1;
  const hasAcceptance = (task.acceptance?.length ?? 0) > 0;
  const isHighPriority = task.priority === 'critical' || task.priority === 'high';

  switch (gate) {
    case 'implemented':
      // Low intrinsic risk if task is active/done
      return task.status === 'active' ? 0.2 : 0.15;

    case 'testsPassed':
      // Higher risk for large tasks or tasks without acceptance criteria
      return sizeFactor + (hasAcceptance ? 0 : 0.1) + (isHighPriority ? 0.1 : 0);

    case 'qaPassed':
      // Higher risk for large/complex tasks
      return sizeFactor + (isHighPriority ? 0.15 : 0.05);

    case 'cleanupDone':
      // Moderate risk — often overlooked
      return 0.15 + sizeFactor;

    case 'securityPassed': // Security-related labels increase risk significantly
      {
        const securityLabels = ['auth', 'security', 'crypto', 'permission', 'access'];
        const matchingLabels = (task.labels ?? []).filter((l) =>
          securityLabels.includes(l.toLowerCase()),
        );
        // Each security-related label increases risk; 2+ labels → high risk (>= 0.6)
        if (matchingLabels.length >= 2) return 0.65;
        if (matchingLabels.length === 1) return 0.45;
        return 0.1;
      }

    case 'documented':
      // Large tasks and those with many acceptance criteria need more docs
      return sizeFactor + ((task.acceptance?.length ?? 0) >= 3 ? 0.1 : 0);

    default:
      return 0.2;
  }
}

function buildGateRationale(
  gate: VerificationGate,
  risk: number,
  task: Task,
  currentValue: boolean | null | undefined,
): string {
  if (currentValue === false) {
    return `Gate "${gate}" previously failed. High priority to address before retry.`;
  }

  const riskPercent = Math.round(risk * 100);

  switch (gate) {
    case 'implemented':
      return `Verify core implementation is complete (estimated ${riskPercent}% failure risk).`;
    case 'testsPassed':
      return `Confirm all tests pass; ${
        (task.size ?? 'medium') === 'large' ? 'large task increases test surface area. ' : ''
      }Estimated ${riskPercent}% failure risk.`;
    case 'qaPassed':
      return `QA review required${
        task.priority === 'critical' ? ' — critical priority task needs thorough QA' : ''
      }. Estimated ${riskPercent}% failure risk.`;
    case 'cleanupDone':
      return `Ensure code cleanup is complete (dead code, lint, formatting). Estimated ${riskPercent}% failure risk.`;
    case 'securityPassed':
      return `Security review${
        (task.labels ?? []).some((l) => ['auth', 'security'].includes(l.toLowerCase()))
          ? ' — security-related labels detected; review is high priority'
          : ''
      }. Estimated ${riskPercent}% failure risk.`;
    case 'documented':
      return `Ensure documentation is updated. Estimated ${riskPercent}% failure risk.`;
    default:
      return `Gate "${gate}" check required. Estimated ${riskPercent}% failure risk.`;
  }
}

function findGateMitigation(
  gate: VerificationGate,
  taskLabels: Set<string>,
  taskTitle: string,
  negativePatterns: Array<{
    pattern: string;
    context: string;
    mitigation: string | null;
  }>,
): string | null {
  for (const p of negativePatterns) {
    if (!p.mitigation) continue;

    const patternText = p.pattern.toLowerCase();
    const contextText = p.context.toLowerCase();
    const gateText = gate.toLowerCase();

    const gateMatch = patternText.includes(gateText) || contextText.includes(gateText);
    const labelMatch =
      taskLabels.size > 0 &&
      [...taskLabels].some((l) => patternText.includes(l) || contextText.includes(l));
    const titleMatch = taskTitle
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => patternText.includes(w));

    if (gateMatch && (labelMatch || titleMatch)) {
      return p.mitigation;
    }
  }
  return null;
}

function computeOverallConfidenceFromGates(recommendations: GateFocusRecommendation[]): number {
  if (recommendations.length === 0) return 1.0;

  // Weighted average: high-priority gates drag confidence down more
  const weights: Record<GateFocusRecommendation['priority'], number> = {
    high: 3,
    medium: 2,
    low: 1,
  };

  let totalWeight = 0;
  let weightedLikelihood = 0;

  for (const rec of recommendations) {
    const w = weights[rec.priority];
    const likelihood = rec.estimatedPassLikelihood ?? 0.5;
    totalWeight += w;
    weightedLikelihood += likelihood * w;
  }

  return totalWeight > 0 ? weightedLikelihood / totalWeight : 0.5;
}

function buildAdaptiveTips(task: Task, recommendations: GateFocusRecommendation[]): string[] {
  const tips: string[] = [];

  const highPriority = recommendations.filter((r) => r.priority === 'high');
  if (highPriority.length > 0) {
    tips.push(`Focus first on high-risk gates: ${highPriority.map((r) => r.gate).join(', ')}.`);
  }

  if ((task.acceptance?.length ?? 0) === 0) {
    tips.push('Add acceptance criteria to improve gate prediction accuracy.');
  }

  if ((task.labels?.length ?? 0) === 0) {
    tips.push('Adding labels will improve historical pattern matching for future predictions.');
  }

  const alreadyFailed = recommendations.filter((r) => r.rationale.includes('previously failed'));
  if (alreadyFailed.length > 0) {
    tips.push(
      `${alreadyFailed.length} gate(s) failed in a previous round — address these before re-running verification.`,
    );
  }

  return tips;
}

// ============================================================================
// Internal: Confidence Score Computation
// ============================================================================

function computeVerificationConfidence(
  verification: TaskVerification,
  gatesPassed: VerificationGate[],
  gatesFailed: VerificationGate[],
): number {
  // Component 1: Gates passed ratio (up to 0.6)
  const totalGatesTracked = gatesPassed.length + gatesFailed.length;
  const gateRatio = totalGatesTracked > 0 ? gatesPassed.length / totalGatesTracked : 0.5;
  const gateScore = gateRatio * 0.6;

  // Component 2: Failure log penalty (up to 0.2; fewer failures = higher score)
  const failureCount = verification.failureLog?.length ?? 0;
  // Score decreases 0.04 per logged failure, capped at 0.2 deduction
  const failurePenalty = Math.min(failureCount * 0.04, 0.2);
  const failureScore = 0.2 - failurePenalty;

  // Component 3: Round penalty (up to 0.2; fewer rounds = higher score)
  const round = verification.round ?? 1;
  // Round 1 = full 0.2; each extra round deducts 0.05
  const roundPenalty = Math.min((round - 1) * 0.05, 0.2);
  const roundScore = 0.2 - roundPenalty;

  const total = gateScore + failureScore + roundScore;
  return Math.round(Math.min(Math.max(total, 0), 1) * 1000) / 1000;
}

// ============================================================================
// Internal: Brain Persistence Helpers
// ============================================================================

async function persistVerificationObservation(
  taskId: string,
  task: Task | null,
  verification: TaskVerification,
  confidenceScore: number,
  gatesPassed: VerificationGate[],
  gatesFailed: VerificationGate[],
  brainAccessor: BrainDataAccessor,
  options: StorePredictionOptions,
): Promise<string> {
  const id = `O-vconf-${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const facts: string[] = [
    `taskId: ${taskId}`,
    `confidenceScore: ${confidenceScore}`,
    `passed: ${verification.passed}`,
    `round: ${verification.round}`,
    `gatesPassed: ${gatesPassed.join(', ') || 'none'}`,
    `gatesFailed: ${gatesFailed.join(', ') || 'none'}`,
    `failureLogEntries: ${verification.failureLog?.length ?? 0}`,
  ];

  if (task) {
    facts.push(`taskSize: ${task.size ?? 'unspecified'}`);
    facts.push(`taskPriority: ${task.priority}`);
    if (task.labels?.length) {
      facts.push(`labels: ${task.labels.join(', ')}`);
    }
  }

  const title = verification.passed
    ? `Verification passed: ${taskId} (confidence: ${Math.round(confidenceScore * 100)}%)`
    : `Verification failed: ${taskId} (confidence: ${Math.round(confidenceScore * 100)}%)`;

  await brainAccessor.addObservation({
    id,
    type: 'discovery',
    title,
    subtitle: `Round ${verification.round} — gates: ${gatesPassed.length} passed, ${gatesFailed.length} failed`,
    narrative:
      gatesFailed.length > 0
        ? `Failed gates: ${gatesFailed.join(', ')}. Consider addressing these before next round.`
        : 'All tracked gates passed.',
    factsJson: JSON.stringify(facts),
    conceptsJson: JSON.stringify([
      'verification',
      'confidence-score',
      'gate-tracking',
      verification.passed ? 'pass' : 'fail',
    ]),
    project: options.project ?? null,
    filesReadJson: null,
    filesModifiedJson: null,
    sourceSessionId: options.sessionId ?? null,
    sourceType: 'agent',
    contentHash: null,
    discoveryTokens: null,
    createdAt: now,
    updatedAt: null,
  });

  return id;
}

async function maybeExtractLearning(
  taskId: string,
  task: Task | null,
  verification: TaskVerification,
  confidenceScore: number,
  gatesPassed: VerificationGate[],
  gatesFailed: VerificationGate[],
  brainAccessor: BrainDataAccessor,
): Promise<string | undefined> {
  // Only extract a learning when the result is notable:
  // - High confidence pass (>= 0.8) on first round: positive learning
  // - Low confidence or multiple failures: negative learning for future avoidance
  const isNotable =
    (verification.passed && confidenceScore >= 0.8 && verification.round === 1) ||
    (!verification.passed && gatesFailed.length >= 2) ||
    (!verification.passed && (verification.failureLog?.length ?? 0) >= 3);

  if (!isNotable) return undefined;

  const id = `L-vconf-${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  const taskLabels = task?.labels ?? [];
  const taskSize = task?.size ?? 'medium';
  const taskType = task?.type ?? 'task';

  let insight: string;
  let actionable: boolean;
  let confidence: number;

  if (verification.passed && confidenceScore >= 0.8) {
    insight = `High-confidence verification pass for ${taskSize} ${taskType} task${
      taskLabels.length ? ` with labels [${taskLabels.join(', ')}]` : ''
    }. Pattern: ${gatesPassed.join(', ')} all passed on round ${verification.round}.`;
    actionable = false;
    confidence = confidenceScore;
  } else {
    insight = `Verification failure pattern: ${gatesFailed.join(', ')} failed${
      taskLabels.length ? ` for tasks with labels [${taskLabels.join(', ')}]` : ''
    }. Failures logged: ${verification.failureLog?.length ?? 0}. Address these gates early.`;
    actionable = true;
    confidence = Math.max(0.5, 1 - confidenceScore);
  }

  await brainAccessor.addLearning({
    id,
    insight,
    source: `verification-confidence:${taskId}`,
    confidence,
    actionable,
    application: actionable
      ? `Focus on ${gatesFailed.join(', ')} gates for similar ${taskSize} tasks`
      : null,
    applicableTypesJson: JSON.stringify([taskType]),
    createdAt: now,
    updatedAt: null,
  });

  return id;
}
