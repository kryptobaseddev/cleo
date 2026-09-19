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
 * Budget exceeded error code from LAFS error registry.
 *
 * @remarks
 * Used as the `code` field in {@link LAFSError} when a response exceeds
 * its declared MVI token budget.
 */
const BUDGET_EXCEEDED_CODE = 'E_MVI_BUDGET_EXCEEDED';

/**
 * Default category for budget exceeded errors.
 *
 * @remarks
 * Budget violations are treated as validation errors since they represent
 * a contract violation between the caller's budget declaration and the response size.
 */
const BUDGET_ERROR_CATEGORY: LAFSErrorCategory = 'VALIDATION';

/**
 * Create a budget exceeded error object.
 *
 * @param estimated - Estimated token count of the response
 * @param budget - Maximum allowed token count
 * @returns A {@link LAFSError} with code `E_MVI_BUDGET_EXCEEDED` and detailed metadata
 *
 * @remarks
 * The error details include the exact token counts, the absolute overage,
 * and the percentage by which the budget was exceeded.
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
 * Measure the UTF-8 content bytes disclosed for an omitted field.
 * Strings use their content bytes; structured values use serialized JSON bytes.
 * @param value - Original field value.
 * @returns UTF-8 byte count, or zero for an undefined value.
 */
export function projectionFieldBytes<T>(value: T): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? 0 : new TextEncoder().encode(text).byteLength;
}

/**
 * Truncate a result to fit within a token budget.
 *
 * @param result - The result payload (object, array, or `null`)
 * @param targetTokens - Maximum allowed token count
 * @param estimator - Token estimator instance for measuring sizes
 * @returns Object containing the truncated result and a flag indicating if truncation occurred
 *
 * @remarks
 * Delegates to array or object-specific truncation strategies. Arrays are
 * truncated by removing trailing items via binary search; objects are truncated
 * by removing trailing top-level keys.
 */
function truncateResult(
  result: Record<string, unknown> | Record<string, unknown>[] | null,
  targetTokens: number,
  estimator: TokenEstimator,
  requiredFields: readonly string[],
): { result: Record<string, unknown> | Record<string, unknown>[] | null; wasTruncated: boolean } {
  if (result === null) {
    return { result: null, wasTruncated: false };
  }

  const currentEstimate = estimator.estimate(result);

  // If already within budget, no truncation needed
  if (currentEstimate <= targetTokens) {
    return { result, wasTruncated: false };
  }

  if (Array.isArray(result)) {
    return truncateArray(result, targetTokens, estimator);
  }

  return truncateObject(result, targetTokens, estimator, requiredFields);
}

/**
 * Truncate an array to fit within a token budget.
 *
 * @param arr - Array of result objects
 * @param targetTokens - Target token budget
 * @param estimator - Token estimator instance
 * @returns Object containing the truncated array and a flag indicating if truncation occurred
 *
 * @remarks
 * Uses binary search to find the maximum number of items that fit within
 * the budget. Appends `_truncated` and `remainingItems` metadata to the
 * last item when truncation occurs.
 */
function truncateArray(
  arr: Record<string, unknown>[],
  targetTokens: number,
  estimator: TokenEstimator,
): { result: Record<string, unknown>[]; wasTruncated: boolean } {
  if (arr.length === 0) {
    return { result: arr, wasTruncated: false };
  }

  const withDisclosure = (count: number): Record<string, unknown>[] => {
    if (count === 0)
      return [{ _truncated: true, remainingItems: arr.length, reason: 'budget_exceeded' }];
    const subset = arr.slice(0, count);
    subset[count - 1] = {
      ...subset[count - 1],
      _truncated: true,
      remainingItems: arr.length - count,
    };
    return subset;
  };
  // Include disclosure in every estimate; appending it afterward can exceed
  // the budget even when a smaller honest subset would fit.
  let left = 0;
  let right = arr.length - 1;
  let bestFit = -1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (estimator.estimate(withDisclosure(mid)) <= targetTokens) {
      bestFit = mid;
      left = mid + 1;
    } else right = mid - 1;
  }
  return bestFit < 0
    ? { result: arr, wasTruncated: false }
    : { result: withDisclosure(bestFit), wasTruncated: true };
}

/**
 * Truncate an object to fit within a token budget.
 *
 * @param obj - Object to truncate
 * @param targetTokens - Target token budget
 * @param estimator - Token estimator instance
 * @returns Object containing the truncated object and a flag indicating if truncation occurred
 *
 * @remarks
 * Uses binary search over the object's keys to find the maximum number of
 * top-level properties that fit within the budget. Truncated results include
 * `_truncated` and `_truncatedFields` metadata.
 */
function truncateObject(
  obj: Record<string, unknown>,
  targetTokens: number,
  estimator: TokenEstimator,
  requiredFields: readonly string[],
): { result: Record<string, unknown>; wasTruncated: boolean } {
  const mandatory = new Set([
    'id',
    '_withheld',
    '_truncated',
    '_truncatedFields',
    'remainingItems',
    ...requiredFields,
  ]);
  const candidate = { ...obj };
  const withheld: Record<string, number> = {};
  const previous = obj['_withheld'];
  if (previous && typeof previous === 'object' && !Array.isArray(previous)) {
    for (const [key, size] of Object.entries(previous)) {
      if (typeof size === 'number') withheld[key] = size;
    }
  }
  const droppable = Object.keys(obj).filter((key) => !mandatory.has(key));
  const omitted = Array.isArray(obj['_truncatedFields'])
    ? obj['_truncatedFields'].filter((field): field is string => typeof field === 'string')
    : [];
  for (const key of droppable.reverse()) {
    withheld[key] = projectionFieldBytes(obj[key]);
    delete candidate[key];
    omitted.push(key);
    const marked = {
      ...candidate,
      _withheld: { ...withheld },
      _truncated: true,
      _truncatedFields: [...omitted],
    };
    if (estimator.estimate(marked) <= targetTokens) {
      return { result: marked, wasTruncated: true };
    }
  }
  // Never emit a successful record that loses mandatory facts or disclosure.
  // Keeping the original over-budget result makes the caller return its
  // established E_MVI_BUDGET_EXCEEDED envelope.
  return { result: obj, wasTruncated: false };
}

/**
 * Apply budget enforcement to an envelope.
 *
 * @param envelope - The LAFS envelope to check
 * @param budget - Maximum allowed token count
 * @param options - Budget enforcement options (truncation, callbacks)
 * @returns Enforcement result with the (possibly modified) envelope, budget status, and token estimates
 *
 * @remarks
 * When the envelope is within budget, the token estimate is attached to metadata.
 * When exceeded, behavior depends on `options.truncateOnExceed`: if enabled,
 * truncation is attempted first; otherwise, the result is replaced with a
 * budget-exceeded error. The `onBudgetExceeded` callback fires before truncation.
 *
 * @example
 * ```typescript
 * const result = applyBudgetEnforcement(envelope, 1000, { truncateOnExceed: true });
 * if (!result.withinBudget) {
 *   console.warn("Budget exceeded:", result.estimatedTokens);
 * }
 * ```
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
          // T9923 (Saga T9855 / E8): first-class field is `tokens`;
          // `_tokenEstimate` retained for ONE release (removeAt v2026.7.0).
          tokens: tokenEstimate,
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
    const { result } = truncateResult(
      envelope.result,
      budget,
      estimator,
      options.requiredFields ?? [],
    );
    const truncatedEstimate = estimator.estimate(result);

    if (truncatedEstimate <= budget) {
      const truncatedTokenEstimate: TokenEstimate = {
        estimated: truncatedEstimate,
        truncated: true,
        originalEstimate: estimatedTokens,
      };
      return {
        envelope: {
          ...envelope,
          result,
          _meta: {
            ...envelope._meta,
            // T9923: first-class `tokens` + legacy `_tokenEstimate`.
            tokens: truncatedTokenEstimate,
            _tokenEstimate: truncatedTokenEstimate,
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
        // T9923: first-class `tokens` + legacy `_tokenEstimate`.
        tokens: tokenEstimate,
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
 * Type for envelope middleware function.
 *
 * @remarks
 * Middleware functions receive an envelope and a `next` callback, enabling
 * pre- and post-processing of LAFS envelopes in a pipeline.
 */
type EnvelopeMiddleware = (
  envelope: LAFSEnvelope,
  next: () => LAFSEnvelope | Promise<LAFSEnvelope>,
) => Promise<LAFSEnvelope> | LAFSEnvelope;

/**
 * Create a budget enforcement middleware function.
 *
 * @param budget - Maximum allowed token count for the response
 * @param options - Budget enforcement options (truncation, callbacks)
 * @returns Async middleware function that enforces the token budget
 *
 * @remarks
 * Wraps the next handler in the chain, applying {@link applyBudgetEnforcement}
 * to its output. The returned envelope may be truncated or replaced with an
 * error depending on the enforcement result.
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
 * @param budget - Maximum allowed token count
 * @returns Object with `exceeded` flag, `estimated` token count, and `remaining` budget
 *
 * @remarks
 * A read-only budget check that does not alter the envelope. Useful for
 * pre-flight checks or logging before deciding how to handle overages.
 *
 * @example
 * ```typescript
 * const { exceeded, estimated, remaining } = checkBudget(envelope, 500);
 * if (exceeded) {
 *   console.warn(`Over budget by ${estimated - 500} tokens`);
 * }
 * ```
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
 * @param budget - Maximum allowed token count for the response
 * @param options - Budget enforcement options (truncation, callbacks)
 * @returns Synchronous middleware function that enforces the token budget
 *
 * @remarks
 * Identical to {@link withBudget} but operates synchronously. Use this when the
 * next handler in the chain is guaranteed to return synchronously.
 *
 * @example
 * ```typescript
 * const middleware = withBudgetSync(500);
 * const result = middleware(envelope, () => nextEnvelope);
 * ```
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
 * @typeParam TArgs - Tuple type representing the handler's parameter list
 * @typeParam TResult - Return type of the handler, must extend LAFSEnvelope
 * @param handler - The handler function to wrap with budget enforcement
 * @param budget - Maximum allowed tokens
 * @param options - Budget enforcement options
 * @returns Wrapped handler with budget enforcement
 *
 * @remarks
 * The returned function has the same parameter signature as the original handler
 * but always returns a `Promise<LAFSEnvelope>`. When the budget is exceeded and
 * `truncateOnExceed` is enabled, the envelope is truncated to fit; otherwise an
 * `E_MVI_BUDGET_EXCEEDED` error envelope is returned.
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
 *
 * @param middlewares - Middleware functions to compose (executed left to right)
 * @returns A single middleware function that chains all provided middlewares
 *
 * @remarks
 * Middleware is executed in array order (left to right). Each middleware receives
 * the envelope and a `next` function that invokes the subsequent middleware.
 * The final middleware's `next` call invokes the original terminal handler.
 *
 * @example
 * ```typescript
 * const pipeline = composeMiddleware(
 *   withBudget(1000),
 *   loggingMiddleware,
 * );
 * const result = await pipeline(envelope, () => finalEnvelope);
 * ```
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
