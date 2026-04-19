/**
 * Agent Execution Learning — Agent dimension BRAIN integration.
 *
 * Tracks which agent types succeed or fail on which task types, logs agent
 * decisions to brain_decisions with structured context, provides queries to
 * retrieve agent performance history, and implements basic self-healing by
 * recording failure patterns as brain_observations and surfacing healing
 * suggestions when the same failure pattern recurs.
 *
 * This module bridges the agent registry (tasks.db) with the cognitive
 * memory layer (brain.db) without introducing circular dependencies:
 * - Tasks.db agent tables: agent_instances, agent_error_log (agent-schema.ts)
 * - Brain.db tables: brain_decisions, brain_patterns, brain_observations
 *
 * All brain.db writes are best-effort — failures are silently swallowed so
 * agent lifecycle events never fail due to a brain.db write error.
 *
 * @module agents/execution-learning
 * @task T034
 * @epic T029
 */

import { randomBytes } from 'node:crypto';
import type { BrainDataAccessor } from '../store/memory-accessor.js';
import { getBrainAccessor } from '../store/memory-accessor.js';
import type {
  BrainDecisionRow,
  BrainObservationRow,
  BrainPatternRow,
} from '../store/memory-schema.js';
import type { AgentType } from './agent-schema.js';

// ============================================================================
// Types
// ============================================================================

/**
 * The outcome of an agent's execution attempt on a task.
 */
export type AgentExecutionOutcome = 'success' | 'failure' | 'partial';

/**
 * Context recorded when an agent completes or fails a task.
 */
export interface AgentExecutionEvent {
  /** Agent instance ID (agt_...). */
  agentId: string;
  /** Agent type classification. */
  agentType: AgentType;
  /** Task ID that was attempted. */
  taskId: string;
  /** Task type: 'epic' | 'task' | 'subtask'. */
  taskType: string;
  /** Task labels for richer pattern classification. */
  taskLabels?: string[];
  /** Execution outcome. */
  outcome: AgentExecutionOutcome;
  /** Error message if outcome is 'failure'. */
  errorMessage?: string;
  /** Error classification if outcome is 'failure'. */
  errorType?: 'retriable' | 'permanent' | 'unknown';
  /** Session ID the agent was running under. */
  sessionId?: string;
  /** Duration of execution in milliseconds (optional). */
  durationMs?: number;
}

/**
 * Summary of an agent type's execution performance on a task type.
 */
export interface AgentPerformanceSummary {
  /** Agent type. */
  agentType: AgentType;
  /** Task type this summary is for. */
  taskType: string;
  /** Total execution attempts tracked. */
  totalAttempts: number;
  /** Number of successful attempts. */
  successCount: number;
  /** Number of failed attempts. */
  failureCount: number;
  /** Success rate [0.0 – 1.0]. */
  successRate: number;
  /** Most recent attempt outcome. */
  lastOutcome: AgentExecutionOutcome | null;
  /** Timestamp of the most recent tracked decision. */
  lastSeenAt: string | null;
}

/**
 * A self-healing suggestion derived from failure pattern history.
 */
export interface HealingSuggestion {
  /** Pattern ID from brain_patterns. */
  patternId: string;
  /** Human-readable description of the failure pattern. */
  failurePattern: string;
  /** Times this pattern has been seen. */
  frequency: number;
  /** Mitigation / suggested next action. */
  suggestion: string;
  /** How confident the system is in this suggestion [0.0 – 1.0]. */
  confidence: number;
}

// ============================================================================
// ID generation helpers
// ============================================================================

/** Generate a unique brain_decisions ID with `AGT-` prefix. */
function generateDecisionId(): string {
  return `AGT-${randomBytes(5).toString('hex')}`;
}

/** Generate a unique brain_patterns ID with `P-agt-` prefix. */
function generatePatternId(): string {
  return `P-agt-${randomBytes(4).toString('hex')}`;
}

/** Generate a unique brain_observations ID with `O-agt-` prefix. */
function generateObservationId(): string {
  return `O-agt-${randomBytes(4).toString('hex')}`;
}

/** Normalised ISO timestamp in SQLite-friendly format (space separator). */
function nowSql(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// ============================================================================
// Execution event logging
// ============================================================================

/**
 * Record an agent execution event to brain_decisions.
 *
 * Each event becomes a `tactical` decision entry describing which agent type
 * handled which task type and whether it succeeded. This gives the BRAIN
 * system a queryable history of agent-task execution for pattern extraction.
 *
 * The call is best-effort — if brain.db is unavailable the error is swallowed
 * and null is returned so agent lifecycle code is never disrupted.
 *
 * @param event - Execution event to record
 * @param cwd - Working directory (resolves brain.db path)
 * @returns The stored decision row, or null on failure
 */
export async function recordAgentExecution(
  event: AgentExecutionEvent,
  cwd?: string,
): Promise<BrainDecisionRow | null> {
  try {
    const brain = await getBrainAccessor(cwd);
    return await _recordAgentExecutionWithAccessor(event, brain);
  } catch {
    // Best-effort — never propagate brain.db write failures to callers
    return null;
  }
}

/**
 * Internal implementation that accepts a pre-constructed accessor.
 * Separated for testability without touching the real file system.
 *
 * @internal
 */
export async function _recordAgentExecutionWithAccessor(
  event: AgentExecutionEvent,
  brain: BrainDataAccessor,
): Promise<BrainDecisionRow | null> {
  const id = generateDecisionId();
  const outcomeMap: Record<AgentExecutionOutcome, 'success' | 'failure' | 'mixed' | 'pending'> = {
    success: 'success',
    failure: 'failure',
    partial: 'mixed',
  };

  const decisionText = `Agent type "${event.agentType}" ${event.outcome === 'success' ? 'successfully completed' : `failed (${event.errorType ?? 'unknown'}) on`} task ${event.taskId} (type: ${event.taskType})`;

  const rationale = [
    `Agent: ${event.agentId}`,
    `Task type: ${event.taskType}`,
    `Outcome: ${event.outcome}`,
    event.taskLabels?.length ? `Labels: ${event.taskLabels.join(', ')}` : null,
    event.errorMessage ? `Error: ${event.errorMessage}` : null,
    event.durationMs != null ? `Duration: ${event.durationMs}ms` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  const alternativesJson = JSON.stringify({
    agentId: event.agentId,
    agentType: event.agentType,
    taskType: event.taskType,
    taskLabels: event.taskLabels ?? [],
    errorType: event.errorType ?? null,
    durationMs: event.durationMs ?? null,
    sessionId: event.sessionId ?? null,
  });

  const row = await brain.addDecision({
    id,
    type: 'tactical',
    decision: decisionText,
    rationale,
    confidence:
      event.outcome === 'success' ? 'high' : event.outcome === 'partial' ? 'medium' : 'low',
    outcome: outcomeMap[event.outcome],
    alternativesJson,
    contextTaskId: event.taskId,
    contextEpicId: null,
    contextPhase: null,
    createdAt: nowSql(),
    updatedAt: null,
  });

  return row;
}

// ============================================================================
// Performance queries
// ============================================================================

/**
 * Retrieve agent execution performance history from brain_decisions.
 *
 * Queries all `tactical` decisions recorded by `recordAgentExecution` and
 * aggregates them into per-(agentType, taskType) performance summaries.
 *
 * @param filters - Optional filters to narrow results
 * @param cwd - Working directory
 * @returns Array of performance summaries sorted by agentType then taskType
 */
export async function getAgentPerformanceHistory(
  filters: {
    agentType?: AgentType;
    taskType?: string;
    limit?: number;
  } = {},
  cwd?: string,
): Promise<AgentPerformanceSummary[]> {
  try {
    const brain = await getBrainAccessor(cwd);
    return await _getAgentPerformanceHistoryWithAccessor(filters, brain);
  } catch {
    return [];
  }
}

/**
 * Internal implementation with injected accessor for testability.
 *
 * @internal
 */
export async function _getAgentPerformanceHistoryWithAccessor(
  filters: {
    agentType?: AgentType;
    taskType?: string;
    limit?: number;
  },
  brain: BrainDataAccessor,
): Promise<AgentPerformanceSummary[]> {
  const decisions = await brain.findDecisions({
    type: 'tactical',
    limit: filters.limit ?? 500,
  });

  // Only process rows that were written by recordAgentExecution
  const agentDecisions = decisions.filter((d) => d.id.startsWith('AGT-'));

  // Aggregate per (agentType, taskType)
  const buckets = new Map<
    string,
    {
      agentType: AgentType;
      taskType: string;
      successes: number;
      failures: number;
      total: number;
      lastOutcome: AgentExecutionOutcome | null;
      lastSeenAt: string | null;
    }
  >();

  for (const d of agentDecisions) {
    let meta: { agentType?: string; taskType?: string } = {};
    try {
      meta = d.alternativesJson ? (JSON.parse(d.alternativesJson) as typeof meta) : {};
    } catch {
      continue;
    }

    const agentType = meta.agentType as AgentType | undefined;
    const taskType = meta.taskType as string | undefined;

    if (!agentType || !taskType) continue;

    // Apply optional filters
    if (filters.agentType && agentType !== filters.agentType) continue;
    if (filters.taskType && taskType !== filters.taskType) continue;

    const key = `${agentType}::${taskType}`;
    const existing = buckets.get(key) ?? {
      agentType,
      taskType,
      successes: 0,
      failures: 0,
      total: 0,
      lastOutcome: null,
      lastSeenAt: null,
    };

    existing.total += 1;

    const outcome = d.outcome;
    if (outcome === 'success') {
      existing.successes += 1;
      existing.lastOutcome = 'success';
    } else if (outcome === 'failure') {
      existing.failures += 1;
      existing.lastOutcome = 'failure';
    } else if (outcome === 'mixed') {
      existing.lastOutcome = 'partial';
    }

    // Track most-recent timestamp
    if (!existing.lastSeenAt || (d.createdAt && d.createdAt > existing.lastSeenAt)) {
      existing.lastSeenAt = d.createdAt;
    }

    buckets.set(key, existing);
  }

  return Array.from(buckets.values())
    .map((b) => ({
      agentType: b.agentType,
      taskType: b.taskType,
      totalAttempts: b.total,
      successCount: b.successes,
      failureCount: b.failures,
      successRate: b.total > 0 ? Math.round((b.successes / b.total) * 1000) / 1000 : 0,
      lastOutcome: b.lastOutcome,
      lastSeenAt: b.lastSeenAt,
    }))
    .sort((a, b) => a.agentType.localeCompare(b.agentType) || a.taskType.localeCompare(b.taskType));
}

// ============================================================================
// Failure pattern recording
// ============================================================================

/**
 * Record a task failure pattern to brain_patterns.
 *
 * When a task fails, the (agentType, taskType, errorType) combination is
 * stored as a `failure` pattern in brain.db. On subsequent failures matching
 * the same combination, the frequency counter is incremented and the success
 * rate updated. This data is what powers `getSelfHealingSuggestions`.
 *
 * The call is best-effort and never throws.
 *
 * @param event - A failure execution event (outcome must be 'failure')
 * @param cwd - Working directory
 * @returns The upserted pattern row, or null on error
 */
export async function recordFailurePattern(
  event: AgentExecutionEvent,
  cwd?: string,
): Promise<BrainPatternRow | null> {
  if (event.outcome !== 'failure') return null;

  try {
    const brain = await getBrainAccessor(cwd);
    return await _recordFailurePatternWithAccessor(event, brain);
  } catch {
    return null;
  }
}

/**
 * Internal implementation with injected accessor.
 *
 * @internal
 */
export async function _recordFailurePatternWithAccessor(
  event: AgentExecutionEvent,
  brain: BrainDataAccessor,
): Promise<BrainPatternRow | null> {
  const errorType = event.errorType ?? 'unknown';
  const patternText = `Agent type "${event.agentType}" fails on task type "${event.taskType}" with ${errorType} error`;
  const contextText = `Failure pattern detected: ${event.agentType} agent encountering ${errorType} errors on ${event.taskType} tasks`;

  // Look for an existing matching pattern (search by prefix naming convention)
  const existing = await brain.findPatterns({ type: 'failure', limit: 200 });
  const match = existing.find((p) => p.pattern === patternText);

  if (match) {
    // Update frequency counter and keep success_rate at 0 (all failures)
    const newFrequency = match.frequency + 1;
    const suggestion = buildHealingSuggestion(
      event.agentType,
      event.taskType,
      errorType,
      newFrequency,
    );

    await brain.updatePattern(match.id, {
      frequency: newFrequency,
      successRate: 0,
      mitigation: suggestion,
    });

    return {
      ...match,
      frequency: newFrequency,
      successRate: 0,
      mitigation: suggestion,
    };
  }

  // Create new failure pattern
  const id = generatePatternId();
  const now = nowSql();
  const suggestion = buildHealingSuggestion(event.agentType, event.taskType, errorType, 1);

  return brain.addPattern({
    id,
    type: 'failure',
    pattern: patternText,
    context: contextText,
    frequency: 1,
    successRate: 0,
    impact: 'medium',
    antiPattern: `${event.agentType} assigned to ${event.taskType} task with ${errorType} error risk`,
    mitigation: suggestion,
    examplesJson: JSON.stringify([event.taskId]),
    extractedAt: now,
    updatedAt: null,
  });
}

// ============================================================================
// Self-healing: observation storage
// ============================================================================

/**
 * Store a healing strategy observation to brain_observations.
 *
 * When a failure pattern reaches a significant frequency threshold (≥ 3),
 * a `change` observation is recorded to represent the healing action
 * recommended for future recurrences of the same pattern.
 *
 * The call is best-effort and never throws.
 *
 * @param event - The failure event that triggered healing
 * @param strategy - Human-readable healing strategy description
 * @param cwd - Working directory
 * @returns The stored observation row, or null on error
 */
export async function storeHealingStrategy(
  event: AgentExecutionEvent,
  strategy: string,
  cwd?: string,
): Promise<BrainObservationRow | null> {
  if (event.outcome !== 'failure') return null;

  try {
    const brain = await getBrainAccessor(cwd);
    return await _storeHealingStrategyWithAccessor(event, strategy, brain);
  } catch {
    return null;
  }
}

/**
 * Internal implementation with injected accessor.
 *
 * @internal
 */
export async function _storeHealingStrategyWithAccessor(
  event: AgentExecutionEvent,
  strategy: string,
  brain: BrainDataAccessor,
): Promise<BrainObservationRow | null> {
  const id = generateObservationId();
  const now = nowSql();

  return brain.addObservation({
    id,
    type: 'change',
    title: `Healing strategy: ${event.agentType} on ${event.taskType}`,
    subtitle: `Error type: ${event.errorType ?? 'unknown'}`,
    narrative: strategy,
    factsJson: JSON.stringify([
      `Agent: ${event.agentType}`,
      `Task type: ${event.taskType}`,
      `Error: ${event.errorMessage ?? 'unspecified'}`,
      `Suggested action: ${strategy}`,
    ]),
    conceptsJson: JSON.stringify([
      'self-healing',
      'agent-execution',
      event.agentType,
      event.taskType,
    ]),
    project: null,
    filesReadJson: null,
    filesModifiedJson: null,
    sourceSessionId: event.sessionId ?? null,
    sourceType: 'agent',
    contentHash: null,
    discoveryTokens: null,
    createdAt: now,
    updatedAt: null,
  });
}

// ============================================================================
// Self-healing: suggestion retrieval
// ============================================================================

/**
 * Get self-healing suggestions for a given agent type and task type.
 *
 * Queries brain_patterns for known failure patterns matching the
 * (agentType, taskType) combination and returns healing suggestions
 * ordered by frequency (most-seen first).
 *
 * Returns an empty array if no failure patterns are found or brain.db
 * is unavailable.
 *
 * @param agentType - The agent type to check
 * @param taskType - The task type to check
 * @param cwd - Working directory
 * @returns Array of healing suggestions, highest frequency first
 */
export async function getSelfHealingSuggestions(
  agentType: AgentType,
  taskType: string,
  cwd?: string,
): Promise<HealingSuggestion[]> {
  try {
    const brain = await getBrainAccessor(cwd);
    return await _getSelfHealingSuggestionsWithAccessor(agentType, taskType, brain);
  } catch {
    return [];
  }
}

/**
 * Internal implementation with injected accessor.
 *
 * @internal
 */
export async function _getSelfHealingSuggestionsWithAccessor(
  agentType: AgentType,
  taskType: string,
  brain: BrainDataAccessor,
): Promise<HealingSuggestion[]> {
  const patterns = await brain.findPatterns({ type: 'failure', limit: 200 });

  const prefix = `Agent type "${agentType}" fails on task type "${taskType}"`;
  const matches = patterns.filter((p) => p.pattern.startsWith(prefix) && p.mitigation);

  return matches
    .map((p) => ({
      patternId: p.id,
      failurePattern: p.pattern,
      frequency: p.frequency,
      suggestion: p.mitigation!,
      confidence: Math.min(0.3 + p.frequency * 0.1, 0.9),
    }))
    .sort((a, b) => b.frequency - a.frequency);
}

// ============================================================================
// Compound: record event + update patterns + suggest healing
// ============================================================================

/**
 * Full agent lifecycle event processor.
 *
 * Convenience function that:
 * 1. Records the execution event to brain_decisions
 * 2. On failure: records/updates the failure pattern in brain_patterns
 * 3. On failure with frequency ≥ 3: stores a healing strategy observation
 *
 * Returns a structured result with the recorded IDs and any healing
 * suggestions that now apply.
 *
 * All operations are best-effort — the call never throws.
 *
 * @param event - The execution event
 * @param cwd - Working directory
 */
export async function processAgentLifecycleEvent(
  event: AgentExecutionEvent,
  cwd?: string,
): Promise<{
  decisionId: string | null;
  patternId: string | null;
  observationId: string | null;
  healingSuggestions: HealingSuggestion[];
}> {
  const result = {
    decisionId: null as string | null,
    patternId: null as string | null,
    observationId: null as string | null,
    healingSuggestions: [] as HealingSuggestion[],
  };

  try {
    const brain = await getBrainAccessor(cwd);

    // 1. Record decision
    const decision = await _recordAgentExecutionWithAccessor(event, brain);
    if (decision) result.decisionId = decision.id;

    // 2. On failure: record/update failure pattern
    if (event.outcome === 'failure') {
      const pattern = await _recordFailurePatternWithAccessor(event, brain);
      if (pattern) {
        result.patternId = pattern.id;

        // 3. When pattern is well-established, store a healing strategy observation
        if (pattern.frequency >= 3 && pattern.mitigation) {
          const obs = await _storeHealingStrategyWithAccessor(event, pattern.mitigation, brain);
          if (obs) result.observationId = obs.id;
        }
      }
    }

    // 4. Retrieve current suggestions (applies to all outcomes — useful for
    //    monitoring even successful retries of previously-failing patterns)
    if (event.outcome !== 'success') {
      result.healingSuggestions = await _getSelfHealingSuggestionsWithAccessor(
        event.agentType,
        event.taskType,
        brain,
      );
    }
  } catch {
    // Best-effort — never propagate failures
  }

  return result;
}

// ============================================================================
// Internal: healing suggestion builder
// ============================================================================

/**
 * Build a human-readable healing mitigation string for a failure pattern.
 */
function buildHealingSuggestion(
  agentType: AgentType,
  taskType: string,
  errorType: string,
  frequency: number,
): string {
  if (errorType === 'retriable') {
    return `Retry with exponential backoff. Consider switching to a different ${agentType} agent instance if failures exceed threshold (seen ${frequency}x).`;
  }

  if (errorType === 'permanent') {
    return `Reassign task to a different agent type — ${agentType} has a permanent failure on ${taskType} tasks. Check permissions, inputs, and dependencies (seen ${frequency}x).`;
  }

  if (frequency >= 5) {
    return `High-frequency unknown failure (${frequency}x): escalate to orchestrator for manual investigation of ${agentType} on ${taskType} tasks.`;
  }

  return `Unknown failure for ${agentType} on ${taskType} tasks (${frequency}x). Check agent logs, retry with fresh context, or reassign to a different agent type.`;
}
