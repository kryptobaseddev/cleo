/**
 * LAFS Token Estimator
 *
 * Provides character-based token estimation for LAFS envelopes and JSON payloads.
 * Uses the approximation: 1 token ≈ 4 characters.
 * Properly handles nested objects, arrays, Unicode graphemes, and circular references.
 */

export interface TokenEstimatorOptions {
  /**
   * Characters per token ratio (default: 4)
   */
  charsPerToken?: number;

  /**
   * Maximum depth to traverse for circular reference detection (default: 100)
   */
  maxDepth?: number;

  /**
   * Maximum string length to process for Unicode grapheme counting (default: 100000)
   */
  maxStringLength?: number;
}

/**
 * Counts Unicode graphemes in a string using Intl.Segmenter when available.
 * Falls back to character counting for environments without Intl.Segmenter.
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
 * Default options for token estimation
 */
const DEFAULT_OPTIONS: Required<TokenEstimatorOptions> = {
  charsPerToken: 4,
  maxDepth: 100,
  maxStringLength: 100000,
};

/**
 * TokenEstimator provides character-based token counting for JSON payloads.
 *
 * Algorithm:
 * 1. Serialize value to JSON (handling circular refs)
 * 2. Count Unicode graphemes (not bytes)
 * 3. Divide by charsPerToken ratio (default 4)
 * 4. Add overhead for structural characters
 */
export class TokenEstimator {
  private options: Required<TokenEstimatorOptions>;

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
   * Serialize value to JSON with circular reference handling.
   * Circular refs are replaced with "[Circular]".
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
   * Create a safe copy of a value with circular refs removed.
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
 */
export const defaultEstimator = new TokenEstimator();

/**
 * Convenience function to estimate tokens for a value.
 */
export function estimateTokens(value: unknown, options?: TokenEstimatorOptions): number {
  const estimator = options ? new TokenEstimator(options) : defaultEstimator;
  return estimator.estimate(value);
}

/**
 * Convenience function to estimate tokens from a JSON string.
 */
export function estimateTokensJSON(json: string, options?: TokenEstimatorOptions): number {
  const estimator = options ? new TokenEstimator(options) : defaultEstimator;
  return estimator.estimateJSON(json);
}
