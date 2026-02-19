/**
 * LAFS token budget enforcement for MCP responses.
 *
 * Wraps the LAFS protocol's applyBudgetEnforcement() to limit MCP
 * response sizes for context-constrained agents.
 *
 * @task T4701
 * @epic T4663
 */

import {
  applyBudgetEnforcement,
  checkBudget,
} from '@cleocode/lafs-protocol';
import type { LAFSEnvelope, BudgetEnforcementResult } from '@cleocode/lafs-protocol';

/**
 * Default token budget when no explicit budget is provided.
 * Standard MVI level allows up to 4000 tokens per response.
 *
 * @task T4701
 */
const DEFAULT_BUDGET = 4000;

/**
 * Apply budget enforcement to an MCP response envelope.
 *
 * Converts the DomainResponse into an LAFSEnvelope shape for budget checking,
 * then applies truncation if the response exceeds the budget.
 *
 * @param response - The MCP domain response object
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

  // Build an LAFSEnvelope-shaped object for the budget checker
  const envelope: LAFSEnvelope = {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: (response['_meta'] as LAFSEnvelope['_meta']) ?? {
      specVersion: '1.2.3',
      schemaVersion: '2026.2.1',
      timestamp: new Date().toISOString(),
      operation: 'mcp.response',
      requestId: 'budget-check',
      transport: 'sdk',
      strict: true,
      mvi: 'standard',
      contextVersion: 1,
    },
    success: (response['success'] as boolean) ?? true,
    result: (response['data'] as Record<string, unknown>) ?? null,
    ...(response['error'] ? { error: response['error'] as LAFSEnvelope['error'] } : {}),
  };

  const enforcement = applyBudgetEnforcement(envelope, effectiveBudget, {
    truncateOnExceed: true,
  });

  // Merge budget info back into the response _meta
  const meta = (response['_meta'] ?? {}) as Record<string, unknown>;
  meta['_budgetEnforcement'] = {
    budget: effectiveBudget,
    estimatedTokens: enforcement.estimatedTokens,
    withinBudget: enforcement.withinBudget,
    truncated: enforcement.truncated,
  };

  return {
    response: {
      ...response,
      _meta: meta,
      // Replace data with potentially truncated result
      ...(enforcement.truncated && enforcement.envelope.result !== undefined && {
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
  const envelope: LAFSEnvelope = {
    $schema: 'https://lafs.dev/schemas/v1/envelope.schema.json',
    _meta: (response['_meta'] as LAFSEnvelope['_meta']) ?? {
      specVersion: '1.2.3',
      schemaVersion: '2026.2.1',
      timestamp: new Date().toISOString(),
      operation: 'mcp.response',
      requestId: 'budget-check',
      transport: 'sdk',
      strict: true,
      mvi: 'standard',
      contextVersion: 1,
    },
    success: true,
    result: (response['data'] as Record<string, unknown>) ?? null,
  };
  const { exceeded } = checkBudget(envelope, effectiveBudget);
  return !exceeded;
}
