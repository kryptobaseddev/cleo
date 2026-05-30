/**
 * MVI token-budget enforcement middleware — the LIVE dispatch chokepoint.
 *
 * Before T11350 the LAFS budget engine (`@cleocode/lafs/budgetEnforcement` via
 * `packages/cleo/src/dispatch/lib/budget.ts`) had ZERO non-test callers — it
 * was dead code. This middleware wires it into the real CLI dispatch response
 * pipeline so that over-budget envelopes are truncated (or rejected with
 * `E_MVI_BUDGET_EXCEEDED`) per the configured {@link BudgetPolicy}.
 *
 * Placement: runs AFTER the MVI record-projection + mutate-minimal-envelope
 * middleware (so it measures the already-trimmed payload) but BEFORE audit +
 * telemetry (so they record the final, budget-enforced byte size).
 *
 * Per-operation ceilings (e.g. `cleo focus` ≤ 1500 tokens) come from
 * {@link BUDGET_POLICIES}; operations without a policy entry pass through
 * untouched — the chokepoint is opt-in by op so we never silently truncate a
 * response that was not designed to be windowed.
 *
 * @module @cleocode/cleo/dispatch/middleware/budget-enforcement
 *
 * @task T11350
 * @task T11352
 * @epic T11285 EP-MVI-PRIMITIVE
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import { ExitCode } from '@cleocode/contracts';
import { BUDGET_EXCEEDED_CODE, type EnforceBudgetOptions, enforceBudget } from '../lib/budget.js';
import { BUDGET_POLICIES, type BudgetPolicy } from '../lib/budget-ceilings.js';
import type { DispatchError, DispatchRequest, DispatchResponse, Middleware } from '../types.js';

/**
 * Resolve the {@link BudgetPolicy} for a request, if any.
 *
 * A per-request override carried as `req.params._budget` (a positive number)
 * wins — used by integration tests and any internal caller that wants to drive
 * the chokepoint without a registered policy. Otherwise the canonical
 * `<domain>.<operation>` policy from {@link BUDGET_POLICIES} applies.
 *
 * @param req - The dispatch request.
 * @returns The resolved policy, or `undefined` when the op is not enforced.
 */
function resolvePolicy(req: DispatchRequest): BudgetPolicy | undefined {
  const override = req.params?.['_budget'];
  if (typeof override === 'number' && override > 0) {
    const modeOverride = req.params?.['_budgetMode'];
    const mode =
      modeOverride === 'error' || modeOverride === 'truncate' ? modeOverride : 'truncate';
    return { budget: override, mode };
  }
  const opKey = `${req.domain}.${req.operation}`;
  return BUDGET_POLICIES[opKey];
}

/**
 * Build a budget-exceeded {@link DispatchError} from an enforcement result.
 *
 * @param details - The `_budgetEnforcement` meta block produced by
 *   {@link enforceBudget}.
 * @returns A `DispatchError` carrying `E_MVI_BUDGET_EXCEEDED`.
 */
function budgetExceededError(details: Record<string, unknown>): DispatchError {
  const estimated = typeof details['estimatedTokens'] === 'number' ? details['estimatedTokens'] : 0;
  const budget = typeof details['budget'] === 'number' ? details['budget'] : 0;
  return {
    code: BUDGET_EXCEEDED_CODE,
    exitCode: ExitCode.VALIDATION_ERROR,
    message: `Response exceeds declared MVI budget: estimated ${estimated} tokens, budget ${budget} tokens`,
    details,
    fix: 'Request a narrower view (e.g. add --limit, --field, or a tighter --mvi level) or raise the budget.',
  };
}

/**
 * Create the MVI budget-enforcement middleware.
 *
 * @returns A `Middleware` that enforces {@link BUDGET_POLICIES} (plus the
 *   per-request `_budget` override) on successful responses.
 *
 * @task T11350
 */
export function createBudgetEnforcement(): Middleware {
  return async (
    req: DispatchRequest,
    next: () => Promise<DispatchResponse>,
  ): Promise<DispatchResponse> => {
    const policy = resolvePolicy(req);

    // Strip the override tokens so domain handlers never see them.
    if (req.params) {
      if ('_budget' in req.params) delete req.params['_budget'];
      if ('_budgetMode' in req.params) delete req.params['_budgetMode'];
    }

    const response = await next();

    // Only enforce on successful responses with a payload and a policy.
    if (!policy || !response.success || response.data === undefined) {
      return response;
    }

    const options: EnforceBudgetOptions = { budget: policy.budget, mode: policy.mode };
    const { response: enforced, exceeded } = enforceBudget(
      // Bridge the canonical DispatchResponse into the Record shape enforceBudget
      // consumes. Field names (meta/data/success) match 1:1.
      { meta: response.meta, data: response.data, success: response.success },
      options,
    );

    // Carry the (possibly truncated) data + the _budgetEnforcement meta back.
    const enforcedData = enforced['data'];
    const enforcedMeta = (enforced['meta'] ?? response.meta) as DispatchResponse['meta'];

    if (exceeded) {
      // Overflow that truncation could not (or was told not to) resolve.
      const beDetails = (enforcedMeta['_budgetEnforcement'] ?? {}) as Record<string, unknown>;
      return {
        ...response,
        meta: enforcedMeta,
        success: false,
        data: null,
        error: budgetExceededError(beDetails),
      };
    }

    response.meta = enforcedMeta;
    if (enforcedData !== undefined) {
      response.data = enforcedData;
    }
    return response;
  };
}
