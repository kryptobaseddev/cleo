/**
 * Quality Prediction module for the CLEO Intelligence dimension.
 *
 * Provides risk scoring for tasks based on complexity, historical patterns,
 * and blocking analysis. Also predicts lifecycle gate validation outcomes
 * using brain_patterns and brain_learnings data.
 *
 * Uses the existing BrainDataAccessor and DataAccessor — no new tables.
 *
 * @task Wave3A
 * @epic T5149
 */

import type { Task } from '@cleocode/contracts';
import type { BrainDataAccessor } from '../store/brain-accessor.js';
import type { DataAccessor } from '../store/data-accessor.js';
import type { LearningContext, RiskAssessment, RiskFactor, ValidationPrediction } from './types.js';

// ============================================================================
// Constants
// ============================================================================

/** Risk factor weights — tuned to prioritize blocking risk and complexity. */
const RISK_WEIGHTS = {
  complexity: 0.25,
  historicalFailure: 0.25,
  blockingRisk: 0.3,
  dependencyDepth: 0.2,
} as const;

/** Thresholds for risk level recommendations. */
const RISK_THRESHOLDS = {
  low: 0.3,
  medium: 0.6,
  high: 0.8,
} as const;

/** Size-to-complexity mapping (0-1 scale). */
const SIZE_COMPLEXITY: Record<string, number> = {
  small: 0.2,
  medium: 0.5,
  large: 0.8,
};

// ============================================================================
// Risk Scoring
// ============================================================================

/**
 * Calculate the risk score for a task based on multiple contributing factors.
 *
 * Factors considered:
 * - Task complexity (size, dependency count, hierarchy depth)
 * - Historical patterns (similar tasks' failure rates from brain_patterns)
 * - Blocking risk (does this task block others?)
 * - Dependency depth (how deep in the dependency chain)
 *
 * @param taskId - The task to assess
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @returns A complete risk assessment with score, confidence, factors, and recommendation
 */
export async function calculateTaskRisk(
  taskId: string,
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
): Promise<RiskAssessment> {
  const task = await taskAccessor.loadSingleTask(taskId);
  if (!task) {
    return {
      taskId,
      riskScore: 0,
      confidence: 0,
      factors: [],
      recommendation: `Task ${taskId} not found — cannot assess risk.`,
    };
  }

  const factors: RiskFactor[] = [];
  let dataPoints = 0;

  // Factor 1: Complexity (size + dependency count + child count)
  const complexityFactor = await computeComplexityFactor(task, taskAccessor);
  factors.push(complexityFactor);
  dataPoints += 1;

  // Factor 2: Historical failure patterns from brain_patterns
  const historicalFactor = await computeHistoricalFailureFactor(task, brainAccessor);
  factors.push(historicalFactor);
  if (historicalFactor.value > 0) dataPoints += 1;

  // Factor 3: Blocking risk (how many tasks does this block?)
  const blockingFactor = await computeBlockingFactor(task, taskAccessor);
  factors.push(blockingFactor);
  dataPoints += 1;

  // Factor 4: Dependency depth
  const depthFactor = await computeDependencyDepthFactor(task, taskAccessor);
  factors.push(depthFactor);
  dataPoints += 1;

  // Compute weighted aggregate score
  const riskScore = computeWeightedScore(factors);

  // Confidence scales with available data (0.25 base, up to 1.0)
  const confidence = Math.min(1.0, 0.25 + (dataPoints / 4) * 0.75);

  const recommendation = generateRecommendation(riskScore, factors);

  return {
    taskId,
    riskScore: Math.round(riskScore * 1000) / 1000,
    confidence: Math.round(confidence * 1000) / 1000,
    factors,
    recommendation,
  };
}

// ============================================================================
// Validation Outcome Prediction
// ============================================================================

/**
 * Predict the likelihood of a task passing a lifecycle validation gate.
 *
 * Combines:
 * - Historical gate results for similar tasks (from brain_patterns)
 * - Current task completion state
 * - Applicable learnings from brain_learnings
 *
 * @param taskId - The task to evaluate
 * @param stage - The lifecycle stage (e.g., "specification", "implementation")
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @returns Prediction with pass likelihood, blockers, and suggestions
 */
export async function predictValidationOutcome(
  taskId: string,
  stage: string,
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
): Promise<ValidationPrediction> {
  const task = await taskAccessor.loadSingleTask(taskId);
  if (!task) {
    return {
      taskId,
      stage,
      passLikelihood: 0,
      blockers: [`Task ${taskId} not found`],
      suggestions: [],
    };
  }

  const blockers: string[] = [];
  const suggestions: string[] = [];
  let passSignals = 0;
  let failSignals = 0;
  let totalSignals = 0;

  // Signal 1: Task status assessment
  const statusResult = assessTaskStatus(task, stage);
  passSignals += statusResult.pass;
  failSignals += statusResult.fail;
  totalSignals += statusResult.total;
  blockers.push(...statusResult.blockers);
  suggestions.push(...statusResult.suggestions);

  // Signal 2: Acceptance criteria completeness
  const criteriaResult = assessAcceptanceCriteria(task);
  passSignals += criteriaResult.pass;
  failSignals += criteriaResult.fail;
  totalSignals += criteriaResult.total;
  blockers.push(...criteriaResult.blockers);
  suggestions.push(...criteriaResult.suggestions);

  // Signal 3: Historical success patterns from brain_patterns
  const patternResult = await assessHistoricalPatterns(task, stage, brainAccessor);
  passSignals += patternResult.pass;
  failSignals += patternResult.fail;
  totalSignals += patternResult.total;
  suggestions.push(...patternResult.suggestions);

  // Signal 4: Applicable learnings from brain_learnings
  const learningContext = await gatherLearningContext(task, brainAccessor);
  if (learningContext.actionableCount > 0) {
    passSignals += learningContext.averageConfidence;
    totalSignals += 1;
  }

  // Compute pass likelihood
  const passLikelihood =
    totalSignals > 0
      ? Math.round((passSignals / (passSignals + failSignals || 1)) * 1000) / 1000
      : 0.5;

  return {
    taskId,
    stage,
    passLikelihood: Math.max(0, Math.min(1, passLikelihood)),
    blockers,
    suggestions,
  };
}

// ============================================================================
// Internal: Risk Factor Computation
// ============================================================================

async function computeComplexityFactor(task: Task, accessor: DataAccessor): Promise<RiskFactor> {
  const depCount = task.depends?.length ?? 0;
  let childCount = 0;

  try {
    childCount = await accessor.countChildren(task.id);
  } catch {
    // countChildren may fail for leaf tasks; default to 0
  }

  const sizeValue = SIZE_COMPLEXITY[task.size ?? 'medium'] ?? 0.5;
  const depNormalized = Math.min(depCount / 10, 1.0);
  const childNormalized = Math.min(childCount / 20, 1.0);

  const value = sizeValue * 0.4 + depNormalized * 0.3 + childNormalized * 0.3;

  const parts: string[] = [];
  if (task.size) parts.push(`size=${task.size}`);
  if (depCount > 0) parts.push(`${depCount} dependencies`);
  if (childCount > 0) parts.push(`${childCount} children`);

  return {
    name: 'complexity',
    weight: RISK_WEIGHTS.complexity,
    value: Math.round(value * 1000) / 1000,
    description:
      parts.length > 0
        ? `Task complexity based on ${parts.join(', ')}`
        : 'Default complexity (no size/deps/children data)',
  };
}

async function computeHistoricalFailureFactor(
  task: Task,
  brainAccessor: BrainDataAccessor,
): Promise<RiskFactor> {
  // Look for failure and blocker patterns in brain_patterns
  const failurePatterns = await brainAccessor.findPatterns({ type: 'failure', limit: 50 });
  const blockerPatterns = await brainAccessor.findPatterns({ type: 'blocker', limit: 50 });

  const allNegativePatterns = [...failurePatterns, ...blockerPatterns];

  if (allNegativePatterns.length === 0) {
    return {
      name: 'historical_failure',
      weight: RISK_WEIGHTS.historicalFailure,
      value: 0,
      description: 'No historical failure patterns found in brain.db',
    };
  }

  // Score based on average failure rate of matching patterns
  let matchCount = 0;
  let totalFailureRate = 0;

  const taskLabels = new Set((task.labels ?? []).map((l) => l.toLowerCase()));
  const taskTitle = task.title.toLowerCase();
  const taskDesc = (task.description ?? '').toLowerCase();

  for (const p of allNegativePatterns) {
    const patternText = p.pattern.toLowerCase();
    const contextText = p.context.toLowerCase();

    // Check for textual overlap between pattern and task
    const hasLabelMatch =
      taskLabels.size > 0 &&
      [...taskLabels].some((l) => patternText.includes(l) || contextText.includes(l));
    const hasTitleMatch =
      patternText.includes(taskTitle) || taskTitle.includes(patternText.slice(0, 20));
    const hasDescMatch =
      taskDesc.length > 10 &&
      (patternText.includes(taskDesc.slice(0, 30)) || taskDesc.includes(patternText.slice(0, 30)));

    if (hasLabelMatch || hasTitleMatch || hasDescMatch) {
      matchCount++;
      // successRate close to 0 means high failure rate
      const failureRate = p.successRate !== null ? 1 - p.successRate : 0.5;
      totalFailureRate += failureRate;
    }
  }

  if (matchCount === 0) {
    return {
      name: 'historical_failure',
      weight: RISK_WEIGHTS.historicalFailure,
      value: 0,
      description: 'No matching historical failure patterns for this task',
    };
  }

  const avgFailureRate = totalFailureRate / matchCount;

  return {
    name: 'historical_failure',
    weight: RISK_WEIGHTS.historicalFailure,
    value: Math.round(avgFailureRate * 1000) / 1000,
    description: `${matchCount} matching failure/blocker pattern(s) with avg failure rate ${Math.round(avgFailureRate * 100)}%`,
  };
}

async function computeBlockingFactor(task: Task, accessor: DataAccessor): Promise<RiskFactor> {
  // Count how many other tasks depend on this task (i.e., this task blocks them)
  let blockedCount = 0;

  try {
    // Query all non-done tasks to find those that depend on this task
    const { tasks: allTasks } = await accessor.queryTasks({
      status: ['pending', 'active', 'blocked'],
    });

    for (const t of allTasks) {
      if (t.depends?.includes(task.id)) {
        blockedCount++;
      }
    }
  } catch {
    // Best-effort: if query fails, treat as unknown
  }

  // Normalize: 0 blocked = 0, 5+ blocked = 1.0
  const value = Math.min(blockedCount / 5, 1.0);

  return {
    name: 'blocking_risk',
    weight: RISK_WEIGHTS.blockingRisk,
    value: Math.round(value * 1000) / 1000,
    description:
      blockedCount > 0
        ? `This task blocks ${blockedCount} other task(s)`
        : 'This task does not block any other tasks',
  };
}

async function computeDependencyDepthFactor(
  task: Task,
  accessor: DataAccessor,
): Promise<RiskFactor> {
  // Walk the dependency chain to measure depth
  let depth = 0;
  const visited = new Set<string>();
  let current = task;

  while (current.depends && current.depends.length > 0 && depth < 10) {
    const firstDep = current.depends[0];
    if (visited.has(firstDep)) break; // cycle guard
    visited.add(firstDep);

    const depTask = await accessor.loadSingleTask(firstDep);
    if (!depTask) break;

    depth++;
    current = depTask;
  }

  // Also count parent depth (hierarchy)
  let hierarchyDepth = 0;
  let parentId = task.parentId;
  const visitedParents = new Set<string>();

  while (parentId && hierarchyDepth < 10) {
    if (visitedParents.has(parentId)) break;
    visitedParents.add(parentId);

    const parent = await accessor.loadSingleTask(parentId);
    if (!parent) break;

    hierarchyDepth++;
    parentId = parent.parentId;
  }

  const totalDepth = depth + hierarchyDepth;
  // Normalize: depth 0 = 0, depth 8+ = 1.0
  const value = Math.min(totalDepth / 8, 1.0);

  return {
    name: 'dependency_depth',
    weight: RISK_WEIGHTS.dependencyDepth,
    value: Math.round(value * 1000) / 1000,
    description: `Dependency chain depth: ${depth}, hierarchy depth: ${hierarchyDepth}`,
  };
}

// ============================================================================
// Internal: Validation Prediction Helpers
// ============================================================================

interface SignalResult {
  pass: number;
  fail: number;
  total: number;
  blockers: string[];
  suggestions: string[];
}

function assessTaskStatus(task: Task, stage: string): SignalResult {
  const blockers: string[] = [];
  const suggestions: string[] = [];
  let pass = 0;
  let fail = 0;

  if (task.status === 'blocked') {
    fail += 1;
    blockers.push(`Task is currently blocked${task.blockedBy ? `: ${task.blockedBy}` : ''}`);
    suggestions.push('Resolve blocking issues before attempting gate validation');
  } else if (task.status === 'cancelled') {
    fail += 1;
    blockers.push('Task is cancelled');
  } else if (task.status === 'done') {
    pass += 1;
  } else if (task.status === 'active') {
    // For early stages, active is fine; for late stages, may need completion
    if (stage === 'verification' || stage === 'release') {
      fail += 0.5;
      suggestions.push(`Task should be completed before ${stage} gate`);
    } else {
      pass += 0.5;
    }
  } else {
    // todo status
    if (stage === 'specification') {
      pass += 0.3;
    } else {
      fail += 0.5;
      suggestions.push(
        `Task is still in "${task.status}" status — work should begin before ${stage} gate`,
      );
    }
  }

  return { pass, fail, total: 1, blockers, suggestions };
}

function assessAcceptanceCriteria(task: Task): SignalResult {
  const blockers: string[] = [];
  const suggestions: string[] = [];

  const criteria = task.acceptance ?? [];

  if (criteria.length === 0) {
    return {
      pass: 0.3,
      fail: 0.2,
      total: 1,
      blockers: [],
      suggestions: ['Add acceptance criteria to improve validation confidence'],
    };
  }

  // Having acceptance criteria is a positive signal
  return {
    pass: 0.7,
    fail: 0,
    total: 1,
    blockers,
    suggestions,
  };
}

async function assessHistoricalPatterns(
  task: Task,
  stage: string,
  brainAccessor: BrainDataAccessor,
): Promise<SignalResult> {
  const suggestions: string[] = [];
  let pass = 0;
  let fail = 0;
  let total = 0;

  const taskLabels = new Set((task.labels ?? []).map((l) => l.toLowerCase()));
  const taskTitle = task.title.toLowerCase();

  // Look for success patterns related to this stage or matching task attributes
  const successPatterns = await brainAccessor.findPatterns({ type: 'success', limit: 30 });

  for (const p of successPatterns) {
    const ctx = p.context.toLowerCase();
    const pat = p.pattern.toLowerCase();
    const stageMatch = ctx.includes(stage.toLowerCase());
    const labelMatch = [...taskLabels].some((l) => pat.includes(l) || ctx.includes(l));
    const titleMatch = taskTitle
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => pat.includes(w));

    if (stageMatch || labelMatch || titleMatch) {
      total++;
      if (p.successRate !== null && p.successRate >= 0.7) {
        pass += p.successRate;
      } else {
        pass += 0.5;
      }
    }
  }

  // Look for failure patterns related to this stage or matching task attributes
  const failurePatterns = await brainAccessor.findPatterns({ type: 'failure', limit: 30 });

  for (const p of failurePatterns) {
    const ctx = p.context.toLowerCase();
    const pat = p.pattern.toLowerCase();
    const stageMatch = ctx.includes(stage.toLowerCase());
    const labelMatch = [...taskLabels].some((l) => pat.includes(l) || ctx.includes(l));
    const titleMatch = taskTitle
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .some((w) => pat.includes(w));

    if (stageMatch || labelMatch || titleMatch) {
      total++;
      fail += p.successRate !== null ? 1 - p.successRate : 0.5;
      if (p.mitigation) {
        suggestions.push(`Historical pattern suggests: ${p.mitigation}`);
      }
    }
  }

  if (total === 0) {
    return { pass: 0, fail: 0, total: 0, blockers: [], suggestions };
  }

  return { pass, fail, total, blockers: [], suggestions };
}

/**
 * Gather applicable learnings for a task from brain_learnings.
 */
export async function gatherLearningContext(
  task: Task,
  brainAccessor: BrainDataAccessor,
): Promise<LearningContext> {
  const learnings = await brainAccessor.findLearnings({ limit: 100 });

  const taskLabels = new Set((task.labels ?? []).map((l) => l.toLowerCase()));
  const taskTitle = task.title.toLowerCase();

  const applicable = learnings.filter((l) => {
    const insight = l.insight.toLowerCase();
    const source = l.source.toLowerCase();

    // Match by task ID reference
    if (insight.includes(task.id.toLowerCase()) || source.includes(task.id.toLowerCase())) {
      return true;
    }

    // Match by label overlap
    if (taskLabels.size > 0 && [...taskLabels].some((label) => insight.includes(label))) {
      return true;
    }

    // Match by applicable types
    const applicableTypes = JSON.parse(l.applicableTypesJson || '[]') as string[];
    if (task.type && applicableTypes.includes(task.type)) {
      return true;
    }

    // Match by title keyword overlap (at least 2 words matching)
    const titleWords = taskTitle.split(/\s+/).filter((w) => w.length > 3);
    const matchingWords = titleWords.filter((w) => insight.includes(w));
    if (matchingWords.length >= 2) {
      return true;
    }

    return false;
  });

  const totalConfidence = applicable.reduce((sum, l) => sum + l.confidence, 0);
  const averageConfidence = applicable.length > 0 ? totalConfidence / applicable.length : 0;
  const actionableCount = applicable.filter((l) => l.actionable).length;

  return {
    applicable,
    averageConfidence: Math.round(averageConfidence * 1000) / 1000,
    actionableCount,
  };
}

// ============================================================================
// Internal: Score Computation
// ============================================================================

function computeWeightedScore(factors: RiskFactor[]): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const f of factors) {
    weightedSum += f.weight * f.value;
    totalWeight += f.weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

function generateRecommendation(score: number, factors: RiskFactor[]): string {
  if (score <= RISK_THRESHOLDS.low) {
    return 'Low risk. Proceed with normal workflow.';
  }

  if (score <= RISK_THRESHOLDS.medium) {
    const topFactors = factors
      .filter((f) => f.value > 0.4)
      .sort((a, b) => b.value * b.weight - a.value * a.weight)
      .slice(0, 2);

    const factorNames = topFactors.map((f) => f.name).join(', ');
    return `Moderate risk (${factorNames}). Consider extra review or decomposition.`;
  }

  if (score <= RISK_THRESHOLDS.high) {
    return 'High risk. Recommend decomposition, additional testing, or pair review before proceeding.';
  }

  return 'Critical risk. Strongly recommend breaking this task into smaller units and addressing blockers first.';
}
