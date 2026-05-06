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
 * This file MUST NOT import any CLEO module — only `node:` builtins. The
 * leaf-module rule prevents the agent-resolver TDZ cycle from re-entering
 * partially-initialised state. Node builtins (fs, os, path, module) do not
 * participate in any CLEO cycle and are therefore safe.
 *
 * @module sqlite-native
 * @task T1331
 * @epic T1323
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
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
 * Resolve a path to its real, absolute form. Falls back to a non-realpath
 * absolute resolution when the file does not exist yet (the common case for
 * a fresh tasks.db about to be created).
 */
function resolveAbsoluteSafe(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Returns true when `child` is the same path as `parent` or nested under it. */
function isPathUnder(child: string, parent: string): boolean {
  if (child === parent) return true;
  const withSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(withSep);
}

/**
 * Vitest production-DB leak guard.
 *
 * Under `process.env.VITEST`, refuses to open any SQLite path that is not
 * inside an isolated test root. The chokepoint lives here, in
 * {@link openNativeDatabase}, so every CLEO database surface (tasks.db,
 * brain.db, signaldock.db, nexus.db, telemetry.db, migration tmp dbs, …)
 * is covered by a single check that no caller can bypass.
 *
 * Allowed paths:
 *  - `:memory:` — in-memory dbs are inherently isolated.
 *  - Anything below `os.tmpdir()` (canonicalised via realpath).
 *  - Anything below a directory listed in `CLEO_TEST_ALLOWED_DB_ROOTS`
 *    (`:`-separated list of absolute paths) — opt-in for integration tests.
 *  - All paths when `CLEO_TEST_ALLOW_PROJECT_DB=true` — emergency override
 *    for harness/integration suites that must touch a real project db.
 *
 * Anything else throws synchronously, BEFORE the SQLite handle is opened.
 * Background: a vitest run leaked task fixtures (T9001…T9010) into the
 * project's production tasks.db on 2026-05-06 because library helpers like
 * `lifecycle/pipeline.ts` call `getDb()` with no `cwd`, silently falling
 * back to `process.cwd()/.cleo/tasks.db`. This guard makes that class of
 * leak fail loudly instead of silently mutating production state.
 */
function assertVitestSafePath(path: string): void {
  if (process.env.VITEST !== 'true') return;
  if (process.env.CLEO_TEST_ALLOW_PROJECT_DB === 'true') return;
  if (path === ':memory:') return;
  if (path === '' || path === '/dev/null') return;

  const resolved = resolveAbsoluteSafe(path);
  const tmpRoot = resolveAbsoluteSafe(tmpdir());
  if (isPathUnder(resolved, tmpRoot)) return;

  const allowList = (process.env.CLEO_TEST_ALLOWED_DB_ROOTS ?? '')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const root of allowList) {
    if (isPathUnder(resolved, resolveAbsoluteSafe(root))) return;
  }

  throw new Error(
    `[CLEO test isolation guard] Refusing to open SQLite at "${resolved}" ` +
      `during a vitest run. Tests MUST use an isolated database under ` +
      `os.tmpdir() (e.g. via fs.mkdtemp(os.tmpdir(), 'cleo-test-')). ` +
      `If this open is intentional (integration/e2e suite), set ` +
      `CLEO_TEST_ALLOW_PROJECT_DB=true or extend ` +
      `CLEO_TEST_ALLOWED_DB_ROOTS=<absPath>:<absPath>. ` +
      `Prevents the T9001-style production-fixture leak (2026-05-06).`,
  );
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
 * Under vitest, {@link assertVitestSafePath} blocks any open against a
 * path outside an isolated test root. See that function's doc for opt-outs.
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
  assertVitestSafePath(path);
  const DatabaseSyncCtor = getDbSyncConstructor();
  const db = new DatabaseSyncCtor(path, {
    enableForeignKeyConstraints: true,
    readOnly: options?.readonly ?? false,
    timeout: options?.timeout ?? 5000,
    allowExtension: options?.allowExtension ?? false,
  });

  // Set busy_timeout FIRST so WAL pragma can wait for locks
  db.exec(`PRAGMA busy_timeout=${options?.timeout ?? 5000}`);

  // Performance pragmas — kept in sync with applyPerfPragmas() in
  // sqlite-pragmas.ts. We inline rather than import because sqlite-native is
  // the leaf-module chokepoint for the TDZ cycle (see file header) and must
  // not depend on any other CLEO module.
  //   synchronous=NORMAL       : durable on commit, no corruption risk under WAL
  //   cache_size=-64000        : 64 MB page cache (default ~2 MB is too small)
  //   mmap_size=268435456      : 256 MB read mmap window
  //   temp_store=MEMORY        : keep temp tables in RAM
  //   wal_autocheckpoint=1000  : ~4 MB WAL before checkpoint
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -64000');
  db.exec('PRAGMA mmap_size = 268435456');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA wal_autocheckpoint = 1000');

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
