/**
 * LAFS Token Estimator
 *
 * Provides character-based token estimation for LAFS envelopes and JSON payloads.
 * Uses the approximation: 1 token ≈ 4 characters.
 * Properly handles nested objects, arrays, Unicode graphemes, and circular references.
 */

/**
 * Configuration options for the token estimator.
 *
 * @remarks
 * All options have sensible defaults. Override individual fields to tune
 * estimation accuracy or performance for specific workloads.
 *
 * @example
 * ```typescript
 * const opts: TokenEstimatorOptions = {
 *   charsPerToken: 3.5,
 *   maxDepth: 50,
 * };
 * ```
 */
export interface TokenEstimatorOptions {
  /**
   * Characters per token ratio.
   * @defaultValue `4`
   */
  charsPerToken?: number;

  /**
   * Maximum depth to traverse for circular reference detection.
   * @defaultValue `100`
   */
  maxDepth?: number;

  /**
   * Maximum string length to process for Unicode grapheme counting.
   * @defaultValue `100000`
   */
  maxStringLength?: number;
}

/**
 * Count Unicode graphemes in a string.
 *
 * @param str - Input string to count
 * @returns Number of grapheme clusters in the string
 *
 * @remarks
 * Uses `Intl.Segmenter` when available (Node.js 16+, modern browsers) for
 * accurate grapheme counting. Falls back to spread-based code-point counting
 * which handles surrogate pairs but not all grapheme clusters.
 */
function countGraphemes(str: string): number {
  // Use Intl.Segmenter for proper grapheme counting (Node.js 16+, modern browsers)
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(str)).length;
  }

  // Fallback: count code points using spread operator (handles surrogate pairs)
  return [...str].length;
}

/**
 * Default options for token estimation.
 *
 * @remarks
 * These values represent the baseline configuration used when no overrides
 * are provided to the {@link TokenEstimator} constructor.
 */
const DEFAULT_OPTIONS: Required<TokenEstimatorOptions> = {
  charsPerToken: 4,
  maxDepth: 100,
  maxStringLength: 100000,
};

/**
 * Character-based token estimator for JSON payloads.
 *
 * @remarks
 * Algorithm:
 * 1. Recursively traverse the value (handling circular refs via WeakSet)
 * 2. Count Unicode graphemes (not bytes) for string content
 * 3. Divide by `charsPerToken` ratio (default 4)
 * 4. Add overhead for structural JSON characters
 *
 * The estimator is intentionally conservative to avoid underestimating budget usage.
 *
 * @example
 * ```typescript
 * const estimator = new TokenEstimator({ charsPerToken: 4 });
 * const tokens = estimator.estimate({ name: "hello", items: [1, 2, 3] });
 * ```
 */
export class TokenEstimator {
  /** Resolved configuration with defaults applied */
  private options: Required<TokenEstimatorOptions>;

  /**
   * Create a new TokenEstimator.
   *
   * @param options - Configuration overrides (merged with defaults)
   */
  constructor(options: TokenEstimatorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Estimate tokens for any JavaScript value.
   * Handles circular references, nested objects, arrays, and Unicode.
   *
   * @param value - Any value to estimate
   * @returns Estimated token count
   */
  estimate(value: unknown): number {
    return this.estimateWithTracking(value, new WeakSet(), 0);
  }

  /**
   * Estimate tokens from a JSON string.
   * More efficient if you already have the JSON string.
   *
   * @param json - JSON string to estimate
   * @returns Estimated token count
   */
  estimateJSON(json: string): number {
    // Count graphemes in the JSON string
    const graphemes = countGraphemes(json);
    // Add overhead for JSON structure (brackets, quotes, colons, etc.)
    const structuralOverhead = Math.ceil(graphemes * 0.1);
    return Math.ceil((graphemes + structuralOverhead) / this.options.charsPerToken);
  }

  /**
   * Internal recursive estimation with circular reference tracking.
   *
   * @param value - Value to estimate
   * @param seen - WeakSet tracking visited objects for circular reference detection
   * @param depth - Current recursion depth
   * @returns Estimated token count for this value
   */
  private estimateWithTracking(value: unknown, seen: WeakSet<object>, depth: number): number {
    // Prevent infinite recursion
    if (depth > this.options.maxDepth) {
      return 1; // Minimal cost for max depth exceeded
    }

    // Handle null
    if (value === null) {
      return 1; // "null" = 4 chars / 4 = 1 token
    }

    // Handle undefined
    if (value === undefined) {
      return 1;
    }

    // Handle primitives
    const type = typeof value;
    if (type === 'boolean') {
      return value ? 1 : 1; // "true" or "false" ≈ 1 token
    }

    if (type === 'number') {
      const str = String(value);
      return Math.ceil(countGraphemes(str) / this.options.charsPerToken);
    }

    if (type === 'string') {
      const str = value as string;
      // Limit string length to prevent performance issues
      const truncated =
        str.length > this.options.maxStringLength
          ? str.slice(0, this.options.maxStringLength) + '…'
          : str;
      const graphemes = countGraphemes(truncated);
      // Add 2 for quotes
      return Math.ceil((graphemes + 2) / this.options.charsPerToken);
    }

    // Handle objects and arrays
    if (type === 'object') {
      const obj = value as Record<string, unknown>;

      // Check for circular reference
      if (seen.has(obj)) {
        return 1; // Minimal cost for circular ref placeholder
      }

      seen.add(obj);

      try {
        if (Array.isArray(obj)) {
          return this.estimateArray(obj, seen, depth);
        }

        return this.estimateObject(obj, seen, depth);
      } finally {
        seen.delete(obj);
      }
    }

    // Handle symbols, functions, etc.
    return 1;
  }

  /**
   * Estimate tokens for an array.
   *
   * @param arr - Array to estimate
   * @param seen - WeakSet tracking visited objects
   * @param depth - Current recursion depth
   * @returns Estimated token count including brackets and separators
   */
  private estimateArray(arr: unknown[], seen: WeakSet<object>, depth: number): number {
    let tokens = 1; // Opening bracket [ (already counted as structural)

    for (let i = 0; i < arr.length; i++) {
      tokens += this.estimateWithTracking(arr[i], seen, depth + 1);

      // Add comma separator (except for last element)
      if (i < arr.length - 1) {
        tokens += 1; // comma + space ≈ 2 chars / 4 = 0.5, round up to 1
      }
    }

    tokens += 1; // Closing bracket ]

    return tokens;
  }

  /**
   * Estimate tokens for a plain object.
   *
   * @param obj - Object to estimate
   * @param seen - WeakSet tracking visited objects
   * @param depth - Current recursion depth
   * @returns Estimated token count including braces, keys, colons, and separators
   */
  private estimateObject(
    obj: Record<string, unknown>,
    seen: WeakSet<object>,
    depth: number,
  ): number {
    let tokens = 1; // Opening brace {
    const keys = Object.keys(obj);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const value = obj[key];

      // Estimate key (with quotes)
      tokens += Math.ceil((countGraphemes(key) + 2) / this.options.charsPerToken);

      // Colon separator
      tokens += 1; // " : " ≈ 3 chars / 4 = 0.75, round up to 1

      // Estimate value
      tokens += this.estimateWithTracking(value, seen, depth + 1);

      // Comma separator (except for last property)
      if (i < keys.length - 1) {
        tokens += 1; // comma + space ≈ 2 chars / 4 = 0.5, round up to 1
      }
    }

    tokens += 1; // Closing brace }

    return tokens;
  }

  /**
   * Check if a value can be safely serialized (no circular refs).
   *
   * @param value - Value to check
   * @returns `true` if `JSON.stringify` succeeds without throwing
   */
  canSerialize(value: unknown): boolean {
    try {
      JSON.stringify(value);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Serialize a value to JSON with circular reference handling.
   *
   * @param value - Value to serialize
   * @returns JSON string with circular references replaced by `"[Circular]"`
   */
  safeStringify(value: unknown): string {
    const seen = new WeakSet();

    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) {
          return '[Circular]';
        }
        seen.add(val);
      }
      return val;
    });
  }

  /**
   * Create a deep copy of a value with circular refs replaced by `"[Circular]"`.
   *
   * @param value - Value to copy
   * @returns Deep clone with all circular references replaced
   */
  safeCopy<T>(value: T): T {
    const seen = new WeakSet();

    function clone(val: unknown): unknown {
      if (val === null || typeof val !== 'object') {
        return val;
      }

      if (seen.has(val)) {
        return '[Circular]';
      }

      seen.add(val);

      try {
        if (Array.isArray(val)) {
          return val.map(clone);
        }

        const result: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val)) {
          result[k] = clone(v);
        }
        return result;
      } finally {
        seen.delete(val);
      }
    }

    return clone(value) as T;
  }
}

/**
 * Global token estimator instance with default settings.
 *
 * @remarks
 * Reuses a single estimator instance to avoid repeated object allocation.
 * All default {@link TokenEstimatorOptions} values apply.
 */
export const defaultEstimator = new TokenEstimator();

/**
 * Convenience function to estimate tokens for a value.
 *
 * @param value - Any JavaScript value to estimate
 * @param options - Optional estimator configuration overrides
 * @returns Estimated token count
 *
 * @remarks
 * Uses the global {@link defaultEstimator} when no options are provided.
 * Creates a new estimator instance when custom options are given.
 *
 * @example
 * ```typescript
 * const tokens = estimateTokens({ data: [1, 2, 3] });
 * ```
 */
export function estimateTokens(value: unknown, options?: TokenEstimatorOptions): number {
  const estimator = options ? new TokenEstimator(options) : defaultEstimator;
  return estimator.estimate(value);
}

/**
 * Convenience function to estimate tokens from a JSON string.
 *
 * @param json - Pre-serialized JSON string
 * @param options - Optional estimator configuration overrides
 * @returns Estimated token count
 *
 * @remarks
 * More efficient than {@link estimateTokens} when you already have the
 * JSON string, since it skips the serialization step.
 *
 * @example
 * ```typescript
 * const tokens = estimateTokensJSON('{"key": "value"}');
 * ```
 */
export function estimateTokensJSON(json: string, options?: TokenEstimatorOptions): number {
  const estimator = options ? new TokenEstimator(options) : defaultEstimator;
  return estimator.estimateJSON(json);
}
