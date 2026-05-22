/**
 * Canonical DB-open chokepoint for all CLEO SQLite databases.
 *
 * ## Invariant (ADR-068 §3, T9047)
 *
 * Every CLEO SQLite database open MUST flow through `openCleoDb(role, cwd)`.
 * Raw `new DatabaseSync(path)` calls outside `packages/core/src/store/` are
 * rejected by the `db-open-guard` CI job (`scripts/lint-no-raw-db-opens.mjs`).
 *
 * ## Rationale (ADR-069 Coordination Layers)
 *
 * - **Pragma consistency**: every handle receives the SSoT pragma set from
 *   `specs/sqlite-pragmas.json` (busy_timeout, WAL, cache_size, mmap_size).
 * - **Topology visibility**: the `CleoDbRole` union enumerates all databases;
 *   `cleo health` can audit which are open.
 * - **Lifecycle centralisation**: singleton management and WAL state live in
 *   one place, preventing lock contention between concurrent CLI processes.
 *
 * ## Usage
 *
 * ```typescript
 * import { openCleoDb } from '@cleocode/core/store/open-cleo-db';
 *
 * const handle = await openCleoDb('tasks', cwd);
 * // use handle.db (DatabaseSync) ...
 * await handle.close();
 * ```
 *
 * ## Snapshot opener (read-only, no migrations)
 *
 * For short-lived read-only opens (backup verification, schema integrity
 * checks, registry reads from non-CLEO processes like Studio), use
 * {@link openCleoDbSnapshot}. It applies the same pragma SSoT but skips
 * migrations and singleton management, so the caller owns the handle's
 * lifecycle directly.
 *
 * @task T9047, T9685
 * @adr ADR-068, ADR-069
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { resolveOrCwd } from '../paths.js';
import { getConduitNativeDb } from './conduit-sqlite.js';
import { getNexusDb } from './nexus-sqlite.js';
import { ensureGlobalSignaldockDb, getGlobalSignaldockNativeDb } from './signaldock-sqlite.js';
import { openSkillsDb } from './skills-db.js';
import { getDb as getTasksDb } from './sqlite.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import { assertDbPathIsNotWorktreeResident } from './worktree-isolation-guard.js';

/** Canonical roles for the 6 SQLite databases (ADR-068), plus planned llmtxt/docs storage. */
export type CleoDbRole =
  | 'tasks'
  | 'brain'
  | 'sessions'
  | 'signaldock'
  | 'conduit'
  | 'nexus'
  | 'skills'
  | 'llmtxt';

type ImplementedCleoDbRole = Exclude<CleoDbRole, 'llmtxt'>;

interface DrizzleWithClient {
  $client?: unknown;
}

/** Handle returned by {@link openCleoDb}. */
export interface CleoDbHandle {
  db: unknown;
  role: CleoDbRole;
  close(): Promise<void>;
}

/** @deprecated Use {@link CleoDbHandle}. */
export type DBHandle = CleoDbHandle;

/** Internal opener for a given role. */
type DbOpener = (cwd?: string) => Promise<unknown>;

/** Open the global signaldock.db via its canonical module. */
async function openSignaldockDb(_cwd?: string): Promise<unknown> {
  await ensureGlobalSignaldockDb();
  return getGlobalSignaldockNativeDb();
}

/** Open the conduit.db for the given project (or current process). */
async function openConduitDb(cwd?: string): Promise<unknown> {
  const { ensureConduitDb } = await import('./conduit-sqlite.js');
  ensureConduitDb(resolveOrCwd(cwd));
  return getConduitNativeDb();
}

/**
 * Open the per-user skills.db registry (global-tier, `getCleoHome()`).
 *
 * Delegates to `openSkillsDb()` in `./skills-db.ts` — the canonical lifecycle
 * module for skills.db (mirrors signaldock/conduit/nexus modules).
 *
 * @task T9651
 */
async function openSkillsDbHandle(_cwd?: string): Promise<unknown> {
  // The drizzle handle wraps the native DatabaseSync via `$client`; the
  // caller of openCleoDb() unwraps it through `unwrapNativeSqliteDb()` below.
  return openSkillsDb();
}

const ROLE_OPENERS: Record<ImplementedCleoDbRole, DbOpener> = {
  tasks: getTasksDb as unknown as DbOpener,
  brain: getTasksDb as unknown as DbOpener,
  sessions: getTasksDb as unknown as DbOpener,
  signaldock: openSignaldockDb,
  conduit: openConduitDb,
  nexus: getNexusDb as unknown as DbOpener,
  skills: openSkillsDbHandle,
};

function unwrapNativeSqliteDb(db: unknown): unknown {
  if (db && typeof db === 'object' && '$client' in db) {
    return (db as DrizzleWithClient).$client ?? db;
  }
  return db;
}

function isDatabaseSync(db: unknown): db is DatabaseSync {
  return Boolean(db && typeof db === 'object' && 'exec' in db && 'prepare' in db);
}

/**
 * Open (or create) a CLEO database by canonical role.
 *
 * Single chokepoint for all DB opens. Applies pragma SSoT at open time.
 * Enforces the worktree-isolation guard (T9806) on top of T9803's path-layer
 * THROWS-on-orphan fix.
 */
export async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle> {
  if (role === 'llmtxt') {
    throw new Error('CLEO DB role llmtxt is not yet implemented');
  }

  const opener = ROLE_OPENERS[role];
  if (!opener) {
    throw new Error(`Unknown CLEO DB role: ${role}`);
  }

  // T9806/D009: defense-in-depth — refuse opens whose resolved `.cleo/`
  // resides inside a git worktree (gitlink-file parent). Roles that read
  // from a global path (signaldock, skills) MAY legitimately open from
  // anywhere — they don't depend on cwd-resolved project root.
  if (role !== 'signaldock' && role !== 'skills') {
    assertDbPathIsNotWorktreeResident(role, cwd);
  }

  const openedDb = await opener(cwd);
  const db = unwrapNativeSqliteDb(openedDb);

  // Apply pragma SSoT (T9053) — applyPerfPragmas expects DatabaseSync
  if (isDatabaseSync(db)) {
    applyPerfPragmas(db);
  }

  return {
    db,
    role,
    async close() {
      // Idempotent — individual modules manage their own singletons
    },
  };
}

/**
 * Legacy alias for `openCleoDb('tasks')`.
 * @deprecated Use {@link openCleoDb} with explicit role.
 */
export async function openTasksDb(cwd?: string): Promise<CleoDbHandle> {
  return openCleoDb('tasks', cwd);
}

// ============================================================================
// Snapshot opener — readonly + no migrations (T9685-B3)
// ============================================================================

/** Options accepted by {@link openCleoDbSnapshot}. */
export interface CleoDbSnapshotOptions {
  /**
   * Open the file with `readOnly: true`. Default `true` — the snapshot opener
   * is meant for read-only inspection (backup verification, schema queries,
   * registry reads from short-lived processes like a SvelteKit request).
   */
  readOnly?: boolean;
  /**
   * Apply the canonical pragma set (cache_size, mmap_size, busy_timeout,
   * temp_store, wal_autocheckpoint). Default `true`. WAL/foreign_keys are
   * suppressed automatically when `readOnly === true`.
   */
  applyPragmas?: boolean;
}

/**
 * Handle returned by {@link openCleoDbSnapshot}. Caller-owned lifecycle —
 * `close()` calls `DatabaseSync.close()` directly because snapshot opens are
 * NOT managed by a singleton.
 */
export interface CleoDbSnapshotHandle {
  /** The native node:sqlite handle. */
  db: DatabaseSync;
  /** Absolute path the handle was opened against. */
  path: string;
  /** Close the underlying handle. Safe to call multiple times. */
  close(): void;
}

/**
 * Open a SQLite database file as a read-only snapshot, applying the
 * canonical pragma SSoT but skipping migrations and singleton management.
 *
 * ## When to use
 *
 * - Backup verification (e.g. `migration/checksum.ts`)
 * - Atomic / read-side database validation (e.g. `store/atomic.ts`)
 * - Short-lived registry reads from a non-CLEO process (e.g. Studio
 *   SvelteKit endpoints that read nexus.db for project listings)
 *
 * Do NOT use for the long-lived role databases — those go through
 * {@link openCleoDb} which manages singletons + migrations.
 *
 * ## Pragma application
 *
 * When `applyPragmas !== false` (default), the canonical performance pragmas
 * are applied via `applyPerfPragmas`. For read-only handles, `enableWal` is
 * forced `false` because WAL mode is unsettable on a read-only connection.
 *
 * ## Lifecycle
 *
 * The handle is caller-owned — call `handle.close()` when done. Unlike
 * {@link openCleoDb}, the snapshot opener does NOT participate in any
 * singleton cache, so leaking a snapshot handle leaks a file descriptor.
 *
 * @task T9685
 * @adr ADR-068, ADR-069
 *
 * @example
 * ```typescript
 * import { openCleoDbSnapshot } from '@cleocode/core/store/open-cleo-db';
 *
 * const snap = openCleoDbSnapshot('/path/to/nexus.db');
 * try {
 *   const rows = snap.db.prepare('SELECT * FROM project_registry').all();
 *   // ...
 * } finally {
 *   snap.close();
 * }
 * ```
 */
export function openCleoDbSnapshot(
  path: string,
  options: CleoDbSnapshotOptions = {},
): CleoDbSnapshotHandle {
  const { readOnly = true, applyPragmas = true } = options;

  // node:sqlite is a CJS-only built-in; createRequire keeps this ESM-safe.
  const _require = createRequire(import.meta.url);
  const { DatabaseSync: DatabaseSyncCtor } = _require('node:sqlite') as {
    DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSync>) => DatabaseSync;
  };

  const db = new DatabaseSyncCtor(path, { readOnly });

  if (applyPragmas) {
    // Read-only handles cannot set journal_mode; suppress WAL when readOnly.
    applyPerfPragmas(db, { enableWal: !readOnly });
  }

  let closed = false;
  return {
    db,
    path,
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        // Ignore close errors — the handle is already in a terminal state.
      }
    },
  };
}
