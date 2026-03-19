/**
 * Central error utilities for CLEO.
 *
 * Provides consistent error handling patterns across the codebase.
 * DRY error formatting, normalization, and transformation utilities.
 *
 * @task T5702
 */

/**
 * Normalize any thrown value into a standardized error object.
 *
 * Handles:
 * - Error instances (preserves stack trace info)
 * - Strings (wraps in Error)
 * - Objects with message property
 * - null/undefined (provides fallback)
 *
 * @param error - The thrown value to normalize
 * @param fallbackMessage - Message to use if error provides none
 * @returns Normalized error with consistent shape
 *
 * @example
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (err) {
 *   const error = normalizeError(err, 'Operation failed');
 *   console.error(error.message);
 * }
 * ```
 */
export function normalizeError(
  error: unknown,
  fallbackMessage = 'An unexpected error occurred',
): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === 'string') {
    return new Error(error);
  }

  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return new Error(error.message);
  }

  return new Error(fallbackMessage);
}

/**
 * Extract a human-readable message from any error value.
 *
 * Safe to use on unknown thrown values without type guards.
 *
 * @param error - The error value
 * @param fallback - Fallback message if extraction fails
 * @returns The error message string
 *
 * @example
 * ```typescript
 * const message = getErrorMessage(err, 'Unknown error');
 * ```
 */
export function getErrorMessage(error: unknown, fallback = 'Unknown error'): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }

  return fallback;
}

/**
 * Format error details for logging or display.
 *
 * Includes stack trace for Error instances when includeStack is true.
 *
 * @param error - The error to format
 * @param context - Optional context to prepend
 * @param includeStack - Whether to include stack traces (default: false)
 * @returns Formatted error string
 *
 * @example
 * ```typescript
 * console.error(formatError(err, 'Database connection'));
 * // Output: [Database connection] Connection refused
 * ```
 */
export function formatError(error: unknown, context?: string, includeStack = false): string {
  const message = getErrorMessage(error);
  const prefix = context ? `[${context}] ` : '';
  let result = `${prefix}${message}`;

  if (includeStack && error instanceof Error && error.stack) {
    result += `\n${error.stack}`;
  }

  return result;
}

/**
 * Check if an error represents a specific error type by code or name.
 *
 * Useful for conditional error handling based on error types.
 *
 * @param error - The error to check
 * @param codeOrName - The error code or name to match
 * @returns True if the error matches
 *
 * @example
 * ```typescript
 * if (isErrorType(err, 'E_NOT_FOUND')) {
 *   // Handle not found specifically
 * }
 * ```
 */
export function isErrorType(error: unknown, codeOrName: string): boolean {
  if (error instanceof Error) {
    if (error.name === codeOrName) {
      return true;
    }
    // Check for custom code property
    if ('code' in error && error.code === codeOrName) {
      return true;
    }
  }
  return false;
}

/**
 * Create a standardized error result object.
 *
 * Common pattern for operations that return { success: boolean, error?: string }
 *
 * @param error - The error value
 * @returns Error result object
 *
 * @example
 * ```typescript
 * return createErrorResult(err);
 * // Returns: { success: false, error: "Something went wrong" }
 * ```
 */
export function createErrorResult(error: unknown): { success: false; error: string } {
  return {
    success: false,
    error: getErrorMessage(error),
  };
}

/**
 * Create a standardized success result object.
 *
 * @returns Success result object
 *
 * @example
 * ```typescript
 * return createSuccessResult();
 * // Returns: { success: true }
 * ```
 */
export function createSuccessResult(): { success: true } {
  return { success: true };
}

/**
 * Type guard for error results.
 *
 * @param result - The result to check
 * @returns True if the result is an error result
 *
 * @example
 * ```typescript
 * const result = await someOperation();
 * if (isErrorResult(result)) {
 *   console.error(result.error);
 * }
 * ```
 */
export function isErrorResult(result: {
  success: boolean;
  error?: string;
}): result is { success: false; error: string } {
  return !result.success;
}
