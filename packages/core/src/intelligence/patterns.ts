/**
 * Pattern Extraction module for the CLEO Intelligence dimension.
 *
 * Provides automatic pattern detection from brain_observations and task history,
 * pattern matching against brain_patterns, and pattern storage/stat updates.
 *
 * Uses the existing brain_patterns and brain_learnings tables — no new tables.
 *
 * @task Wave3A
 * @epic T5149
 */

import { randomBytes } from 'node:crypto';
import type { BrainDataAccessor } from '../store/brain-accessor.js';
import type { BrainPatternRow } from '../store/brain-schema.js';
import type { DataAccessor } from '../store/data-accessor.js';
import type {
  DetectedPattern,
  PatternExtractionOptions,
  PatternMatch,
  PatternStatsUpdate,
} from './types.js';

// ============================================================================
// Pattern Extraction
// ============================================================================

/**
 * Analyze brain_observations and task history to find recurring patterns.
 *
 * Detects:
 * - Workflow patterns: common task sequences that succeed/fail
 * - Blocker patterns: what commonly blocks tasks
 * - Success patterns: what correlates with successful task completion
 * - Time patterns: recurring label/type distributions by task status
 *
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @param options - Extraction options (min frequency, confidence, limit)
 * @returns Array of detected patterns sorted by frequency descending
 */
export async function extractPatternsFromHistory(
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
  options?: PatternExtractionOptions,
): Promise<DetectedPattern[]> {
  const minFrequency = options?.minFrequency ?? 2;
  const minConfidence = options?.minConfidence ?? 0.3;
  const limit = options?.limit ?? 50;

  const patterns: DetectedPattern[] = [];

  // Extract blocker patterns from blocked tasks
  const blockerPatterns = await extractBlockerPatterns(taskAccessor, minFrequency);
  patterns.push(...blockerPatterns);

  // Extract success patterns from completed tasks
  const successPatterns = await extractSuccessPatterns(taskAccessor, minFrequency);
  patterns.push(...successPatterns);

  // Extract workflow patterns from task label co-occurrence
  const workflowPatterns = await extractWorkflowPatterns(taskAccessor, minFrequency);
  patterns.push(...workflowPatterns);

  // Extract patterns from existing brain_observations
  const observationPatterns = await extractObservationPatterns(brainAccessor, minFrequency);
  patterns.push(...observationPatterns);

  // Filter by type if specified
  let filtered = options?.type
    ? patterns.filter((p) => p.type === options.type)
    : patterns;

  // Filter by minimum confidence
  filtered = filtered.filter((p) => p.confidence >= minConfidence);

  // Sort by frequency descending, then by confidence
  filtered.sort((a, b) => b.frequency - a.frequency || b.confidence - a.confidence);

  return filtered.slice(0, limit);
}

// ============================================================================
// Pattern Matching
// ============================================================================

/**
 * Find which known patterns from brain_patterns apply to a given task.
 *
 * Compares task attributes (labels, title, description, type, size, status)
 * against stored patterns and returns matches with relevance scores.
 *
 * @param taskId - The task to match patterns against
 * @param taskAccessor - DataAccessor for tasks.db
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @returns Array of pattern matches sorted by relevance descending
 */
export async function matchPatterns(
  taskId: string,
  taskAccessor: DataAccessor,
  brainAccessor: BrainDataAccessor,
): Promise<PatternMatch[]> {
  const task = await taskAccessor.loadSingleTask(taskId);
  if (!task) {
    return [];
  }

  const allPatterns = await brainAccessor.findPatterns({ limit: 200 });
  const matches: PatternMatch[] = [];

  const taskLabels = new Set((task.labels ?? []).map((l) => l.toLowerCase()));
  const taskTitle = task.title.toLowerCase();
  const taskDesc = (task.description ?? '').toLowerCase();
  const taskType = task.type?.toLowerCase() ?? '';

  for (const pattern of allPatterns) {
    const score = computePatternRelevance(pattern, taskLabels, taskTitle, taskDesc, taskType);

    if (score > 0) {
      const matchReason = buildMatchReason(pattern, taskLabels, taskTitle, taskDesc);

      matches.push({
        pattern,
        relevanceScore: Math.round(score * 1000) / 1000,
        matchReason,
        isAntiPattern: pattern.antiPattern !== null && pattern.antiPattern.length > 0,
      });
    }
  }

  // Sort by relevance descending
  matches.sort((a, b) => b.relevanceScore - a.relevanceScore);

  return matches;
}

// ============================================================================
// Pattern Storage
// ============================================================================

/**
 * Save a detected pattern to the brain_patterns table.
 *
 * Uses the existing brain_patterns schema: type, pattern, context, frequency,
 * success_rate, impact, anti_pattern, mitigation, examples_json.
 *
 * @param detected - The pattern to store
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @returns The stored pattern row
 */
export async function storeDetectedPattern(
  detected: DetectedPattern,
  brainAccessor: BrainDataAccessor,
): Promise<BrainPatternRow> {
  const id = `P-${randomBytes(4).toString('hex')}`;
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  return brainAccessor.addPattern({
    id,
    type: detected.type,
    pattern: detected.pattern,
    context: detected.context,
    frequency: detected.frequency,
    successRate: detected.successRate,
    impact: detected.impact,
    antiPattern: detected.antiPattern,
    mitigation: detected.mitigation,
    examplesJson: JSON.stringify(detected.examples),
    extractedAt: now,
  });
}

/**
 * Update the frequency and success_rate of an existing pattern after an outcome.
 *
 * Increments frequency by 1 and recalculates success_rate using the running
 * average formula: newRate = (oldRate * oldFreq + (success ? 1 : 0)) / newFreq.
 *
 * @param patternId - The brain_patterns ID to update
 * @param outcome - Whether the outcome was successful
 * @param brainAccessor - BrainDataAccessor for brain.db
 * @returns The update result or null if the pattern was not found
 */
export async function updatePatternStats(
  patternId: string,
  outcome: boolean,
  brainAccessor: BrainDataAccessor,
): Promise<PatternStatsUpdate | null> {
  const existing = await brainAccessor.getPattern(patternId);
  if (!existing) {
    return null;
  }

  const oldFrequency = existing.frequency;
  const newFrequency = oldFrequency + 1;

  // Recalculate success rate with running average
  const oldRate = existing.successRate ?? 0.5;
  const newRate = (oldRate * oldFrequency + (outcome ? 1 : 0)) / newFrequency;

  await brainAccessor.updatePattern(patternId, {
    frequency: newFrequency,
    successRate: Math.round(newRate * 1000) / 1000,
  });

  return {
    patternId,
    newFrequency,
    newSuccessRate: Math.round(newRate * 1000) / 1000,
    outcomeSuccess: outcome,
  };
}

// ============================================================================
// Internal: Pattern Extraction Helpers
// ============================================================================

async function extractBlockerPatterns(
  accessor: DataAccessor,
  minFrequency: number,
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  try {
    const { tasks: blockedTasks } = await accessor.queryTasks({ status: 'blocked' });

    if (blockedTasks.length < minFrequency) {
      return patterns;
    }

    // Group by blockedBy reason
    const reasonCounts = new Map<string, string[]>();
    for (const t of blockedTasks) {
      const reason = t.blockedBy?.trim() ?? 'unspecified';
      const existing = reasonCounts.get(reason) ?? [];
      existing.push(t.id);
      reasonCounts.set(reason, existing);
    }

    for (const [reason, taskIds] of reasonCounts) {
      if (taskIds.length >= minFrequency) {
        patterns.push({
          type: 'blocker',
          pattern: `Tasks blocked by: ${reason}`,
          context: `${taskIds.length} tasks are currently blocked with this reason`,
          frequency: taskIds.length,
          successRate: null,
          impact: taskIds.length >= 5 ? 'high' : taskIds.length >= 3 ? 'medium' : 'low',
          antiPattern: `Recurring blocker: ${reason}`,
          mitigation: `Address root cause of "${reason}" to unblock ${taskIds.length} tasks`,
          examples: taskIds.slice(0, 10),
          confidence: Math.min(0.5 + taskIds.length * 0.1, 0.9),
        });
      }
    }

    // Overall blocked pattern if many tasks are blocked
    if (blockedTasks.length >= 3) {
      patterns.push({
        type: 'blocker',
        pattern: `${blockedTasks.length} tasks currently in blocked status`,
        context: 'Project-wide blocked task analysis',
        frequency: blockedTasks.length,
        successRate: null,
        impact: blockedTasks.length >= 10 ? 'high' : 'medium',
        antiPattern: 'High number of blocked tasks indicates systemic issues',
        mitigation: 'Review and triage blocked tasks, identify common root causes',
        examples: blockedTasks.slice(0, 10).map((t) => t.id),
        confidence: 0.8,
      });
    }
  } catch {
    // Best-effort extraction
  }

  return patterns;
}

async function extractSuccessPatterns(
  accessor: DataAccessor,
  minFrequency: number,
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  try {
    const { tasks: doneTasks } = await accessor.queryTasks({ status: 'done' });

    if (doneTasks.length < minFrequency) {
      return patterns;
    }

    // Analyze label distribution in completed tasks
    const labelCounts = new Map<string, string[]>();
    for (const t of doneTasks) {
      for (const label of t.labels ?? []) {
        const existing = labelCounts.get(label) ?? [];
        existing.push(t.id);
        labelCounts.set(label, existing);
      }
    }

    for (const [label, taskIds] of labelCounts) {
      if (taskIds.length >= minFrequency) {
        patterns.push({
          type: 'success',
          pattern: `Label "${label}" appears in ${taskIds.length} completed tasks`,
          context: `Recurring success pattern detected from completed task labels`,
          frequency: taskIds.length,
          successRate: 1.0,
          impact: taskIds.length >= 10 ? 'high' : taskIds.length >= 5 ? 'medium' : 'low',
          antiPattern: null,
          mitigation: null,
          examples: taskIds.slice(0, 10),
          confidence: Math.min(0.4 + taskIds.length * 0.05, 0.9),
        });
      }
    }

    // Size distribution pattern
    const sizeCounts: Record<string, number> = {};
    for (const t of doneTasks) {
      const size = t.size ?? 'unspecified';
      sizeCounts[size] = (sizeCounts[size] || 0) + 1;
    }

    const dominantSize = Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominantSize && dominantSize[1] >= minFrequency) {
      patterns.push({
        type: 'success',
        pattern: `Most completed tasks are "${dominantSize[0]}" sized (${dominantSize[1]}/${doneTasks.length})`,
        context: 'Task size distribution analysis of completed work',
        frequency: dominantSize[1],
        successRate: dominantSize[1] / doneTasks.length,
        impact: 'medium',
        antiPattern: null,
        mitigation: null,
        examples: [],
        confidence: 0.6,
      });
    }
  } catch {
    // Best-effort extraction
  }

  return patterns;
}

async function extractWorkflowPatterns(
  accessor: DataAccessor,
  minFrequency: number,
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  try {
    // Get all tasks to analyze dependency chains
    const { tasks: allTasks } = await accessor.queryTasks({});

    if (allTasks.length === 0) {
      return patterns;
    }

    // Find tasks that frequently appear as dependencies
    const depTargetCounts = new Map<string, number>();
    for (const t of allTasks) {
      for (const dep of t.depends ?? []) {
        depTargetCounts.set(dep, (depTargetCounts.get(dep) || 0) + 1);
      }
    }

    // Hub tasks (many things depend on them)
    for (const [taskId, count] of depTargetCounts) {
      if (count >= minFrequency) {
        const hubTask = allTasks.find((t) => t.id === taskId);
        const title = hubTask?.title ?? taskId;

        patterns.push({
          type: 'workflow',
          pattern: `Task "${title}" (${taskId}) is a dependency hub with ${count} dependents`,
          context: 'Dependency graph analysis — hub tasks are critical path candidates',
          frequency: count,
          successRate: hubTask?.status === 'done' ? 1.0 : null,
          impact: count >= 5 ? 'high' : 'medium',
          antiPattern: count >= 8 ? `Task ${taskId} may be an overly-centralized bottleneck` : null,
          mitigation: count >= 8 ? 'Consider decomposing this task to reduce coupling' : null,
          examples: allTasks
            .filter((t) => t.depends?.includes(taskId))
            .slice(0, 10)
            .map((t) => t.id),
          confidence: 0.7,
        });
      }
    }

    // Parent task completion rate analysis
    const parentIds = new Set(allTasks.filter((t) => t.parentId).map((t) => t.parentId!));
    for (const parentId of parentIds) {
      const children = allTasks.filter((t) => t.parentId === parentId);
      if (children.length < minFrequency) continue;

      const doneChildren = children.filter((t) => t.status === 'done');
      const blockedChildren = children.filter((t) => t.status === 'blocked');

      if (blockedChildren.length >= 2) {
        patterns.push({
          type: 'failure',
          pattern: `Epic/parent ${parentId} has ${blockedChildren.length}/${children.length} children blocked`,
          context: 'Parent task analysis — high blocked child ratio indicates systemic issues',
          frequency: blockedChildren.length,
          successRate: doneChildren.length / children.length,
          impact: blockedChildren.length / children.length >= 0.5 ? 'high' : 'medium',
          antiPattern: 'High ratio of blocked children under a parent task',
          mitigation: 'Review blocked children and address common dependencies or blockers',
          examples: blockedChildren.slice(0, 10).map((t) => t.id),
          confidence: 0.6,
        });
      }
    }
  } catch {
    // Best-effort extraction
  }

  return patterns;
}

async function extractObservationPatterns(
  brainAccessor: BrainDataAccessor,
  minFrequency: number,
): Promise<DetectedPattern[]> {
  const patterns: DetectedPattern[] = [];

  try {
    const observations = await brainAccessor.findObservations({ limit: 200 });

    if (observations.length < minFrequency) {
      return patterns;
    }

    // Group observations by type
    const typeCounts = new Map<string, number>();
    for (const obs of observations) {
      typeCounts.set(obs.type, (typeCounts.get(obs.type) || 0) + 1);
    }

    for (const [type, count] of typeCounts) {
      if (count >= minFrequency) {
        // Map observation type to pattern type
        const patternType = observationTypeToPatternType(type);

        patterns.push({
          type: patternType,
          pattern: `${count} "${type}" observations recorded`,
          context: 'Brain observation frequency analysis',
          frequency: count,
          successRate: type === 'feature' || type === 'refactor' ? 0.8 : null,
          impact: count >= 10 ? 'high' : count >= 5 ? 'medium' : 'low',
          antiPattern: type === 'bugfix' && count >= 5
            ? 'High number of bugfix observations may indicate quality issues'
            : null,
          mitigation: type === 'bugfix' && count >= 5
            ? 'Consider adding more automated tests and code review'
            : null,
          examples: observations
            .filter((o) => o.type === type)
            .slice(0, 5)
            .map((o) => o.id),
          confidence: 0.5,
        });
      }
    }

    // Detect project-specific observation clusters
    const projectCounts = new Map<string, number>();
    for (const obs of observations) {
      if (obs.project) {
        projectCounts.set(obs.project, (projectCounts.get(obs.project) || 0) + 1);
      }
    }

    for (const [project, count] of projectCounts) {
      if (count >= minFrequency * 2) {
        patterns.push({
          type: 'workflow',
          pattern: `Project "${project}" has ${count} observations — high activity area`,
          context: 'Cross-project observation density analysis',
          frequency: count,
          successRate: null,
          impact: 'medium',
          antiPattern: null,
          mitigation: null,
          examples: [],
          confidence: 0.4,
        });
      }
    }
  } catch {
    // Best-effort extraction
  }

  return patterns;
}

// ============================================================================
// Internal: Relevance Scoring
// ============================================================================

function computePatternRelevance(
  pattern: BrainPatternRow,
  taskLabels: Set<string>,
  taskTitle: string,
  taskDesc: string,
  taskType: string,
): number {
  let score = 0;
  const patternText = pattern.pattern.toLowerCase();
  const contextText = pattern.context.toLowerCase();

  // Label match (strong signal)
  if (taskLabels.size > 0) {
    for (const label of taskLabels) {
      if (patternText.includes(label) || contextText.includes(label)) {
        score += 0.3;
        break;
      }
    }
  }

  // Title keyword overlap
  const titleWords = taskTitle.split(/\s+/).filter((w) => w.length > 3);
  const matchingTitleWords = titleWords.filter(
    (w) => patternText.includes(w) || contextText.includes(w),
  );
  if (matchingTitleWords.length > 0) {
    score += Math.min(matchingTitleWords.length * 0.15, 0.3);
  }

  // Description keyword overlap
  if (taskDesc.length > 10) {
    const descWords = taskDesc.split(/\s+/).filter((w) => w.length > 4);
    const matchingDescWords = descWords.filter(
      (w) => patternText.includes(w) || contextText.includes(w),
    );
    if (matchingDescWords.length > 0) {
      score += Math.min(matchingDescWords.length * 0.1, 0.2);
    }
  }

  // Type match (if pattern mentions task type)
  if (taskType && (patternText.includes(taskType) || contextText.includes(taskType))) {
    score += 0.2;
  }

  // Boost high-impact patterns
  if (pattern.impact === 'high' && score > 0) {
    score *= 1.2;
  }

  // Boost high-frequency patterns
  if (pattern.frequency >= 5 && score > 0) {
    score *= 1.1;
  }

  return Math.min(score, 1.0);
}

function buildMatchReason(
  pattern: BrainPatternRow,
  taskLabels: Set<string>,
  taskTitle: string,
  taskDesc: string,
): string {
  const reasons: string[] = [];
  const patternText = pattern.pattern.toLowerCase();
  const contextText = pattern.context.toLowerCase();

  for (const label of taskLabels) {
    if (patternText.includes(label) || contextText.includes(label)) {
      reasons.push(`label "${label}" matches`);
      break;
    }
  }

  const titleWords = taskTitle.split(/\s+/).filter((w) => w.length > 3);
  const matchingWords = titleWords.filter(
    (w) => patternText.includes(w) || contextText.includes(w),
  );
  if (matchingWords.length > 0) {
    reasons.push(`title keywords [${matchingWords.join(', ')}] match`);
  }

  // Check description keywords against pattern
  const descWords = taskDesc.toLowerCase().split(/\s+/).filter((w) => w.length > 4);
  const descMatches = descWords.filter(
    (w) => patternText.includes(w) || contextText.includes(w),
  );
  if (descMatches.length > 0) {
    reasons.push(`description keywords [${descMatches.slice(0, 3).join(', ')}] match`);
  }

  if (reasons.length === 0) {
    reasons.push('general textual similarity');
  }

  return reasons.join('; ');
}

function observationTypeToPatternType(
  obsType: string,
): DetectedPattern['type'] {
  switch (obsType) {
    case 'bugfix':
      return 'failure';
    case 'feature':
    case 'refactor':
      return 'success';
    case 'change':
      return 'workflow';
    case 'decision':
      return 'optimization';
    default:
      return 'workflow';
  }
}
