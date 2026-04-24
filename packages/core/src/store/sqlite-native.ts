/**
 * Leaf module for node:sqlite native binding access.
 *
 * This file MUST have no imports that transitively reach back to any CLEO
 * module that participates in the agent-resolver → dispatch-trace →
 * extraction-gate → graph-auto-populate → memory-sqlite → sqlite.ts cycle
 * (see T1325/T1331). Only node builtins are imported below this line.
 *
 * ## Why this exists
 *
 * `sqlite.ts` previously declared `let _DatabaseSyncCtor = null` at module
 * scope. When Vitest eagerly traces the dynamic `import('../memory/dispatch-trace.js')`
 * in `agent-resolver.ts`, it re-enters `sqlite.ts` before the module finishes
 * initializing. Because `let` declarations in ESM are hoisted (TDZ) but not yet
 * initialized at re-entry, any access to `_DatabaseSyncCtor` throws
 * `Cannot access '_DatabaseSyncCtor' before initialization`.
 *
 * The v2 fix moved the constructor cache into this leaf module. The v3 fix
 * (T1331) goes further: `openNativeDatabase` itself now lives here so that
 * `sqlite.ts` has ZERO value-binding imports from `sqlite-native.ts` at module
 * scope. `sqlite.ts` only re-exports this module's symbols — re-exports are
 * live-binding getters (Vite transforms them as property accessors, not `const`
 * bindings), so they cannot be in TDZ during module initialization.
 *
 * ## Invariant
 *
 * This file MUST import ONLY from `node:module` and type-only from `node:sqlite`.
 * Confirm at any time: `grep -n "^import " packages/core/src/store/sqlite-native.ts`
 * must show only those two entries.
 *
 * @module sqlite-native
 * @task T1331
 * @epic T1323
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';

const _require = createRequire(import.meta.url);

/** Re-exported DatabaseSync type for consumers of this leaf module. */
export type DatabaseSync = _DatabaseSyncType;

/**
 * Cached node:sqlite DatabaseSync constructor.
 *
 * Initialized to `null` and populated on first call to
 * {@link getDbSyncConstructor}. Lives in this leaf module (zero CLEO imports)
 * so that the TDZ cycle described above cannot reach it.
 */
let _ctor: (new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync) | null =
  null;

/**
 * Returns the node:sqlite DatabaseSync constructor, loading it on first call.
 *
 * Uses `createRequire` rather than a top-level `import` because Vitest/Vite
 * cannot resolve `node:sqlite` as an ESM import (it strips the `node:` prefix
 * in some environments). The constructor is memoized after the first call.
 *
 * This function is safe to call from module initialization code in `sqlite.ts`
 * and any other consumer because this leaf module has no CLEO imports and
 * therefore cannot participate in a circular-import cycle.
 *
 * @returns The DatabaseSync class constructor from node:sqlite.
 */
export function getDbSyncConstructor(): new (
  ...args: ConstructorParameters<typeof _DatabaseSyncType>
) => DatabaseSync {
  if (_ctor === null) {
    const mod = _require('node:sqlite') as {
      DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
    };
    _ctor = mod.DatabaseSync;
  }
  return _ctor;
}

/**
 * Open a node:sqlite DatabaseSync with CLEO standard pragmas.
 *
 * This function lives in the leaf module (zero CLEO imports) so that callers
 * in the agent-resolver cycle can reach it without triggering a TDZ on any
 * Vite SSR binding. `sqlite.ts` re-exports this symbol — callers that already
 * import from `sqlite.js` continue to work unchanged.
 *
 * CRITICAL: WAL mode is verified, not just requested. If another process holds
 * an EXCLUSIVE lock in DELETE mode, PRAGMA journal_mode=WAL silently returns
 * 'delete'. This caused data loss (T5173) when concurrent processes opened
 * the same database — writes were silently dropped under lock contention.
 *
 * @param path - Absolute path to the SQLite database file.
 * @param options - Optional open settings.
 * @returns An open DatabaseSync instance with WAL and busy_timeout applied.
 * @task T1331
 */
export function openNativeDatabase(
  path: string,
  options?: {
    readonly?: boolean;
    timeout?: number;
    enableWal?: boolean;
    allowExtension?: boolean;
  },
): DatabaseSync {
  const DatabaseSyncCtor = getDbSyncConstructor();
  const db = new DatabaseSyncCtor(path, {
    enableForeignKeyConstraints: true,
    readOnly: options?.readonly ?? false,
    timeout: options?.timeout ?? 5000,
    allowExtension: options?.allowExtension ?? false,
  });

  // Set busy_timeout FIRST so WAL pragma can wait for locks
  db.exec('PRAGMA busy_timeout=5000');

  // Enable WAL for concurrent multi-process access (ADR-006, ADR-010)
  if (options?.enableWal !== false) {
    const MAX_WAL_RETRIES = 3;
    const RETRY_DELAY_MS = 200;
    let walSet = false;

    for (let attempt = 1; attempt <= MAX_WAL_RETRIES; attempt++) {
      db.exec('PRAGMA journal_mode=WAL');

      // CRITICAL: Verify WAL was actually set — the PRAGMA returns the mode
      // that was applied, which may be 'delete' if another connection holds a lock
      const result = db.prepare('PRAGMA journal_mode').get() as Record<string, unknown> | undefined;
      const currentMode = (result?.journal_mode as string)?.toLowerCase?.() ?? 'unknown';

      if (currentMode === 'wal') {
        walSet = true;
        break;
      }

      // WAL not set — another connection likely holds an EXCLUSIVE lock
      if (attempt < MAX_WAL_RETRIES) {
        // Sync sleep via Atomics for retry delay (node:sqlite is sync-only)
        const buf = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(buf), 0, 0, RETRY_DELAY_MS * attempt);
      }
    }

    if (!walSet) {
      // Verify one final time
      const finalResult = db.prepare('PRAGMA journal_mode').get() as
        | Record<string, unknown>
        | undefined;
      const finalMode = (finalResult?.journal_mode as string)?.toLowerCase?.() ?? 'unknown';

      if (finalMode !== 'wal') {
        db.close();
        throw new Error(
          `CRITICAL: Failed to set WAL journal mode after ${MAX_WAL_RETRIES} attempts. ` +
            `Database is in '${finalMode}' mode. Another process likely holds an EXCLUSIVE lock ` +
            `on ${path}. Refusing to open — concurrent writes in DELETE mode cause data loss. ` +
            `Kill other cleo processes and retry. (T5173)`,
        );
      }
    }
  }

  // FK enforcement enabled in production. Disabled in vitest where test
  // fixtures insert data without full referential integrity (orphan refs).
  // VITEST env var is auto-set by vitest — no config needed.
  if (!process.env.VITEST) {
    db.exec('PRAGMA foreign_keys=ON');
  }

  return db;
}
