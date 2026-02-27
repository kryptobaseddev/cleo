/**
 * Shared JSON parsing helpers for SQLite store modules.
 *
 * Eliminates duplication across sqlite-data-accessor.ts, task-store.ts,
 * and session-store.ts.
 */

/**
 * Parse a JSON string, returning undefined on null/undefined input or parse error.
 */
export function safeParseJson<T>(str: string | null | undefined): T | undefined {
  if (!str) return undefined;
  try {
    return JSON.parse(str) as T;
  } catch {
    return undefined;
  }
}

/**
 * Parse a JSON string expected to contain an array.
 * Returns undefined for null/undefined input, empty arrays, or parse errors.
 */
export function safeParseJsonArray<T = string>(str: string | null | undefined): T[] | undefined {
  if (!str) return undefined;
  try {
    const arr = JSON.parse(str);
    if (Array.isArray(arr) && arr.length === 0) return undefined;
    return arr as T[];
  } catch {
    return undefined;
  }
}
