/**
 * LAFS token budget enforcement for dispatch responses.
 *
 * Wraps the LAFS protocol's applyBudgetEnforcement() to limit
 * response sizes for context-constrained agents.
 *
 * @task T4701
 * @task T338 — updated for canonical CLI envelope (meta, data)
 * @task T11350 — wired as a LIVE dispatch chokepoint; adds 'error' overflow mode
 * @epic T4663
 * @epic T11285 EP-MVI-PRIMITIVE
 */

import type { BudgetEnforcementResult } from '@cleocode/lafs';
import { applyBudgetEnforcement, BUDGET_EXCEEDED_CODE, checkBudget } from '@cleocode/lafs';
import type { _ProtoEnvelopeStub } from './proto-envelope.js';

/**
 * Default token budget when no explicit budget is provided.
 * Standard MVI level allows up to 4000 tokens per response.
 *
 * @task T4701
 */
const DEFAULT_BUDGET = 4000;

/**
 * Overflow-handling mode for {@link enforceBudget}.
 *
 * - `'truncate'` — when the response exceeds budget, attempt to truncate the
 *   data payload down to fit (the historical behavior). Falls back to an error
 *   only when even an empty payload cannot fit.
 * - `'error'` — when the response exceeds budget, signal an
 *   `E_MVI_BUDGET_EXCEEDED` error without attempting truncation.
 *
 * @task T11350
 * @epic T11285
 */
export type BudgetMode = 'truncate' | 'error';

/**
 * Options controlling {@link enforceBudget} behavior.
 *
 * @task T11350
 * @epic T11285
 */
export interface EnforceBudgetOptions {
  /** Maximum allowed tokens. Defaults to {@link DEFAULT_BUDGET}. */
  budget?: number;
  /** How to handle overflow. Defaults to `'truncate'` (backward-compatible). */
  mode?: BudgetMode;
}

/**
 * Re-export the canonical LAFS budget-exceeded error code so dispatch-layer
 * callers (middleware, tests) reference a single source rather than a literal.
 *
 * @task T11350
 */
export { BUDGET_EXCEEDED_CODE };

/**
 * Bridge a canonical CLI response (`{meta, data}`) into the SDK's proto-shape
 * envelope (`{_meta, result}`) expected by `applyBudgetEnforcement` /
 * `checkBudget`.
 *
 * The SDK validators require a populated `_meta` block; when the CLI response
 * has no usable meta we synthesize a minimal one.
 *
 * @param response - The canonical CLI response object.
 * @returns A proto-shape envelope stub.
 *
 * @internal
 */
function toProtoEnvelope(response: Record<string, unknown>): _ProtoEnvelopeStub {
  const protoMeta = (response['meta'] ?? {}) as _ProtoEnvelopeStub['_meta'];
  return {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta:
      Object.keys(protoMeta).length > 0
        ? protoMeta
        : {
            specVersion: '1.2.3',
            schemaVersion: '2026.2.1',
            timestamp: new Date().toISOString(),
            operation: 'dispatch.response',
            requestId: 'budget-check',
            transport: 'sdk',
            strict: true,
            mvi: 'standard',
            contextVersion: 1,
          },
    success: (response['success'] as boolean) ?? true,
    result: (response['data'] as Record<string, unknown>) ?? null,
    ...(response['error'] ? { error: response['error'] as Record<string, unknown> } : {}),
  };
}

/**
 * Result of an {@link enforceBudget} call.
 *
 * @task T11350
 */
export interface EnforceBudgetResult {
  /** The response, with `_budgetEnforcement` meta and possibly truncated data. */
  response: Record<string, unknown>;
  /** The raw enforcement result from the LAFS engine. */
  enforcement: BudgetEnforcementResult;
  /**
   * `true` when overflow occurred in `'error'` mode (or truncation could not
   * bring the payload within budget). Callers translate this into an
   * `E_MVI_BUDGET_EXCEEDED` error envelope.
   */
  exceeded: boolean;
}

/**
 * Apply budget enforcement to a dispatch response envelope.
 *
 * Converts the DomainResponse into an LAFSEnvelope shape for budget checking,
 * then either truncates (default) or signals overflow per the configured mode.
 *
 * Backward-compatible overload: passing a bare `number` is treated as the
 * budget with `mode: 'truncate'`.
 *
 * @param response - The domain response object.
 * @param budgetOrOptions - A bare budget number (legacy) or an
 *   {@link EnforceBudgetOptions} object.
 * @returns The (possibly truncated) response, the raw enforcement result, and
 *   an `exceeded` flag indicating whether the caller should emit an error.
 *
 * @task T4701
 * @task T11350
 * @epic T4663
 * @epic T11285
 */
export function enforceBudget(
  response: Record<string, unknown>,
  budgetOrOptions?: number | EnforceBudgetOptions,
): EnforceBudgetResult {
  const options: EnforceBudgetOptions =
    typeof budgetOrOptions === 'number' ? { budget: budgetOrOptions } : (budgetOrOptions ?? {});
  const effectiveBudget = options.budget ?? DEFAULT_BUDGET;
  const mode: BudgetMode = options.mode ?? 'truncate';

  const envelope = toProtoEnvelope(response);

  const enforcement = applyBudgetEnforcement(
    envelope as Parameters<typeof applyBudgetEnforcement>[0],
    effectiveBudget,
    // In 'truncate' mode the engine attempts to shrink the payload; in 'error'
    // mode we skip truncation so the overflow surfaces as an error envelope.
    { truncateOnExceed: mode === 'truncate' },
  );

  // The engine sets withinBudget=false ONLY when it could not bring the
  // payload within budget (error mode, or truncation insufficient).
  const exceeded = !enforcement.withinBudget;

  // Merge budget info back into the response meta.
  const meta = (response['meta'] ?? {}) as Record<string, unknown>;
  meta['_budgetEnforcement'] = {
    budget: effectiveBudget,
    estimatedTokens: enforcement.estimatedTokens,
    withinBudget: enforcement.withinBudget,
    truncated: enforcement.truncated,
    mode,
  };

  return {
    response: {
      ...response,
      meta,
      // Replace data with the (possibly truncated) result when truncation
      // actually occurred.
      ...(enforcement.truncated &&
        enforcement.envelope.result !== undefined && {
          data: enforcement.envelope.result,
        }),
    },
    enforcement,
    exceeded,
  };
}

/**
 * Quick check whether a response exceeds a token budget without modifying it.
 *
 * @task T4701
 * @epic T4663
 */
export function isWithinBudget(response: Record<string, unknown>, budget?: number): boolean {
  const effectiveBudget = budget ?? DEFAULT_BUDGET;
  const envelope = toProtoEnvelope({ ...response, success: true });
  const { exceeded } = checkBudget(envelope as Parameters<typeof checkBudget>[0], effectiveBudget);
  return !exceeded;
}
