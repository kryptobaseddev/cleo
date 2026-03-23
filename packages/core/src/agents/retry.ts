/**
 * Self-healing and retry logic for the Agent dimension.
 *
 * Provides configurable retry policies with exponential backoff + jitter,
 * and recovery mechanisms for crashed agents. Error classification
 * determines whether a retry is appropriate.
 *
 * @module agents/retry
 */

import {
  checkAgentHealth,
  classifyError,
  listAgentInstances,
  updateAgentStatus,
} from './registry.js';

// ============================================================================
// Retry Policy
// ============================================================================

/** Configuration for retry behavior. */
export interface RetryPolicy {
  /** Maximum number of retry attempts. Default: 3. */
  maxRetries: number;
  /** Base delay in milliseconds before first retry. Default: 1000. */
  baseDelayMs: number;
  /** Maximum delay in milliseconds between retries. Default: 30000. */
  maxDelayMs: number;
  /** Multiplier for exponential backoff. Default: 2. */
  backoffMultiplier: number;
  /** Whether to add random jitter to delays. Default: true. */
  jitter: boolean;
  /** Whether to retry on 'unknown' error classification. Default: true. */
  retryOnUnknown: boolean;
}

/** Default retry policy matching the BRAIN specification. */
export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  backoffMultiplier: 2,
  jitter: true,
  retryOnUnknown: true,
});

/**
 * Create a retry policy by merging overrides with the default policy.
 *
 * @remarks
 * Unspecified fields fall back to {@link DEFAULT_RETRY_POLICY}.
 *
 * @param overrides - Partial policy to merge with defaults
 * @returns A complete RetryPolicy
 *
 * @example
 * ```ts
 * const policy = createRetryPolicy({ maxRetries: 5 });
 * ```
 */
export function createRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

/**
 * Calculate the delay for a given retry attempt using exponential backoff.
 *
 * @remarks
 * Formula: `min(baseDelay * multiplier^attempt, maxDelay) + jitter`.
 * Jitter adds 0-25% randomness to prevent thundering herd.
 *
 * @param attempt - Zero-based attempt index
 * @param policy - Retry policy with delay configuration
 * @returns Delay in milliseconds before the next attempt
 *
 * @example
 * ```ts
 * const delay = calculateDelay(1, createRetryPolicy());
 * // => ~2000ms (with jitter)
 * ```
 */
export function calculateDelay(attempt: number, policy: RetryPolicy): number {
  const exponentialDelay = policy.baseDelayMs * policy.backoffMultiplier ** attempt;
  const clampedDelay = Math.min(exponentialDelay, policy.maxDelayMs);

  if (!policy.jitter) return clampedDelay;

  // Add 0-25% jitter
  const jitterRange = clampedDelay * 0.25;
  const jitterValue = Math.random() * jitterRange;
  return Math.floor(clampedDelay + jitterValue);
}

/**
 * Determine whether an error should be retried based on its classification
 * and the retry policy.
 *
 * @remarks
 * Permanent errors are never retried. Retriable errors are always retried
 * (within attempt limits). Unknown errors defer to `policy.retryOnUnknown`.
 *
 * @param error - The caught error to classify
 * @param attempt - Current attempt number (0-based)
 * @param policy - Retry policy with limits and classification rules
 * @returns True if the error should be retried
 *
 * @example
 * ```ts
 * if (shouldRetry(err, attempt, policy)) { /* retry *\/ }
 * ```
 */
export function shouldRetry(error: unknown, attempt: number, policy: RetryPolicy): boolean {
  if (attempt >= policy.maxRetries) return false;

  const classification = classifyError(error);

  if (classification === 'permanent') return false;
  if (classification === 'retriable') return true;

  // 'unknown' classification -- policy determines behavior
  return policy.retryOnUnknown;
}

// ============================================================================
// Retry wrapper
// ============================================================================

/** Result of a retried operation. */
export interface RetryResult<T> {
  success: boolean;
  value?: T;
  error?: Error;
  attempts: number;
  totalDelayMs: number;
}

/**
 * Wrap an async function with retry logic using configurable exponential backoff.
 *
 * @remarks
 * Agent-specific variant that integrates with error classification from the
 * agent registry. For a dependency-free generic retry, use `lib/retry.ts`.
 *
 * @typeParam T - The resolved type of the async function
 * @param fn - The async function to execute with retries
 * @param policy - Retry policy (uses DEFAULT_RETRY_POLICY if not provided)
 * @returns The result of the operation with retry metadata
 *
 * @example
 * ```ts
 * const result = await withRetry(() => fetchAgentTask(agentId));
 * if (!result.success) console.error(result.error);
 * ```
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy?: Partial<RetryPolicy>,
): Promise<RetryResult<T>> {
  const effectivePolicy = createRetryPolicy(policy);
  const { withRetry: coreRetry } = await import('../lib/retry.js');
  try {
    const value = await coreRetry(fn, {
      maxAttempts: effectivePolicy.maxRetries + 1,
      baseDelayMs: effectivePolicy.baseDelayMs,
      maxDelayMs: effectivePolicy.maxDelayMs,
      retryableErrors: [(err: unknown) => shouldRetry(err, 0, effectivePolicy)],
    });
    return { success: true, value, attempts: 1, totalDelayMs: 0 };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const context = err as Partial<{ attempts: number; totalDelayMs: number }>;
    return {
      success: false,
      error,
      attempts: context.attempts ?? effectivePolicy.maxRetries + 1,
      totalDelayMs: context.totalDelayMs ?? 0,
    };
  }
}

// ============================================================================
// Recovery
// ============================================================================

/** Result of a recovery attempt for a single agent. */
export interface AgentRecoveryResult {
  agentId: string;
  recovered: boolean;
  action: 'restarted' | 'abandoned' | 'skipped';
  reason: string;
}

/**
 * Attempt to recover crashed agents.
 *
 * Finds all agents with status 'crashed' and determines if they can be
 * restarted based on their error history. Agents whose last error was
 * classified as 'permanent' are abandoned. Agents with retriable errors
 * are reset to 'starting' for the orchestration layer to re-assign.
 *
 * @remarks
 * Two-phase process: first detects stale agents via heartbeat threshold,
 * then evaluates each crashed agent's error history for recoverability.
 *
 * @param thresholdMs - Heartbeat threshold for crash detection (default: 30000)
 * @param cwd - Working directory
 * @returns Recovery results for each crashed agent
 *
 * @example
 * ```ts
 * const results = await recoverCrashedAgents(60_000);
 * results.filter(r => r.recovered).forEach(r => console.log(r.agentId));
 * ```
 */
export async function recoverCrashedAgents(
  thresholdMs: number = 30_000,
  cwd?: string,
): Promise<AgentRecoveryResult[]> {
  const results: AgentRecoveryResult[] = [];

  // Step 1: detect stale agents and mark them crashed
  const staleAgents = await checkAgentHealth(thresholdMs, cwd);
  for (const agent of staleAgents) {
    await updateAgentStatus(
      agent.id,
      { status: 'crashed', error: 'Heartbeat timeout detected during recovery sweep' },
      cwd,
    );
  }

  // Step 2: process all crashed agents
  const crashedAgents = await listAgentInstances({ status: 'crashed' }, cwd);

  for (const agent of crashedAgents) {
    // Check error history to determine recovery action
    const { getAgentErrorHistory } = await import('./registry.js');
    const errors = await getAgentErrorHistory(agent.id, cwd);
    const lastError = errors.length > 0 ? errors[errors.length - 1] : null;

    // Too many errors -- abandon
    if (agent.errorCount >= 5) {
      await updateAgentStatus(agent.id, { status: 'stopped' }, cwd);
      results.push({
        agentId: agent.id,
        recovered: false,
        action: 'abandoned',
        reason: `Error count (${agent.errorCount}) exceeds threshold (5)`,
      });
      continue;
    }

    // Last error was permanent -- abandon
    if (lastError?.errorType === 'permanent') {
      await updateAgentStatus(agent.id, { status: 'stopped' }, cwd);
      results.push({
        agentId: agent.id,
        recovered: false,
        action: 'abandoned',
        reason: `Permanent error: ${lastError.message}`,
      });
      continue;
    }

    // Retriable or unknown -- attempt restart by resetting to 'starting'
    await updateAgentStatus(agent.id, { status: 'starting' }, cwd);
    results.push({
      agentId: agent.id,
      recovered: true,
      action: 'restarted',
      reason: 'Agent reset to starting for re-assignment',
    });
  }

  return results;
}

// ============================================================================
// Utilities
// ============================================================================

