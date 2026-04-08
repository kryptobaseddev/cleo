/**
 * LAFS token budget enforcement for dispatch responses.
 *
 * Wraps the LAFS protocol's applyBudgetEnforcement() to limit
 * response sizes for context-constrained agents.
 *
 * @task T4701
 * @task T338 — updated for canonical CLI envelope (meta, data)
 * @epic T4663
 */

import type { BudgetEnforcementResult } from '@cleocode/lafs';
import { applyBudgetEnforcement, checkBudget } from '@cleocode/lafs';
import type { _ProtoEnvelopeStub } from './proto-envelope.js';

/**
 * Default token budget when no explicit budget is provided.
 * Standard MVI level allows up to 4000 tokens per response.
 *
 * @task T4701
 */
const DEFAULT_BUDGET = 4000;

/**
 * Apply budget enforcement to a dispatch response envelope.
 *
 * Converts the DomainResponse into an LAFSEnvelope shape for budget checking,
 * then applies truncation if the response exceeds the budget.
 *
 * @param response - The domain response object
 * @param budget - Maximum allowed tokens (defaults to DEFAULT_BUDGET)
 * @returns The response, potentially truncated, with budget metadata
 *
 * @task T4701
 * @epic T4663
 */
export function enforceBudget(
  response: Record<string, unknown>,
  budget?: number,
): { response: Record<string, unknown>; enforcement: BudgetEnforcementResult } {
  const effectiveBudget = budget ?? DEFAULT_BUDGET;

  // Build a proto-envelope stub for the SDK budget checker.
  // The SDK internally uses {_meta, result}, so we bridge from the canonical
  // CLI shape {meta, data} here.
  const protoMeta = (response['meta'] ?? {}) as _ProtoEnvelopeStub['_meta'];
  const envelope: _ProtoEnvelopeStub = {
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

  const enforcement = applyBudgetEnforcement(
    envelope as Parameters<typeof applyBudgetEnforcement>[0],
    effectiveBudget,
    { truncateOnExceed: true },
  );

  // Merge budget info back into the response meta
  const meta = (response['meta'] ?? {}) as Record<string, unknown>;
  meta['_budgetEnforcement'] = {
    budget: effectiveBudget,
    estimatedTokens: enforcement.estimatedTokens,
    withinBudget: enforcement.withinBudget,
    truncated: enforcement.truncated,
  };

  return {
    response: {
      ...response,
      meta,
      // Replace data with potentially truncated result
      ...(enforcement.truncated &&
        enforcement.envelope.result !== undefined && {
          data: enforcement.envelope.result,
        }),
    },
    enforcement,
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
  const protoMeta = (response['meta'] ?? {}) as _ProtoEnvelopeStub['_meta'];
  const envelope: _ProtoEnvelopeStub = {
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
    success: true,
    result: (response['data'] as Record<string, unknown>) ?? null,
  };
  const { exceeded } = checkBudget(envelope as Parameters<typeof checkBudget>[0], effectiveBudget);
  return !exceeded;
}
