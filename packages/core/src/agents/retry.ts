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
 */
export function createRetryPolicy(overrides?: Partial<RetryPolicy>): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}

/**
 * Calculate the delay for a given retry attempt using exponential backoff.
 *
 * Formula: min(baseDelay * multiplier^attempt, maxDelay) + jitter
 * Jitter adds 0-25% randomness to prevent thundering herd.
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
 * The function will be retried according to the policy when retriable errors
 * occur. Permanent errors cause immediate failure. Unknown errors respect
 * the `retryOnUnknown` policy setting.
 *
 * @param fn - The async function to execute with retries
 * @param policy - Retry policy (uses DEFAULT_RETRY_POLICY if not provided)
 * @returns The result of the operation with retry metadata
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy?: Partial<RetryPolicy>,
): Promise<RetryResult<T>> {
  const effectivePolicy = createRetryPolicy(policy);
  let lastError: Error | undefined;
  let totalDelayMs = 0;

  for (let attempt = 0; attempt <= effectivePolicy.maxRetries; attempt++) {
    try {
      const value = await fn();
      return {
        success: true,
        value,
        attempts: attempt + 1,
        totalDelayMs,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (!shouldRetry(err, attempt, effectivePolicy)) {
        return {
          success: false,
          error: lastError,
          attempts: attempt + 1,
          totalDelayMs,
        };
      }

      // Calculate and apply delay before next attempt
      if (attempt < effectivePolicy.maxRetries) {
        const delay = calculateDelay(attempt, effectivePolicy);
        totalDelayMs += delay;
        await sleep(delay);
      }
    }
  }

  return {
    success: false,
    error: lastError ?? new Error('Retry exhausted without error'),
    attempts: effectivePolicy.maxRetries + 1,
    totalDelayMs,
  };
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
 * @param thresholdMs - Heartbeat threshold for crash detection (default: 30000)
 * @param cwd - Working directory
 * @returns Recovery results for each crashed agent
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

/**
 * Sleep for a given number of milliseconds.
 * Extracted for testability.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
