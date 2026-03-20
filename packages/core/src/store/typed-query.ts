import type { SQLInputValue, StatementSync } from 'node:sqlite';

/**
 * Type-safe wrapper for {@link StatementSync.all} — centralizes the
 * `as unknown as` cast required by node:sqlite's untyped return type.
 */
export function typedAll<T>(stmt: StatementSync, ...params: SQLInputValue[]): T[] {
  return stmt.all(...params) as unknown as T[];
}

/**
 * Type-safe wrapper for {@link StatementSync.get} — centralizes the
 * `as unknown as` cast required by node:sqlite's untyped return type.
 */
export function typedGet<T>(stmt: StatementSync, ...params: SQLInputValue[]): T | undefined {
  return stmt.get(...params) as unknown as T | undefined;
}
