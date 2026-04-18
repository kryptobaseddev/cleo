/**
 * Shared SDK result mapper for CLEO spawn providers.
 *
 * Normalises provider-specific run results from the Vercel AI SDK bridge
 * into the canonical {@link SpawnResult} contract used by CLEO orchestration.
 *
 * Both the Claude SDK provider (T581) and the OpenAI SDK provider (T582)
 * import from this module so the mapping logic stays DRY.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — Vercel AI SDK migration)
 */

import type { SpawnResult } from '@cleocode/contracts';

/**
 * Raw run outcome from any SDK provider, normalised before mapping.
 *
 * @remarks
 * Both `@ai-sdk/anthropic` and `@ai-sdk/openai` (via Vercel AI SDK
 * `generateText`) surface a `text` string plus an optional error. This
 * interface captures the minimal shared shape so the mapper stays
 * provider-agnostic.
 */
export interface RawSdkRunOutcome {
  /** Final text produced by the agent run. Empty string when the run failed. */
  finalOutput: string;
  /** True when the run completed without error. */
  succeeded: boolean;
  /** Human-readable error message when `succeeded` is false. */
  errorMessage?: string;
  /** Exit / stop reason surfaced by the SDK (optional). */
  stopReason?: string;
}

/**
 * Map a raw SDK run outcome to the canonical CLEO {@link SpawnResult}.
 *
 * @param instanceId - Unique identifier for this spawn instance.
 * @param taskId - CLEO task ID associated with the run.
 * @param providerId - Identifier of the provider that performed the run (e.g. `'openai-sdk'`).
 * @param startTime - ISO timestamp captured just before the run was started.
 * @param outcome - Normalised run outcome from the SDK provider.
 * @returns A fully-populated {@link SpawnResult} ready for return from `spawn()`.
 *
 * @example
 * ```typescript
 * const result = mapSdkRunOutcome('openai-sdk-123', 'T582', 'openai-sdk', start, {
 *   finalOutput: 'Done',
 *   succeeded: true,
 * });
 * // result.status === 'completed'
 * ```
 */
export function mapSdkRunOutcome(
  instanceId: string,
  taskId: string,
  providerId: string,
  startTime: string,
  outcome: RawSdkRunOutcome,
): SpawnResult {
  const endTime = new Date().toISOString();

  if (outcome.succeeded) {
    return {
      instanceId,
      taskId,
      providerId,
      status: 'completed',
      output: outcome.finalOutput,
      startTime,
      endTime,
    };
  }

  return {
    instanceId,
    taskId,
    providerId,
    status: 'failed',
    startTime,
    endTime,
    error: outcome.errorMessage ?? 'SDK run failed without a message',
  };
}
