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
 * Moving the constructor cache into this leaf module eliminates the TDZ cycle
 * because:
 * 1. This file has zero CLEO imports — the cycle cannot re-enter it.
 * 2. `sqlite.ts`'s import of this file is a terminal edge (no back-edge to
 *    any node in the cycle).
 * 3. `let _ctor` here is in a module that is fully initialized before
 *    `sqlite.ts` begins its own initialization.
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
