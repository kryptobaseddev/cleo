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
 * // use handle.db (native DatabaseSync) ...
 * await handle.close();
 * ```
 *
 * ## Dual-scope delegation (T11517 · E3 · T11526 · E6-L6)
 *
 * `openCleoDb` accepts ONLY `'project'` | `'global'` and delegates directly to
 * {@link openDualScopeDb} from `./dual-scope-db.ts`. The legacy 8-role API
 * (`tasks` / `brain` / `sessions` / `signaldock` / `conduit` / `nexus` /
 * `skills` / `llmtxt`) was removed in E6-L6 (T11526) — the per-domain leaf
 * modules (L1–L5) now open the consolidated `cleo.db` through `openDualScopeDb`
 * directly, so the chokepoint no longer needs the per-role dispatch table.
 *
 * The returned `CleoDbHandle.db` is the **native** `DatabaseSync` handle
 * (extracted from the Drizzle wrapper's `$client`), preserving the contract
 * the legacy roles exposed so callers that issue raw `prepare`/`exec` SQL keep
 * working with only a role-string swap.
 *
 * ## Snapshot opener (read-only, no migrations)
 *
 * For short-lived read-only opens (backup verification, schema integrity
 * checks, registry reads from non-CLEO processes like Studio), use
 * {@link openCleoDbSnapshot}. It applies the same pragma SSoT but skips
 * migrations and singleton management, so the caller owns the handle's
 * lifecycle directly.
 *
 * @task T9047, T9685, T11517, T11526
 * @adr ADR-068, ADR-069
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { resolveOrCwd } from '../paths.js';
import { getProjectInfoSync } from '../project-info.js';
import type { DualScope } from './dual-scope-db.js';
import { openDualScopeDb } from './dual-scope-db.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import { assertDbPathIsNotWorktreeResident } from './worktree-isolation-guard.js';

/**
 * Canonical scopes for the consolidated CLEO `cleo.db` databases (ADR-068).
 *
 * - `'project'` — consolidated per-project `cleo.db` (delegates to {@link openDualScopeDb})
 * - `'global'`  — consolidated per-user `cleo.db`  (delegates to {@link openDualScopeDb})
 *
 * The legacy 8-role API (`tasks` / `brain` / `sessions` / `signaldock` /
 * `conduit` / `nexus` / `skills` / `llmtxt`) was removed in E6-L6 (T11526).
 * `tasks` / `brain` / `sessions` / `conduit` map to `'project'`; `nexus` /
 * `signaldock` / `skills` map to `'global'`.
 *
 * @task T11517 (E3-T1 · SG-DB-SUBSTRATE-V2), T11526 (E6-L6)
 */
export type CleoDbRole = DualScope; // 'project' | 'global'

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
 * Scopes whose `cleo.db` tracks a per-project `project_id` and therefore need
 * a cross-check against `.cleo/project-info.json` on every open.
 *
 * After the E6 consolidation the cross-project registry (formerly nexus.db)
 * lives inside the **global** `cleo.db`. Its `nexus_project_registry` table
 * (T11578 · AC3 prefixed shape) records one row per known project with
 * `(project_id PRIMARY KEY, project_path UNIQUE)`. The drift check verifies
 * that a row whose `project_path` matches the caller's project root has the
 * same `project_id` as the caller's `.cleo/project-info.json`. Mismatch →
 * `E_PROJECT_ID_DRIFT`.
 *
 * The project-tier `cleo.db` (tasks, brain, conduit, sessions data) does NOT
 * carry a `project_id` column — it lives under per-project `.cleo/` and
 * inherits project identity from its parent directory. The path-layer (T9803)
 * and worktree-isolation guard (T9806) already prevent cross-project misroutes
 * for the project scope.
 *
 * @task T10322, T11526
 * @saga T10281
 * @adr ADR-068
 */
const PROJECT_ID_TRACKING_ROLES: ReadonlySet<CleoDbRole> = new Set<CleoDbRole>(['global']);

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
      'SELECT project_id, project_path FROM nexus_project_registry WHERE project_path = ? LIMIT 1',
    );
    row = stmt.get(projectInfo.projectRoot) as ProjectRegistryRow | undefined;
  } catch {
    // `nexus_project_registry` (T11578 · AC3 prefixed registry) may not exist
    // yet (fresh global cleo.db before the consolidated migration runs).
    // Bootstrap is not drift.
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
 * Open (or create) a CLEO database by dual-scope selector.
 *
 * ## Dual-scope delegation (T11517 · E3 · T11526 · E6-L6)
 *
 * Accepts ONLY `'project'` | `'global'` and delegates to {@link openDualScopeDb}
 * from `./dual-scope-db.ts`, which applies the pragma SSoT, runs migrations,
 * and manages the singleton cache for the consolidated `cleo.db`.
 *
 * ```ts
 * const handle = await openCleoDb('project', cwd);
 * const handle = await openCleoDb('global');
 * ```
 *
 * `CleoDbHandle.db` is the **native** `DatabaseSync` handle (extracted from the
 * Drizzle wrapper's `$client`). This preserves the contract the legacy 8-role
 * API exposed, so callers issuing raw `prepare`/`exec` SQL keep working after
 * swapping their role string (`tasks`/`brain`/`sessions`/`conduit` → `project`;
 * `nexus`/`signaldock`/`skills` → `global`).
 *
 * Single chokepoint for all DB opens. Enforces the worktree-isolation guard
 * (T9806) for the project scope on top of T9803's path-layer THROWS-on-orphan
 * fix.
 *
 * @task T9047, T9685, T11517, T11526
 * @adr ADR-068, ADR-069
 */
export async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle> {
  // T9806/D009: defense-in-depth — refuse project-scope opens whose resolved
  // `.cleo/` resides inside a git worktree (gitlink-file parent). The global
  // scope reads from `getCleoHome()` and does not depend on cwd-resolved
  // project root, so it MAY legitimately open from anywhere.
  if (role === 'project') {
    assertDbPathIsNotWorktreeResident('tasks', cwd);
  }

  // Delegate to the E4 chokepoint which applies pragma SSoT, runs migrations,
  // and manages the singleton cache. Explicit conditional narrows the overload.
  const dualHandle =
    role === 'project'
      ? await openDualScopeDb('project', cwd)
      : await openDualScopeDb('global', cwd);

  // Extract the native DatabaseSync from the Drizzle wrapper. Callers that
  // issue raw `prepare`/`exec` SQL (supersede.ts, worktree/list.ts, the agent
  // registry, etc.) depend on `handle.db` being the native handle — the same
  // contract the legacy 8-role shims exposed via `unwrapNativeSqliteDb`.
  const db = unwrapNativeSqliteDb(dualHandle.db);

  // Pragma SSoT (T9053) is already applied by openDualScopeDb, but re-assert it
  // here as defense-in-depth for the native handle.
  if (isDatabaseSync(db)) {
    applyPerfPragmas(db);
  }

  // T10322: runtime gate — every project-id-tracking open is cross-checked
  // against .cleo/project-info.json::projectId. Mismatch throws
  // E_PROJECT_ID_DRIFT. Active for the global scope (which owns the
  // project_registry table); no-ops for the project scope.
  validateProjectIdConsistency(role, db, cwd);

  return {
    db,
    role,
    async close() {
      dualHandle.close();
    },
  };
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
 * const snap = openCleoDbSnapshot('/path/to/cleo.db');
 * try {
 *   const rows = snap.db.prepare('SELECT * FROM nexus_project_registry').all();
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
