/**
 * LAFS Budget Enforcement
 *
 * Middleware for enforcing MVI (Minimal Viable Interface) token budgets on LAFS envelopes.
 * Provides budget checking, truncation, and error generation for exceeded budgets.
 */

import { TokenEstimator } from './tokenEstimator.js';
import type {
  BudgetEnforcementOptions,
  BudgetEnforcementResult,
  LAFSEnvelope,
  LAFSError,
  LAFSErrorCategory,
  LAFSMetaWithBudget,
  TokenEstimate,
} from './types.js';

/**
 * Budget exceeded error code from LAFS error registry
 */
const BUDGET_EXCEEDED_CODE = 'E_MVI_BUDGET_EXCEEDED';

/**
 * Default category for budget exceeded errors
 */
const BUDGET_ERROR_CATEGORY: LAFSErrorCategory = 'VALIDATION';

/**
 * Create a budget exceeded error object
 */
function createBudgetExceededError(estimated: number, budget: number): LAFSError {
  return {
    code: BUDGET_EXCEEDED_CODE,
    message: `Response exceeds declared MVI budget: estimated ${estimated} tokens, budget ${budget} tokens`,
    category: BUDGET_ERROR_CATEGORY,
    retryable: false,
    retryAfterMs: null,
    details: {
      estimatedTokens: estimated,
      budgetTokens: budget,
      exceededBy: estimated - budget,
      exceededByPercent: Math.round(((estimated - budget) / budget) * 100),
    },
  };
}

/**
 * Truncate a result to fit within budget.
 * Returns the truncated result and whether truncation occurred.
 */
function truncateResult(
  result: Record<string, unknown> | Record<string, unknown>[] | null,
  targetTokens: number,
  estimator: TokenEstimator,
): { result: Record<string, unknown> | Record<string, unknown>[] | null; wasTruncated: boolean } {
  if (result === null) {
    return { result: null, wasTruncated: false };
  }

  const currentEstimate = estimator.estimate(result);

  // If already within budget, no truncation needed
  if (currentEstimate <= targetTokens) {
    return { result, wasTruncated: false };
  }

  // Calculate target size (conservative: assume 10% overhead)
  const targetChars = Math.floor(targetTokens * 4 * 0.9);

  if (Array.isArray(result)) {
    return truncateArray(result, targetChars, targetTokens, estimator);
  }

  return truncateObject(result, targetChars, targetTokens, estimator);
}

/**
 * Truncate an array to fit within budget.
 */
function truncateArray(
  arr: Record<string, unknown>[],
  targetChars: number,
  targetTokens: number,
  estimator: TokenEstimator,
): { result: Record<string, unknown>[]; wasTruncated: boolean } {
  if (arr.length === 0) {
    return { result: arr, wasTruncated: false };
  }

  // Binary search to find how many items fit
  let left = 0;
  let right = arr.length;
  let bestFit = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const subset = arr.slice(0, mid);
    const estimate = estimator.estimate(subset);

    if (estimate <= targetTokens) {
      bestFit = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  // If we can fit all items, no truncation needed
  if (bestFit >= arr.length) {
    return { result: arr, wasTruncated: false };
  }

  // Create truncated result
  const truncated = arr.slice(0, bestFit);

  // If we couldn't fit any items, return minimal response
  if (bestFit === 0 && arr.length > 0) {
    return {
      result: [{ _truncated: true, reason: 'budget_exceeded' }],
      wasTruncated: true,
    };
  }

  // Add truncation indicator to last element if it's an object
  if (
    bestFit > 0 &&
    typeof truncated[bestFit - 1] === 'object' &&
    truncated[bestFit - 1] !== null
  ) {
    const lastItem = truncated[bestFit - 1] as Record<string, unknown>;
    truncated[bestFit - 1] = {
      ...lastItem,
      _truncated: true,
      remainingItems: arr.length - bestFit,
    };
  }

  return { result: truncated, wasTruncated: true };
}

/**
 * Truncate an object to fit within budget.
 */
function truncateObject(
  obj: Record<string, unknown>,
  targetChars: number,
  targetTokens: number,
  estimator: TokenEstimator,
): { result: Record<string, unknown>; wasTruncated: boolean } {
  const keys = Object.keys(obj);

  if (keys.length === 0) {
    return { result: obj, wasTruncated: false };
  }

  // Try to fit as many top-level properties as possible
  let left = 0;
  let right = keys.length;
  let bestFit = 0;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const subsetKeys = keys.slice(0, mid);
    const subset: Record<string, unknown> = {};
    for (const key of subsetKeys) {
      subset[key] = obj[key];
    }
    const estimate = estimator.estimate(subset);

    if (estimate <= targetTokens) {
      bestFit = mid;
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }

  // If we can fit all properties, no truncation needed
  if (bestFit >= keys.length) {
    return { result: obj, wasTruncated: false };
  }

  // Create truncated result
  const subsetKeys = keys.slice(0, bestFit);
  const truncated: Record<string, unknown> = {};
  for (const key of subsetKeys) {
    truncated[key] = obj[key];
  }

  // If we couldn't fit any properties, return minimal response
  if (bestFit === 0) {
    return {
      result: { _truncated: true, reason: 'budget_exceeded' },
      wasTruncated: true,
    };
  }

  // Add truncation metadata
  truncated._truncated = true;
  truncated._truncatedFields = keys.slice(bestFit);

  return { result: truncated, wasTruncated: true };
}

/**
 * Apply budget enforcement to an envelope.
 *
 * @param envelope - The LAFS envelope to check
 * @param budget - Maximum allowed tokens
 * @param options - Budget enforcement options
 * @returns Enforce result with potentially modified envelope
 */
export function applyBudgetEnforcement(
  envelope: LAFSEnvelope,
  budget: number,
  options: BudgetEnforcementOptions = {},
): BudgetEnforcementResult {
  const { truncateOnExceed = false, onBudgetExceeded } = options;
  const estimator = new TokenEstimator();

  // Estimate the result payload
  const estimatedTokens = estimator.estimate(envelope.result);

  // Add estimate to metadata
  const tokenEstimate: TokenEstimate = {
    estimated: estimatedTokens,
  };

  // Check if within budget
  const withinBudget = estimatedTokens <= budget;

  // If within budget, just add the estimate to metadata
  if (withinBudget) {
    return {
      envelope: {
        ...envelope,
        _meta: {
          ...envelope._meta,
          _tokenEstimate: tokenEstimate,
        } as LAFSMetaWithBudget,
      },
      withinBudget: true,
      estimatedTokens,
      budget,
      truncated: false,
    };
  }

  // Budget exceeded - call callback if provided
  if (onBudgetExceeded) {
    onBudgetExceeded(estimatedTokens, budget);
  }

  // If truncation is enabled, try to truncate
  if (truncateOnExceed) {
    const { result, wasTruncated } = truncateResult(envelope.result, budget, estimator);
    const truncatedEstimate = estimator.estimate(result);

    if (truncatedEstimate <= budget) {
      return {
        envelope: {
          ...envelope,
          result,
          _meta: {
            ...envelope._meta,
            _tokenEstimate: {
              estimated: truncatedEstimate,
              truncated: true,
              originalEstimate: estimatedTokens,
            },
          } as LAFSMetaWithBudget,
        },
        withinBudget: true,
        estimatedTokens: truncatedEstimate,
        budget,
        truncated: true,
      };
    }
  }

  // Return budget exceeded error
  return {
    envelope: {
      ...envelope,
      success: false,
      result: null,
      error: createBudgetExceededError(estimatedTokens, budget),
      _meta: {
        ...envelope._meta,
        _tokenEstimate: tokenEstimate,
      } as LAFSMetaWithBudget,
    },
    withinBudget: false,
    estimatedTokens,
    budget,
    truncated: false,
  };
}

/**
 * Type for middleware function
 */
type EnvelopeMiddleware = (
  envelope: LAFSEnvelope,
  next: () => LAFSEnvelope | Promise<LAFSEnvelope>,
) => Promise<LAFSEnvelope> | LAFSEnvelope;

/**
 * Create a budget enforcement middleware function.
 *
 * @param budget - Maximum allowed tokens for response
 * @param options - Budget enforcement options
 * @returns Middleware function that enforces budget
 *
 * @example
 * ```typescript
 * const middleware = withBudget(1000, { truncateOnExceed: true });
 * const result = await middleware(envelope, async () => nextEnvelope);
 * ```
 */
export function withBudget(
  budget: number,
  options: BudgetEnforcementOptions = {},
): EnvelopeMiddleware {
  return async (
    envelope: LAFSEnvelope,
    next: () => LAFSEnvelope | Promise<LAFSEnvelope>,
  ): Promise<LAFSEnvelope> => {
    // Execute next middleware/handler
    const result = await next();

    // Apply budget enforcement to the result
    const enforcement = applyBudgetEnforcement(result, budget, options);

    return enforcement.envelope;
  };
}

/**
 * Check if an envelope has exceeded its budget without modifying it.
 *
 * @param envelope - The LAFS envelope to check
 * @param budget - Maximum allowed tokens
 * @returns Budget check result
 */
export function checkBudget(
  envelope: LAFSEnvelope,
  budget: number,
): { exceeded: boolean; estimated: number; remaining: number } {
  const estimator = new TokenEstimator();
  const estimated = estimator.estimate(envelope.result);

  return {
    exceeded: estimated > budget,
    estimated,
    remaining: Math.max(0, budget - estimated),
  };
}

/**
 * Synchronous version of withBudget for non-async contexts.
 *
 * @param budget - Maximum allowed tokens for response
 * @param options - Budget enforcement options
 * @returns Middleware function that enforces budget synchronously
 */
export function withBudgetSync(
  budget: number,
  options: BudgetEnforcementOptions = {},
): (envelope: LAFSEnvelope, next: () => LAFSEnvelope) => LAFSEnvelope {
  return (envelope: LAFSEnvelope, next: () => LAFSEnvelope): LAFSEnvelope => {
    const result = next();
    const enforcement = applyBudgetEnforcement(result, budget, options);
    return enforcement.envelope;
  };
}

/**
 * Higher-order function that wraps a handler with budget enforcement.
 *
 * @param handler - The handler function to wrap
 * @param budget - Maximum allowed tokens
 * @param options - Budget enforcement options
 * @returns Wrapped handler with budget enforcement
 *
 * @example
 * ```typescript
 * const myHandler = async (request: Request) => ({ success: true, result: { data } });
 * const budgetedHandler = wrapWithBudget(myHandler, 1000, { truncateOnExceed: true });
 * const result = await budgetedHandler(request);
 * ```
 */
export function wrapWithBudget<TArgs extends unknown[], TResult extends LAFSEnvelope>(
  handler: (...args: TArgs) => TResult | Promise<TResult>,
  budget: number,
  options: BudgetEnforcementOptions = {},
): (...args: TArgs) => Promise<LAFSEnvelope> {
  return async (...args: TArgs): Promise<LAFSEnvelope> => {
    const result = await handler(...args);
    const enforcement = applyBudgetEnforcement(result, budget, options);
    return enforcement.envelope;
  };
}

/**
 * Compose multiple middleware functions into a single middleware.
 * Middleware is executed in order (left to right).
 */
export function composeMiddleware(...middlewares: EnvelopeMiddleware[]): EnvelopeMiddleware {
  return async (
    envelope: LAFSEnvelope,
    next: () => LAFSEnvelope | Promise<LAFSEnvelope>,
  ): Promise<LAFSEnvelope> => {
    const _index = 0;

    async function dispatch(i: number): Promise<LAFSEnvelope> {
      if (i >= middlewares.length) {
        return next();
      }

      const middleware = middlewares[i];
      if (!middleware) {
        return dispatch(i + 1);
      }

      return middleware(envelope, () => dispatch(i + 1));
    }

    return dispatch(0);
  };
}

// Re-export types for convenience
export type { BudgetEnforcementOptions, BudgetEnforcementResult, TokenEstimate };
export { BUDGET_EXCEEDED_CODE, TokenEstimator };
