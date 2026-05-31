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
 * // Dual-scope consolidated cleo.db (D1″ lifecycle — E3/E4 exodus):
 * const projHandle = await openCleoDb('project', cwd);
 * const globHandle = await openCleoDb('global');
 *
 * // Legacy 8-role API (deprecated — use 'project'|'global' for new code):
 * const handle = await openCleoDb('tasks', cwd);
 * // use handle.db (DatabaseSync) ...
 * await handle.close();
 * ```
 *
 * ## Dual-scope delegation (T11517 · E3)
 *
 * When called with `'project'` or `'global'` as the role, `openCleoDb` delegates
 * directly to {@link openDualScopeDb} from `./dual-scope-db.ts`, returning a
 * `CleoDbHandle`-shaped wrapper. This is the preferred API for all new code
 * after the E3 exodus. The legacy 8-role CleoDbRole API is retained as a
 * deprecated shim for one migration cycle (E6 removes it).
 *
 * ## Snapshot opener (read-only, no migrations)
 *
 * For short-lived read-only opens (backup verification, schema integrity
 * checks, registry reads from non-CLEO processes like Studio), use
 * {@link openCleoDbSnapshot}. It applies the same pragma SSoT but skips
 * migrations and singleton management, so the caller owns the handle's
 * lifecycle directly.
 *
 * @task T9047, T9685, T11517
 * @adr ADR-068, ADR-069
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { resolveOrCwd } from '../paths.js';
import { getProjectInfoSync } from '../project-info.js';
import { getConduitNativeDb } from './conduit-sqlite.js';
import type { DualScope } from './dual-scope-db.js';
import { openDualScopeDb } from './dual-scope-db.js';
import { getBrainDb } from './memory-sqlite.js';
import { getNexusDb } from './nexus-sqlite.js';
import { ensureGlobalSignaldockDb, getGlobalSignaldockNativeDb } from './signaldock-sqlite.js';
import { openSkillsDb } from './skills-db.js';
import { getDb as getTasksDb } from './sqlite.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import { assertDbPathIsNotWorktreeResident } from './worktree-isolation-guard.js';

/**
 * Canonical roles for the CLEO SQLite databases (ADR-068).
 *
 * ### Preferred (dual-scope, D1″ — E3 exodus)
 * - `'project'` — consolidated per-project `cleo.db` (delegates to {@link openDualScopeDb})
 * - `'global'`  — consolidated per-user `cleo.db`  (delegates to {@link openDualScopeDb})
 *
 * ### Legacy 8-role API (deprecated — kept for one migration cycle until E6)
 * The legacy roles below are retained as shims during the E3→E6 transition.
 * New code MUST use `'project'` or `'global'` instead.
 *
 * @task T11517 (E3-T1 · SG-DB-SUBSTRATE-V2)
 */
export type CleoDbRole =
  // ── Dual-scope (preferred) ───────────────────────────────────────────────
  | DualScope // 'project' | 'global'
  // ── Legacy 8-role shims (deprecated — remove in E6) ────────────────────
  | 'tasks'
  | 'brain'
  | 'sessions'
  | 'signaldock'
  | 'conduit'
  | 'nexus'
  | 'skills'
  | 'llmtxt';

/** Legacy 8-role union (deprecated — E6 removes these). */
type LegacyCleoDbRole = Exclude<CleoDbRole, DualScope>;

/** Legacy implemented roles (excludes the not-yet-implemented 'llmtxt'). */
type ImplementedLegacyRole = Exclude<LegacyCleoDbRole, 'llmtxt'>;

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

/**
 * Open brain.db via its canonical lifecycle module (memory-sqlite.ts).
 *
 * T10397 fix: prior to this task, the `brain` role was silently aliased to
 * `getTasksDb`, so every consumer that called `openCleoDb('brain')` was
 * handed a `tasks.db` handle. Writes to brain tables either no-op'd against
 * tasks.db or surfaced as schema errors at prepare()-time.
 *
 * @task T10397
 */
async function openBrainDbHandle(cwd?: string): Promise<unknown> {
  return getBrainDb(cwd);
}

/** Openers for the legacy 8-role API (deprecated shim — E6 removes these). */
const ROLE_OPENERS: Record<ImplementedLegacyRole, DbOpener> = {
  tasks: getTasksDb as unknown as DbOpener,
  // T10397: brain role MUST resolve to brain.db, NOT tasks.db. Prior to
  // this fix the entry was `getTasksDb`, silently corrupting every
  // brain-table write that flowed through the chokepoint.
  brain: openBrainDbHandle,
  // sessions table lives inside tasks.db — there is no separate sessions.db
  // file. The alias is intentional.
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
 * Roles whose DBs track per-project `project_id` and therefore need to be
 * cross-checked against `.cleo/project-info.json` on every open.
 *
 * Today this is just `nexus` — its `project_registry` table records one row
 * per known project with `(project_id PRIMARY KEY, project_path UNIQUE)`.
 * The drift check verifies that a row whose `project_path` matches the
 * caller's project root has the same `project_id` as the caller's
 * `.cleo/project-info.json`. Mismatch → `E_PROJECT_ID_DRIFT`.
 *
 * Project-tier DBs (`tasks`, `brain`, `conduit`, `sessions`) do NOT carry a
 * `project_id` column — they live under per-project `.cleo/` and inherit
 * project identity from their parent directory. The path-layer (T9803) and
 * worktree-isolation guard (T9806) already prevent cross-project misroutes
 * for those roles. Global-tier DBs (`signaldock`, `skills`) carry no
 * project identity at all.
 *
 * @task T10322
 * @saga T10281
 * @adr ADR-068
 */
const PROJECT_ID_TRACKING_ROLES: ReadonlySet<CleoDbRole> = new Set<CleoDbRole>(['nexus']);

interface ProjectRegistryRow {
  project_id: string;
  project_path: string;
}

/**
 * Cross-check `.cleo/project-info.json::projectId` against the project_id
 * recorded for this project's path inside the DB being opened.
 *
 * No-ops (returns silently) for ALL non-drift cases:
 * - The role does not track `project_id` (see {@link PROJECT_ID_TRACKING_ROLES}).
 * - `.cleo/project-info.json` is missing or unparseable (pre-init / fresh clone).
 * - The `projectId` field is empty (pre-T5333 install).
 * - The DB's project-tracking table does not yet exist (pre-bootstrap).
 * - No row in the tracking table matches the caller's project path
 *   (project not yet registered with nexus).
 *
 * Throws `CleoError(CONFIG_ERROR, "E_PROJECT_ID_DRIFT", ...)` IFF every
 * condition is satisfied:
 * 1. The role tracks project_id, AND
 * 2. `.cleo/project-info.json` reports a non-empty `projectId`, AND
 * 3. The DB has a project-registry row for the caller's `projectRoot`, AND
 * 4. That row's `project_id` differs from the project-info projectId.
 *
 * Read-only: never writes to the DB.
 *
 * @task T10322
 * @saga T10281 (SG-BRAIN-DB-RESILIENCE)
 * @epic T10285 (E4-DB-CROSS-LINKS)
 * @adr ADR-068
 */
export function validateProjectIdConsistency(role: CleoDbRole, db: unknown, cwd?: string): void {
  if (!PROJECT_ID_TRACKING_ROLES.has(role)) {
    return;
  }
  if (!isDatabaseSync(db)) {
    // Cannot probe the schema without a native handle; let the caller
    // surface the underlying type error rather than masking it here.
    return;
  }

  const projectRoot = resolveOrCwd(cwd);
  const projectInfo = getProjectInfoSync(projectRoot);
  if (!projectInfo || projectInfo.projectId.length === 0) {
    // Pre-init or pre-T5333 install — nothing to drift against.
    return;
  }

  let row: ProjectRegistryRow | undefined;
  try {
    const stmt = db.prepare(
      'SELECT project_id, project_path FROM project_registry WHERE project_path = ? LIMIT 1',
    );
    row = stmt.get(projectInfo.projectRoot) as ProjectRegistryRow | undefined;
  } catch {
    // `project_registry` may not exist yet (fresh nexus.db before
    // migrations have run). Bootstrap is not drift.
    return;
  }
  if (!row || typeof row.project_id !== 'string' || row.project_id.length === 0) {
    // Project not yet registered with the nexus — that's a normal first-open
    // state, not drift.
    return;
  }

  if (row.project_id !== projectInfo.projectId) {
    throw new CleoError(
      ExitCode.CONFIG_ERROR,
      `E_PROJECT_ID_DRIFT: ${role} DB reports project_id=${row.project_id} for ` +
        `path=${projectInfo.projectRoot} but .cleo/project-info.json reports ` +
        `projectId=${projectInfo.projectId}. The DB and project-info.json are ` +
        `not pointing at the same project — a backup/restore or directory move ` +
        `has left them inconsistent.`,
      {
        fix:
          `Inspect both values: \`cat ${projectInfo.projectRoot}/.cleo/project-info.json\` ` +
          `and the corresponding row in nexus.db's project_registry. Reconcile by ` +
          `either (a) updating project-info.json to the canonical ID, or (b) ` +
          `re-registering this project with \`cleo init --reset\` if the registry ` +
          `entry is stale.`,
      },
    );
  }
}

/**
 * Open (or create) a CLEO database by canonical role or dual-scope selector.
 *
 * ## Dual-scope delegation (preferred — T11517 · E3)
 *
 * When called with `'project'` or `'global'`, this function delegates to
 * {@link openDualScopeDb} from `./dual-scope-db.ts`. The returned handle
 * wraps the typed Drizzle client as `CleoDbHandle.db` for backward compat
 * with legacy callers that treat `db` as an opaque `unknown`.
 *
 * ```ts
 * // Preferred for new code after E3 exodus:
 * const handle = await openCleoDb('project', cwd);
 * const handle = await openCleoDb('global');
 * ```
 *
 * ## Legacy 8-role API (deprecated)
 *
 * The legacy role strings (`'tasks'`, `'brain'`, `'signaldock'`, …) remain
 * functional as deprecated shims for existing callers. E6 will remove them.
 *
 * Single chokepoint for all DB opens. Applies pragma SSoT at open time.
 * Enforces the worktree-isolation guard (T9806) on top of T9803's path-layer
 * THROWS-on-orphan fix.
 *
 * @task T9047, T9685, T11517
 * @adr ADR-068, ADR-069
 */
export async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle> {
  // ── Dual-scope delegation (preferred API — E3 onwards) ──────────────────
  if (role === 'project' || role === 'global') {
    // Delegate to the E4 chokepoint which applies pragma SSoT, runs migrations,
    // and manages the singleton cache. Explicit conditional narrows the overload.
    const dualHandle =
      role === 'project'
        ? await openDualScopeDb('project', cwd)
        : await openDualScopeDb('global', cwd);
    return {
      // The Drizzle handle is compatible with `unknown` — callers that need
      // the native DatabaseSync should use `@cleocode/core/db` directly.
      db: dualHandle.db,
      role,
      async close() {
        dualHandle.close();
      },
    };
  }

  // ── Legacy 8-role API (deprecated shim — E6 removes) ───────────────────

  if (role === 'llmtxt') {
    throw new Error('CLEO DB role llmtxt is not yet implemented');
  }

  const opener = ROLE_OPENERS[role as ImplementedLegacyRole];
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

  // T10322: runtime gate — every project-id-tracking DB open is
  // cross-checked against .cleo/project-info.json::projectId. Mismatch
  // throws E_PROJECT_ID_DRIFT. No-ops for project-tier and global-tier
  // roles that don't carry a project_id column.
  validateProjectIdConsistency(role, db, cwd);

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
