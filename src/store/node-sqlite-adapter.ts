/**
 * node:sqlite adapter for drizzle-orm/sqlite-proxy
 *
 * Provides the AsyncRemoteCallback that sqlite-proxy expects, backed by
 * Node.js built-in node:sqlite DatabaseSync. This gives us:
 *
 * - Zero native npm dependencies (uses Node.js built-in node:sqlite)
 * - File-backed SQLite with real WAL mode for multi-process concurrency
 * - 100% cross-platform: Windows, Linux, macOS — no compilation required
 * - Async drizzle API (sqlite-proxy returns Promises)
 *
 * Requires: Node.js >= 24.0.0 (ADR-006, ADR-010)
 *
 * @epic T4817
 */

// Vitest/Vite cannot resolve `node:sqlite` as an ESM import (strips `node:` prefix).
// Use createRequire as the runtime loader; keep type-only import for annotations.
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as { DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync };

/**
 * Open a node:sqlite DatabaseSync with CLEO standard pragmas.
 */
export function openNativeDatabase(path: string, options?: {
  readonly?: boolean;
  timeout?: number;
  enableWal?: boolean;
}): DatabaseSync {
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: true,
    readOnly: options?.readonly ?? false,
    timeout: options?.timeout ?? 5000,
  });

  // Enable WAL for concurrent multi-process access (ADR-006, ADR-010)
  if (options?.enableWal !== false) {
    db.exec('PRAGMA journal_mode=WAL');
  }

  // Standard CLEO pragmas
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');

  return db;
}

/**
 * Create the sqlite-proxy callback that drizzle-orm expects.
 *
 * The callback signature is:
 *   (sql: string, params: any[], method: 'run' | 'all' | 'values' | 'get') => Promise<{ rows: any[] }>
 *
 * We execute synchronous node:sqlite calls and wrap them in a Promise.
 * The actual disk I/O happens synchronously in the Node.js SQLite binding,
 * but from drizzle's perspective this is async.
 */
export function createDrizzleCallback(db: DatabaseSync) {
  return async (
    sql: string,
    params: unknown[],
    method: 'run' | 'all' | 'values' | 'get',
  ): Promise<{ rows: unknown[] }> => {
    const stmt = db.prepare(sql);
    // drizzle passes params as unknown[]; node:sqlite expects SQLInputValue[]
    // The values are always valid SQLite types from drizzle's parameter binding
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = params as any[];

    switch (method) {
      case 'run': {
        const result = stmt.run(...p);
        // sqlite-proxy expects { rows: [] } for run, but we return the result info
        // drizzle wraps this as SqliteRemoteResult
        return { rows: [result] };
      }

      case 'all': {
        // sqlite-proxy expects rows as arrays of arrays: [[col1, col2, ...], ...]
        // node:sqlite returns objects by default; use setReturnArrays(true)
        stmt.setReturnArrays(true);
        const rows = stmt.all(...p);
        return { rows };
      }

      case 'get': {
        // sqlite-proxy expects a single row as flat array: [col1, col2, ...]
        stmt.setReturnArrays(true);
        const row = stmt.get(...p);
        return { rows: row ? [row] : [] };
      }

      case 'values': {
        // Return rows as arrays (same as 'all' with array mode)
        stmt.setReturnArrays(true);
        const rows = stmt.all(...p);
        return { rows };
      }

      default:
        throw new Error(`Unsupported method: ${method}`);
    }
  };
}

/**
 * Create a batch callback for drizzle-orm sqlite-proxy batch operations.
 */
export function createBatchCallback(db: DatabaseSync) {
  return async (
    batch: { sql: string; params: unknown[]; method: 'run' | 'all' | 'values' | 'get' }[],
  ): Promise<{ rows: unknown[] }[]> => {
    const callback = createDrizzleCallback(db);
    const results: { rows: unknown[] }[] = [];
    for (const item of batch) {
      results.push(await callback(item.sql, item.params, item.method));
    }
    return results;
  };
}
