/**
 * Shared JSON parsing helpers for SQLite store modules.
 *
 * Eliminates duplication across sqlite-data-accessor.ts, task-store.ts,
 * and session-store.ts.
 */
/**
 * Parse a JSON string, returning undefined on null/undefined input or parse error.
 */
export declare function safeParseJson<T>(str: string | null | undefined): T | undefined;
/**
 * Parse a JSON string expected to contain an array.
 * Returns undefined for null/undefined input, empty arrays, or parse errors.
 */
export declare function safeParseJsonArray<T = string>(str: string | null | undefined): T[] | undefined;
//# sourceMappingURL=parsers.d.ts.map