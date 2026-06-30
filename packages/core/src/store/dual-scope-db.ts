/**
 * Dual-scope SQLite DB open chokepoint for the SG-DB-SUBSTRATE-V2 consolidated schema.
 *
 * ## Overview (D1″ lifecycle split · T11246/E3 + T11247/E4)
 *
 * The owner-ratified D1″ decision (2026-05-30) collapses the CLEO SQLite fleet
 * into exactly **two `cleo.db` files per machine view**:
 *
 *   - **Project scope** — `<projectRoot>/.cleo/cleo.db`
 *     Contains every project-tier domain: `tasks_*` / `brain_*` (project-local
 *     memory) / `conduit_*` / `docs_*` / `telemetry_*` / lifecycle / provenance /
 *     chain / playbooks / agents (87 tables / 903 columns, T11360 count).
 *
 *   - **Global scope** — `$XDG_DATA_HOME/cleo/cleo.db`
 *     Contains every cross-project domain: `nexus_*` / `skills_*` /
 *     `signaldock_*` / `brain_*` (global cross-project memory)
 *     (49 tables / 555 columns, T11361 count).
 *
 * ## Lifecycle
 *
 * `openDualScopeDb` is the **single chokepoint** for all opens of the
 * consolidated schema. It:
 *   1. Resolves the DB file path from scope + `cwd` (project) or `getCleoHome()`
 *      (global).
 *   2. Opens a `node:sqlite` `DatabaseSync` handle.
 *   3. Applies the canonical pragma set from `specs/sqlite-pragmas.json` via
 *      {@link applyPerfPragmas}.
 *   4. Runs the drizzle-kit migrate step against the scope-appropriate
 *      migrations folder (`drizzle-cleo-project` or `drizzle-cleo-global`).
 *   5. Returns a cached, typed `NodeSQLiteDatabase<TSchema>` handle.
 *      Subsequent calls for the same (scope, cwd) return the cached handle.
 *
 * ## Note on co-existence with legacy openCleoDb
 *
 * During the E3/E4 → E6 exodus transition, `openCleoDb` (the existing
 * 8-role chokepoint) and `openDualScopeDb` (this module) co-exist. `openCleoDb`
 * will be updated by E3 to delegate to this function for the consolidated
 * schema. Until the E6 store rewrite, individual store modules still open their
 * own legacy DBs via `openCleoDb`. The E6 milestone removes the legacy opens.
 *
 * @module
 * @task T11512 (E4-T1)
 * @task T11513 (E4-T2 — idempotent write helpers in this same file)
 * @epic T11247 (E4)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @adr ADR-068, ADR-069
 * @see packages/core/src/store/schema/cleo-project/index.ts — project schema
 * @see packages/core/src/store/schema/cleo-global/index.ts — global schema
 * @see packages/core/migrations/drizzle-cleo-project — project migrations
 * @see packages/core/migrations/drizzle-cleo-global — global migrations
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { getCleoHome, resolveCleoDir } from '../paths.js';
import { type ExodusAbortDetail, getRecordedExodusAbort } from './exodus/abort-events.js';
import { migrateWithRetry, reconcileJournal } from './migration-manager.js';
import {
  resolveConsolidatedJournalSiblings,
  resolveCorePackageMigrationsFolder,
} from './resolve-migrations-folder.js';
import type * as CleoGlobalSchemaTypes from './schema/cleo-global/index.js';
import type * as CleoProjectSchemaTypes from './schema/cleo-project/index.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import {
  activeScope,
  activeScopeDbPath,
  withColdOpenLease,
  withWriterLease,
} from './writer-lease.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The two canonical scopes for the consolidated dual-scope `cleo.db` substrate.
 *
 * - `'project'` — per-project DB at `<projectRoot>/.cleo/cleo.db`
 * - `'global'` — per-user DB at `$XDG_DATA_HOME/cleo/cleo.db`
 */
export type DualScope = 'project' | 'global';

/** Typed Drizzle handle for the project-scope `cleo.db`. */
export type CleoProjectDb = NodeSQLiteDatabase<typeof CleoProjectSchemaTypes>;

/** Typed Drizzle handle for the global-scope `cleo.db`. */
export type CleoGlobalDb = NodeSQLiteDatabase<typeof CleoGlobalSchemaTypes>;

/**
 * Handle returned by {@link openDualScopeDb}.
 *
 * `TScope extends DualScope` narrows `db` to the correct schema type:
 * - `openDualScopeDb('project')` → `DualScopeDbHandle<'project'>` with `db: CleoProjectDb`
 * - `openDualScopeDb('global')` → `DualScopeDbHandle<'global'>` with `db: CleoGlobalDb`
 */
export interface DualScopeDbHandle<TScope extends DualScope = DualScope> {
  /** The Drizzle ORM handle typed against the consolidated schema for `scope`. */
  readonly db: TScope extends 'project' ? CleoProjectDb : CleoGlobalDb;
  /** The scope this handle was opened against. */
  readonly scope: TScope;
  /** Absolute path to the underlying SQLite file. */
  readonly dbPath: string;
  /**
   * Set ONLY when the exodus-on-open data-continuity gate ABORTED the first-open
   * auto-migration for this scope (T11828 · DHQ-059). When present, the handle is
   * live and the consolidated `cleo.db` is internally consistent but EMPTY — the
   * user's real data is still in the legacy fleet, which was kept as the source
   * of truth. A read-only caller may safely ignore this marker; a MUTATING caller
   * MUST treat its write as not-durable-against-source and react (see
   * {@link assertWriteDurable}). `undefined` on every normal (migrated / skipped /
   * fresh-install) open.
   */
  readonly exodusAbort?: ExodusAbortDetail;
  /**
   * Close the underlying native handle and evict this entry from the
   * singleton cache. Safe to call multiple times (idempotent).
   */
  close(): void;
}

/**
 * Options for {@link openDualScopeDbAtPath}.
 *
 * @task T11782 (FIX D — dedicated migrate connection)
 */
export interface OpenDualScopeAtPathOptions {
  /**
   * When `true`, open a DEDICATED, NON-cached connection — a second SQLite
   * handle to the same file, independent of the singleton `_cache`. Used by the
   * exodus migrate engine so its copy + rollback transactions are isolated from
   * the caller's cached handle (and any concurrent task INSERTs sharing it). The
   * returned handle's `close()` closes only the native connection and never
   * mutates the cache; the caller MUST close it to avoid a descriptor leak.
   *
   * @default false
   */
  readonly dedicated?: boolean;
}

/**
 * Thrown by {@link assertWriteDurable} when a MUTATING caller is about to write
 * through a {@link DualScopeDbHandle} whose first-open exodus auto-migration
 * ABORTED (T11828 · DHQ-059).
 *
 * The consolidated `cleo.db` is internally consistent but EMPTY: the user's real
 * data is still in the legacy fleet (kept as the source of truth). Writing here
 * would land in a DB that does not reflect that data, so the write is NOT durable
 * against the source of truth. Read paths never raise this — they intentionally
 * skip {@link assertWriteDurable} and operate on the empty-but-consistent DB.
 *
 * Self-contained (mirrors `BackupRecoverError`) rather than a `CleoError` subclass
 * so the store layer does not need a new numeric `ExitCode` in `@cleocode/contracts`
 * for a condition that is surfaced structurally on the handle.
 *
 * @task T11828
 * @epic T11833
 * @saga T11242
 * @public
 */
export class ExodusAbortWriteUnsafeError extends Error {
  /** Stable string error code for envelope `codeName` / log correlation. */
  readonly codeName = 'E_EXODUS_ABORT_WRITE_UNSAFE' as const;
  /** The structured abort detail carried by the handle. */
  readonly detail: ExodusAbortDetail;
  /** Remediation hint surfaced to the operator. */
  readonly fix: string;

  /**
   * @param detail - The {@link ExodusAbortDetail} stamped on the handle.
   */
  constructor(detail: ExodusAbortDetail) {
    super(
      `Refusing to write to consolidated ${detail.scope} cleo.db — exodus-on-open ABORTED ` +
        `(${detail.reason}). The DB is empty; legacy data is the source of truth. ` +
        `Run \`cleo doctor exodus-health\` then \`cleo exodus migrate\` (or restore via ` +
        `\`cleo doctor repair --role ${detail.scope === 'project' ? 'tasks' : 'nexus'}\`) before writing.`,
    );
    this.name = 'ExodusAbortWriteUnsafeError';
    this.detail = detail;
    this.fix =
      'Resolve the aborted migration (`cleo doctor exodus-health` → `cleo exodus migrate`) ' +
      'so the consolidated cleo.db carries your data before mutating it.';
  }
}

/**
 * Assert that a {@link DualScopeDbHandle} is safe to WRITE through.
 *
 * Call this at the head of a MUTATING code path (insert/update/delete) that holds
 * a dual-scope handle. If the handle carries an {@link DualScopeDbHandle.exodusAbort}
 * marker — i.e. the first-open auto-migration aborted and the consolidated DB is
 * empty with legacy kept as source — this throws {@link ExodusAbortWriteUnsafeError}
 * so the write is rejected with a non-zero signal rather than silently landing in
 * a DB that does not hold the user's data.
 *
 * READ-only callers MUST NOT call this — they are expected to operate on the
 * empty-but-consistent consolidated DB without error, exactly as before T11828.
 *
 * @param handle - The handle returned by {@link openDualScopeDb}.
 * @throws {ExodusAbortWriteUnsafeError} When `handle.exodusAbort` is set.
 *
 * @example
 * ```ts
 * const h = await openDualScopeDb('project', cwd);
 * assertWriteDurable(h);            // throws if a prior exodus-on-open aborted
 * await h.db.insert(table).values(row);
 * ```
 *
 * @task T11828 (DHQ-059)
 * @epic T11833
 * @saga T11242
 * @public
 */
export function assertWriteDurable(handle: DualScopeDbHandle): void {
  if (handle.exodusAbort) {
    throw new ExodusAbortWriteUnsafeError(handle.exodusAbort);
  }
}

/**
 * Throw {@link ExodusAbortWriteUnsafeError} when ANY exodus-on-open abort is
 * recorded for this process (across either scope).
 *
 * Used by the consolidated-schema MUTATION primitives ({@link insertIdempotent} /
 * {@link upsertIdempotent}) which do not receive the originating
 * {@link DualScopeDbHandle} — they consult the process-local registry recorded by
 * {@link emitExodusAbort} instead. Read paths never call these primitives, so the
 * guard is write-only.
 *
 * @throws {ExodusAbortWriteUnsafeError} When a recorded abort exists.
 * @internal
 * @task T11828
 */
function assertNoRecordedExodusAbort(): void {
  const detail = getRecordedExodusAbort();
  if (detail) {
    throw new ExodusAbortWriteUnsafeError(detail);
  }
}

// ── Internal singleton state ─────────────────────────────────────────────────

/** Cache key = `${scope}::${dbPath}` */
type CacheKey = string;

interface CacheEntry {
  handle: DualScopeDbHandle;
  nativeDb: DatabaseSync;
  initPromise: Promise<DualScopeDbHandle> | null;
}

const _cache = new Map<CacheKey, CacheEntry>();

/**
 * Build the singleton cache key for a given scope + resolved DB path.
 * Uses `::` as a separator that cannot appear in POSIX paths.
 */
function cacheKey(scope: DualScope, dbPath: string): CacheKey {
  return `${scope}::${dbPath}`;
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the dual-scope `cleo.db` for the given scope.
 *
 * - `project`: `resolveCleoDir(cwd)` + `'cleo.db'` (falls under `<root>/.cleo/`)
 * - `global`:  `getCleoHome()` + `'cleo.db'` (falls under XDG data home `/cleo/`)
 */
export function resolveDualScopeDbPath(scope: DualScope, cwd?: string): string {
  if (scope === 'project') {
    return join(resolveCleoDir(cwd), 'cleo.db');
  }
  return join(getCleoHome(), 'cleo.db');
}

// ── Migration folder resolution ──────────────────────────────────────────────

/**
 * Return the migrations folder name for the given scope.
 * The folder lives under `@cleocode/core/migrations/<name>`.
 */
function migrationsSetName(scope: DualScope): string {
  return scope === 'project' ? 'drizzle-cleo-project' : 'drizzle-cleo-global';
}

// ── Lazy drizzle loading ─────────────────────────────────────────────────────

// The drizzle-orm/node-sqlite driver statically imports `node:sqlite`, so we
// load it lazily (matching the pattern in sqlite.ts, T11280) to avoid pulling
// the native binding at module-load time and breaking lazy-init assertions.
const _require = createRequire(import.meta.url);

type DrizzleFn = typeof import('drizzle-orm/node-sqlite').drizzle;

let _drizzle: DrizzleFn | null = null;

function getDrizzle(): DrizzleFn {
  if (_drizzle === null) {
    const mod = _require('drizzle-orm/node-sqlite') as { drizzle: DrizzleFn };
    _drizzle = mod.drizzle;
  }
  return _drizzle;
}

// Also lazy-load DatabaseSync to avoid eager node:sqlite pull.
type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean; allowExtension?: boolean },
) => DatabaseSync;

let _DatabaseSyncCtor: DatabaseSyncCtor | null = null;

function getDatabaseSyncCtor(): DatabaseSyncCtor {
  if (_DatabaseSyncCtor === null) {
    const mod = _require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    _DatabaseSyncCtor = mod.DatabaseSync;
  }
  return _DatabaseSyncCtor;
}

// ── Schema loading ───────────────────────────────────────────────────────────

// Dynamic imports for schema barrels. Loaded once per scope and cached.
// We use dynamic import() to avoid loading both schemas at module-init time —
// only the requested scope's schema is loaded.

let _projectSchema: typeof CleoProjectSchemaTypes | null = null;
let _globalSchema: typeof CleoGlobalSchemaTypes | null = null;

async function loadProjectSchema(): Promise<typeof CleoProjectSchemaTypes> {
  if (_projectSchema === null) {
    _projectSchema = await import('./schema/cleo-project/index.js');
  }
  return _projectSchema;
}

async function loadGlobalSchema(): Promise<typeof CleoGlobalSchemaTypes> {
  if (_globalSchema === null) {
    _globalSchema = await import('./schema/cleo-global/index.js');
  }
  return _globalSchema;
}

// ── Existence table for migration reconciliation ──────────────────────────────

/**
 * The "existence table" used by {@link reconcileJournal} to detect whether
 * migrations have been run before.
 *
 * For the project scope the first domain is `tasks_tasks`; for global it
 * is `nexus_project_registry`. These are the canonical first tables in each
 * scope's migration.
 */
function existenceTable(scope: DualScope): string {
  return scope === 'project' ? 'tasks_tasks' : 'nexus_project_registry';
}

// ── Per-connection memory bounding (T11829) ────────────────────────────────────

/**
 * Per-open pragma overrides that bound a connection's memory footprint for
 * one-shot CLI invocations and short-lived daemon-tick opens (T11829).
 *
 * The canonical SSoT pragmas reserve `cache_size=-64000` (64 MB page cache) +
 * `mmap_size=268435456` (256 MB mmap window) + `temp_store=MEMORY` per connection
 * ≈ 320-550 MB of address space PER PROCESS. With many concurrent uncapped
 * processes (queued `cleo` opens + a respawning daemon + parallel agents), that sum
 * blows past host RAM and the OOM-killer fires. A one-shot `cleo` command opens,
 * does a small read/write, and exits — it gains nothing from a 256 MB mmap window
 * or a 64 MB cache, so we shrink BOTH for these short-lived opens:
 *
 *   - `mmap_size = 0`   — disable the memory-mapped read window entirely.
 *   - `cache_size = -8000` (8 MB) — a modest page cache, plenty for CLI queries.
 *
 * The SSoT default in `specs/sqlite-pragmas.json` is UNCHANGED (the long-lived
 * daemon may legitimately want the larger cache/mmap for its working set). This is
 * a per-OPEN override only. Neither `cache_size` nor `mmap_size` is in the
 * `cleo doctor` pragma-drift list (`pragma-ssot.ts#driftPragmas` checks only
 * journal_mode/busy_timeout/foreign_keys/synchronous/page_size/application_id), so
 * shrinking them here does NOT trip the drift gate.
 *
 * The daemon (`CLEO_SENTIENT_DAEMON=1`) keeps the full SSoT footprint — it is a
 * single long-lived process whose working set benefits from the larger cache.
 *
 * @returns Pragma overrides to pass to {@link applyPerfPragmas}, or `{}` for the
 *   daemon (full SSoT footprint).
 */
function memoryBoundedPragmaOverrides(): { mmapSizeBytes?: number; cacheSizeKb?: number } {
  // The long-lived sentient daemon keeps the full SSoT footprint.
  if (process.env.CLEO_SENTIENT_DAEMON === '1') return {};
  // Allow an explicit opt-out for any caller that wants the full footprint.
  if (process.env.CLEO_DB_FULL_MEM === '1') return {};
  return { mmapSizeBytes: 0, cacheSizeKb: 8000 };
}

// ── Core open logic ──────────────────────────────────────────────────────────

/**
 * Open (or re-use) the consolidated dual-scope `cleo.db` for the given scope.
 *
 * @param scope - `'project'` for the per-project DB; `'global'` for the
 *   per-user cross-project DB.
 * @param cwd - Optional working directory used to resolve the project root for
 *   the `'project'` scope. Ignored for `'global'`.
 * @returns A typed {@link DualScopeDbHandle} wrapping the Drizzle ORM instance
 *   bound to the consolidated schema for the requested scope. The handle is
 *   cached per (scope, dbPath) — subsequent calls return the same instance.
 *
 * @example
 * ```ts
 * const proj = await openDualScopeDb('project', process.cwd());
 * const global = await openDualScopeDb('global');
 * ```
 *
 * @task T11512
 * @epic T11247 (E4)
 * @saga T11242
 */
export async function openDualScopeDb(
  scope: 'project',
  cwd?: string,
): Promise<DualScopeDbHandle<'project'>>;
export async function openDualScopeDb(
  scope: 'global',
  cwd?: string,
): Promise<DualScopeDbHandle<'global'>>;
export async function openDualScopeDb(scope: DualScope, cwd?: string): Promise<DualScopeDbHandle> {
  const dbPath = resolveDualScopeDbPath(scope, cwd);
  // Dispatch on the scope literal so the overloaded path-aware opener resolves to
  // the correct typed return; the union `scope` cannot satisfy either literal
  // overload directly. The `cwd` is forwarded so the exodus-on-open hook
  // (E6 · T11553) can build a correct legacy-source plan for THIS canonical
  // open. The explicit-path form (test fixtures / legacy-path domains) never
  // receives a `cwd` and therefore never auto-migrates.
  return scope === 'project'
    ? openDualScopeDbAtPath('project', dbPath, cwd)
    : openDualScopeDbAtPath('global', dbPath, cwd);
}

/**
 * Open a DEDICATED, NON-cached consolidated dual-scope `cleo.db` connection
 * (T11782 · FIX D).
 *
 * This opens a fresh `DatabaseSync` to `dbPath`, applies the canonical pragmas,
 * wraps it in Drizzle, reconciles + runs migrations, and returns a handle whose
 * `close()` ONLY closes the native connection — it never reads or mutates the
 * singleton `_cache`. WAL mode permits this second connection to coexist with
 * the cached caller handle on the same file. The exodus migrate engine uses this
 * so its bulk-copy + parity-abort rollback transactions are physically isolated
 * from the caller's connection (and any concurrent task INSERTs sharing it).
 *
 * @param scope  - The consolidated schema scope.
 * @param dbPath - Absolute path to the consolidated `cleo.db` file.
 * @param log    - The module logger.
 * @returns A typed {@link DualScopeDbHandle} backed by a dedicated connection.
 *
 * @task T11782 (FIX D — rollback connection isolation)
 */
async function openDedicatedDualScopeDb(
  scope: DualScope,
  dbPath: string,
  log: ReturnType<typeof getLogger>,
): Promise<DualScopeDbHandle> {
  log.debug({ scope, dbPath }, 'opening DEDICATED (non-cached) dual-scope cleo.db (T11782 FIX D)');

  // Ensure the directory exists before opening.
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const DatabaseSyncCtor = getDatabaseSyncCtor();
  const nativeDb = new DatabaseSyncCtor(dbPath, { allowExtension: true });

  // T11829: bound per-connection memory for one-shot/CLI opens (full SSoT for daemon).
  applyPerfPragmas(nativeDb, memoryBoundedPragmaOverrides());

  const schema = scope === 'project' ? await loadProjectSchema() : await loadGlobalSchema();
  const drizzle = getDrizzle();
  // biome-ignore lint/suspicious/noExplicitAny: schema type is scope-specific; typed via DualScopeDbHandle<TScope>
  const db = drizzle({ client: nativeDb, schema }) as NodeSQLiteDatabase<any>;

  const migrationsFolder = resolveCorePackageMigrationsFolder(migrationsSetName(scope));
  // T11829: pass the OTHER lineages that share this scope's consolidated cleo.db
  // journal so their rows are never deleted as cross-lineage orphans. Both scopes
  // are consolidated single-file substrates with multiple coexisting lineages
  // (project: tasks/cleo-project/nexus/conduit/brain; global:
  // cleo-global/agent-registry/…). Over-inclusion across scopes is safe — a
  // sibling hash absent from this file's journal contributes nothing.
  reconcileJournal(
    nativeDb,
    migrationsFolder,
    existenceTable(scope),
    `dual-scope-db[${scope}]`,
    resolveConsolidatedJournalSiblings(migrationsSetName(scope)),
  );
  migrateWithRetry(
    db,
    migrationsFolder,
    nativeDb,
    existenceTable(scope),
    `dual-scope-db[${scope}]`,
  );

  log.debug({ scope, dbPath }, 'DEDICATED dual-scope cleo.db ready (T11782 FIX D)');

  return {
    db,
    scope,
    dbPath,
    close() {
      // Dedicated handles are never cached — close only the native connection.
      try {
        nativeDb.close();
      } catch {
        // Idempotent — ignore double-close errors.
      }
    },
  };
}

/**
 * Open (or re-use) a consolidated dual-scope `cleo.db` at an EXPLICIT path,
 * bypassing the scope→path resolver.
 *
 * This is the path-aware sibling of {@link openDualScopeDb}. Production callers
 * MUST prefer {@link openDualScopeDb}, which resolves the canonical path from
 * `cwd` / `getCleoHome()`. The explicit-path form exists for two cases:
 *
 *   1. Tests that materialise an isolated consolidated `cleo.db` under a
 *      `mkdtemp` directory (e.g. the skills-db `{ path }` override, E6-L5),
 *      without having to monkey-patch `getCleoHome()`.
 *   2. Domain modules whose legacy lifecycle API accepted an explicit on-disk
 *      path and must keep that contract while still flowing every open through
 *      the single dual-scope chokepoint (so DB Open Guard Gate 3 stays green).
 *
 * The handle is cached per (scope, dbPath) exactly like {@link openDualScopeDb};
 * a test path and the canonical path are distinct cache keys and never collide.
 *
 * @param scope - The consolidated schema scope (`'project'` | `'global'`).
 * @param dbPath - The absolute path to the consolidated `cleo.db` file. The
 *   parent directory is created if absent.
 * @returns A typed {@link DualScopeDbHandle} bound to the scope's schema.
 *
 * @task T11525 (E6-L5)
 * @epic T11249 (E6)
 * @saga T11242
 */
export async function openDualScopeDbAtPath(
  scope: 'project',
  dbPath: string,
  exodusCwd?: string,
  options?: OpenDualScopeAtPathOptions,
): Promise<DualScopeDbHandle<'project'>>;
export async function openDualScopeDbAtPath(
  scope: 'global',
  dbPath: string,
  exodusCwd?: string,
  options?: OpenDualScopeAtPathOptions,
): Promise<DualScopeDbHandle<'global'>>;
export async function openDualScopeDbAtPath(
  scope: DualScope,
  dbPath: string,
  /**
   * Internal: the resolved `cwd` from the canonical {@link openDualScopeDb}
   * call. When present (and `dbPath` is the canonical path for that scope+cwd)
   * the exodus-on-open data-continuity hook (E6 · T11553) is armed. Omitted by
   * the public explicit-path callers (tests / legacy-path domains), which must
   * never auto-migrate an isolated fixture DB.
   */
  exodusCwd?: string,
  options?: OpenDualScopeAtPathOptions,
): Promise<DualScopeDbHandle> {
  const dedicated = options?.dedicated === true;
  const key = cacheKey(scope, dbPath);

  // A DEDICATED open (T11782 · FIX D) bypasses the singleton cache entirely: it
  // opens a SECOND SQLite connection to the same file (WAL allows concurrent
  // connections) so the exodus migrate engine can copy + (on abort) truncate on
  // an ISOLATED handle. The caller's cached handle — shared by concurrent task
  // INSERTs — is a physically distinct connection, so the migration's rollback
  // can only ever truncate its OWN connection's transaction, never the caller's
  // concurrent writes. The returned handle's `close()` only closes the native
  // connection; it never touches `_cache`. Callers MUST close it after use to
  // avoid a file-descriptor leak.
  if (!dedicated) {
    // Return cached handle if available and not mid-init.
    const existing = _cache.get(key);
    if (existing) {
      if (existing.initPromise) {
        return existing.initPromise;
      }
      return existing.handle;
    }
  }

  const log = getLogger('dual-scope-db');

  if (dedicated) {
    return openDedicatedDualScopeDb(scope, dbPath, log);
  }

  // Create a placeholder entry so concurrent callers wait for the same init.
  const initPromise: Promise<DualScopeDbHandle> = (async (): Promise<DualScopeDbHandle> => {
    log.debug({ scope, dbPath }, 'opening dual-scope cleo.db');

    // Ensure the directory exists before opening.
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open the native SQLite handle.
    //
    // `allowExtension: true` permits — but does NOT load — SQLite loadable
    // extensions. The brain domain (E6-L2 · T11522) loads the `sqlite-vec`
    // extension on this shared handle for vector similarity search; node:sqlite
    // requires the flag at construction time (it cannot be toggled afterwards
    // via `enableLoadExtension`). Enabling the flag is harmless for every other
    // domain — no extension is loaded automatically, and the cache stays
    // single-keyed regardless of which domain opens the handle first.
    const DatabaseSyncCtor = getDatabaseSyncCtor();
    const nativeDb = new DatabaseSyncCtor(dbPath, { allowExtension: true });

    // Apply canonical pragma set (specs/sqlite-pragmas.json SSoT), bounding
    // per-connection memory for one-shot/CLI opens (full SSoT for daemon) — T11829.
    applyPerfPragmas(nativeDb, memoryBoundedPragmaOverrides());

    // Load the schema barrel for this scope.
    const schema = scope === 'project' ? await loadProjectSchema() : await loadGlobalSchema();

    // Create the Drizzle ORM wrapper.
    // Drizzle v1 RC3 node-sqlite API: pass { client, schema } as a single config object.
    const drizzle = getDrizzle();
    // biome-ignore lint/suspicious/noExplicitAny: schema type is scope-specific; typed via DualScopeDbHandle<TScope>
    const db = drizzle({ client: nativeDb, schema }) as NodeSQLiteDatabase<any>;

    // Resolve the migrations folder for this scope.
    const migrationsFolder = resolveCorePackageMigrationsFolder(migrationsSetName(scope));

    // ── Seam 0 — cold-open critical section (THE T5158 HEAL · T11627 ST-3) ────
    // Lease the migrate/reconcile cold-open write-txn against the just-opened
    // native handle so EXACTLY ONE process per scope runs it while concurrent
    // cold-open peers BEGIN IMMEDIATE-queue and then observe a ready DB. This heals
    // the T5158 `E_NOT_INITIALIZED` / `E_INTERNAL` corruption (concurrent cold-open
    // migrate write-txns racing the consolidated cleo.db's single shared
    // `__drizzle_migrations` journal) WITH the supervisor daemon disabled (`local`
    // mode default). `off` mode is a pass-through → byte-identical to pre-lease
    // behaviour (busy_timeout=30000 still serializes the write-txn).
    // `withColdOpenLease` also records the scope in the Seam-1 active-scope registry
    // so chokepoint write primitives lease correctly.
    //
    // The lease wraps ONLY reconcileJournal + migrateWithRetry — the precise write-
    // txn that races in T5158. The exodus-on-open hook runs AFTER the lease releases
    // (below): it owns its OWN single-flight lock + dedicated migrate connections,
    // and `runExodusMigrate` CLOSES + re-opens the scope handles, which would
    // close the very handle the lease row lives on mid-section. Releasing first is
    // both correct (exodus is already serialized) and necessary (no close-under-lease).
    const handle = await withColdOpenLease(
      scope,
      nativeDb,
      async (): Promise<DualScopeDbHandle> => {
        // Reconcile the migration journal (handles WAL/journal divergence across
        // SQLite version upgrades — same pattern as sqlite.ts / memory-sqlite.ts).
        // T11829: pass the OTHER lineages that share this scope's consolidated cleo.db
        // journal so their rows are not deleted as cross-lineage orphans (the confirmed
        // OOM root cause: each lineage previously deleted the others' rows so the shared
        // journal never converged).
        reconcileJournal(
          nativeDb,
          migrationsFolder,
          existenceTable(scope),
          `dual-scope-db[${scope}]`,
          resolveConsolidatedJournalSiblings(migrationsSetName(scope)),
        );

        // Run any pending migrations.
        migrateWithRetry(
          db,
          migrationsFolder,
          nativeDb,
          existenceTable(scope),
          `dual-scope-db[${scope}]`,
        );

        log.debug({ scope, dbPath }, 'dual-scope cleo.db ready');

        const built: DualScopeDbHandle = {
          db,
          scope,
          dbPath,
          close() {
            _cache.delete(key);
            try {
              nativeDb.close();
            } catch {
              // Idempotent — ignore double-close errors.
            }
          },
        };

        // Update the cache entry to mark init complete.
        const entry = _cache.get(key);
        if (entry) {
          entry.initPromise = null;
          entry.handle = built;
        }

        return built;
      },
      // Record this open's resolved dbPath in the Seam-1 registry so the chokepoint
      // write primitives lease their row in THIS file — not the cwd-default — when
      // more than one project's cleo.db is open in this process (T11627 Finding 1).
      { dbPath },
    );

    // ── Exodus-on-open (E6 · T11553) — runs AFTER the cold-open lease releases ──
    // Data-continuity safety net: on a canonical open where the consolidated
    // cleo.db is empty but the legacy fleet (tasks.db/brain.db/…) has rows for
    // THIS scope, lazily auto-migrate ONCE — gated by a parity verify, serialised
    // by a single-flight lock, rolled back to empty on parity failure (legacy
    // kept). Re-entrancy/concurrency are handled inside the hook. Lazy `import()`
    // breaks the cycle (exodus/migrate.ts imports openDualScopeDb from here).
    //
    // NOTE: `runExodusMigrate` CLOSES + evicts the dual-scope handles it opened
    // when it finishes, so after a `migrated`/`aborted` outcome the `handle`
    // built above (and its `nativeDb`) is CLOSED. We therefore re-open this scope
    // fresh (cache-miss, NOT armed — no `exodusCwd`) and return the new live
    // handle. That re-open flows through the cold-open lease again on a FRESH handle
    // (cheap claim/release — the DB is now migrated), with no contention against the
    // already-released outer lease.
    //
    // Armed ONLY when `exodusCwd` was threaded through the canonical
    // `openDualScopeDb` AND `dbPath` is the canonical path for that scope+cwd —
    // never for explicit-path opens (test fixtures / legacy-path domains).
    if (exodusCwd !== undefined && dbPath === resolveDualScopeDbPath(scope, exodusCwd)) {
      // ── T12001 (Epic T11992) — db-heavy admission for the exodus auto-migrate ──
      // The on-open exodus (reconcile + parity verify + migrate) is a heavy DB op;
      // letting it co-schedule with builds/tests/agents is a historical OOM vector.
      // Admit it through the governor's `db-heavy` class (machine-wide serialized;
      // deferred under memory backoff). On a denial we SKIP the migration THIS open
      // (kill-switch precedent CLEO_DISABLE_EXODUS_ON_OPEN) — NEVER block or defer
      // the interactive command (interactive-cli is never gated) — and it re-runs
      // idempotently on a calmer open. Fail-open: ANY governor error proceeds
      // un-gated, byte-identical to pre-T12001 behaviour.
      let releaseDbHeavy: (() => Promise<void>) | null = null;
      let dbHeavyDeferred = false;
      try {
        const { governor } = await import('../resources/governor.js');
        const admit = await governor.tryAcquire('db-heavy');
        if (admit.deferred) {
          dbHeavyDeferred = true;
        } else {
          releaseDbHeavy = admit.release;
        }
      } catch {
        // Governor unavailable — fail open (proceed un-gated).
      }
      if (dbHeavyDeferred) {
        log.debug(
          { scope, dbPath },
          'exodus-on-open skipped this open — db-heavy deferred under memory pressure ' +
            '(re-runs idempotently on a calmer open)',
        );
        return handle;
      }
      try {
        const { maybeRunExodusOnOpen } = await import('./exodus/on-open.js');
        const result = await maybeRunExodusOnOpen(scope, dbPath, nativeDb, exodusCwd);
        if (result.outcome === 'migrated' || result.outcome === 'aborted') {
          // The migrate engine closed our handle — re-open fresh (un-armed) so the
          // caller receives a valid, live handle bound to the now-(de)populated DB.
          const reopened =
            scope === 'project'
              ? await openDualScopeDbAtPath('project', dbPath)
              : await openDualScopeDbAtPath('global', dbPath);
          if (result.outcome === 'aborted') {
            // T11828 (DHQ-059): the data-continuity gate aborted — the consolidated
            // DB is empty + consistent, legacy kept as source. Surface this to a
            // MUTATING caller (read-only callers ignore it) by (a) stamping a
            // structured marker on the returned handle and (b) broadcasting a typed
            // event. The non-zero error itself is raised on the write path via
            // `assertWriteDurable(handle)` — NOT here, so read opens never throw.
            const abort: ExodusAbortDetail = {
              scope,
              dbPath,
              reason: result.reason,
              at: Date.now(),
            };
            log.warn(
              { scope, reason: result.reason },
              'exodus-on-open aborted; consolidated cleo.db left empty, legacy kept as source — ' +
                'mutating callers must check handle.exodusAbort / call assertWriteDurable (T11828)',
            );
            const { emitExodusAbort } = await import('./exodus/abort-events.js');
            emitExodusAbort(abort);
            return { ...reopened, exodusAbort: abort };
          }
          // A subsequent SUCCESSFUL migration resolves any prior abort recorded
          // for this scope, so writes are no longer rejected (T11828).
          const { clearExodusAborts } = await import('./exodus/abort-events.js');
          clearExodusAborts(scope);
          return reopened;
        }
      } catch (err) {
        // Best-effort safety net: a hook failure must not make the DB
        // unopenable. Warn and re-open fresh; `cleo exodus migrate` remains the
        // manual path. (The handle may have been closed mid-migrate.)
        log.warn(
          { err, scope },
          'exodus-on-open hook failed (non-fatal); re-opening consolidated handle',
        );
        return scope === 'project'
          ? openDualScopeDbAtPath('project', dbPath)
          : openDualScopeDbAtPath('global', dbPath);
      } finally {
        // Release the db-heavy slot on EVERY exit path (early returns above run
        // `finally` first). Idempotent; release errors are swallowed.
        if (releaseDbHeavy) await releaseDbHeavy().catch(() => {});
      }
    }

    return handle;
  })();

  // Store a placeholder with the in-flight promise so concurrent callers wait.
  _cache.set(key, {
    // biome-ignore lint/suspicious/noExplicitAny: placeholder until initPromise resolves
    handle: null as any,
    // biome-ignore lint/suspicious/noExplicitAny: nativeDb not available yet
    nativeDb: null as any,
    initPromise,
  });

  // Defense-in-depth: if init REJECTS, evict the placeholder so a transient open
  // failure (e.g. a one-shot migration crash) does not POISON the cache. Without
  // this, the rejected promise stays in `_cache` and every later caller hits
  // `return existing.initPromise` (above) and re-receives the same rejection —
  // which the engine's bare catch then surfaces as "Task database not
  // initialized" forever. Only evict if the SAME placeholder entry is still
  // present (a successful init replaces `initPromise` with `null`, so this guard
  // never clobbers a healthy cached handle). Returns the original (rejecting)
  // promise unchanged so callers still see the real error.
  initPromise.catch(() => {
    const entry = _cache.get(key);
    if (entry && entry.initPromise === initPromise) {
      _cache.delete(key);
    }
  });

  return initPromise;
}

/**
 * Reset cached dual-scope handles. Primarily for use in tests between test
 * cases and by domain `closeDb()`/`resetDbState()` paths. Closes the targeted
 * open handles before evicting them from the cache.
 *
 * ## Scope filter (E6-L4 · T11524)
 *
 * Pass `scope` to evict ONLY that scope's entries. This matters because the
 * `'project'` and `'global'` scopes now share this cache: the tasks/brain/conduit
 * domains hold the project-scope `cleo.db`, while nexus/signaldock/skills hold the
 * global-scope `cleo.db`. A project-domain reset (`closeDb`/`resetDbState` in
 * sqlite.ts) must NOT close the global handle out from under an in-flight nexus
 * query — and vice-versa. When `scope` is omitted, ALL entries are evicted (the
 * coordinated full teardown used by `closeAllDatabases` and test global resets).
 *
 * @param scope - When provided, only entries opened against this scope are
 *   closed + evicted. When omitted, every cached handle is reset.
 * @internal
 */
export function _resetDualScopeDbCache(scope?: DualScope): void {
  for (const [key, entry] of _cache) {
    // Skip entries that belong to a different scope when a scope filter is set.
    // A mid-init placeholder (handle === null) cannot be scope-matched, so it is
    // only evicted on a full (unscoped) reset.
    if (scope !== undefined && entry.handle?.scope !== scope) continue;
    if (entry.handle) {
      try {
        entry.handle.close();
      } catch {
        // ignore
      }
    }
    // handle.close() already deletes the key for the targeted entry; delete
    // defensively in case the handle was a mid-init placeholder.
    _cache.delete(key);
  }
  // Only reset the schema caches on a full (unscoped) reset — a scoped reset must
  // not force the OTHER scope to reload its schema barrel mid-flight.
  if (scope === undefined) {
    _projectSchema = null;
    _globalSchema = null;
  }
}

// ── Idempotent write helpers (E4-T2 · T11513) ───────────────────────────────

import type { InferInsertModel } from 'drizzle-orm';
import type { SQLiteTableWithColumns, TableConfig } from 'drizzle-orm/sqlite-core';

/**
 * Attempt to insert `row` into `table`. If a row with the same value for
 * `keyColumn` already exists (UNIQUE conflict), the insert is silently skipped.
 *
 * Wraps Drizzle v1's `.onConflictDoNothing()` to provide a type-safe,
 * retry-safe idempotent insert for tables that carry an `idempotency_key`
 * column or any other UNIQUE column.
 *
 * @param db - The Drizzle database handle (project or global scope).
 * @param table - The Drizzle table reference from the consolidated schema.
 * @param row - The row data to insert (all required columns).
 * @param _keyColumn - The column name to conflict on (informational; the
 *   conflict resolution is applied table-wide via `.onConflictDoNothing()`).
 *   Pass the column name as a hint for documentation purposes.
 * @returns The number of rows actually inserted (0 or 1).
 *
 * Refuses the write (throws {@link ExodusAbortWriteUnsafeError}) when a prior
 * exodus-on-open aborted in this process (T11828 · DHQ-059) — these helpers are
 * the consolidated-schema MUTATION primitives, so the guard is write-only and
 * never affects read paths.
 *
 * @example
 * ```ts
 * import { tasksTasksTable } from '@cleocode/core/store/schema/cleo-project';
 * const inserted = await insertIdempotent(db, tasksTasksTable, newTask, 'idempotencyKey');
 * ```
 *
 * @task T11513 (E4-T2)
 * @task T11828 (write-side exodus-abort guard)
 * @epic T11247 (E4)
 * @saga T11242
 */
export async function insertIdempotent<TTable extends SQLiteTableWithColumns<TableConfig>>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts both project and global schema handles
  db: NodeSQLiteDatabase<any>,
  table: TTable,
  row: InferInsertModel<TTable>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _keyColumn: string,
): Promise<number> {
  assertNoRecordedExodusAbort();
  // Seam 1 (T11627 ST-3): gate the chokepoint write through the writer lease so
  // it serializes with the leased cold-open (Seam 0) and every other chokepoint
  // write in the process. The scope AND dbPath come from the process-local
  // active-scope registry recorded at cold-open ({@link activeScope} /
  // {@link activeScopeDbPath}) — no signature change. Pinning the dbPath keeps the
  // lease row in the SAME file this write targets when multiple projects are open
  // (T11627 Finding 1). `off` mode is a pass-through (busy_timeout serializes).
  return withWriterLease(
    activeScope(),
    'tasks',
    async () => {
      const result = await db.insert(table).values(row).onConflictDoNothing().returning();
      return result.length;
    },
    { dbPath: activeScopeDbPath() },
  );
}

/**
 * Upsert `row` into `table`, updating all non-key columns when a row with
 * the same `keyColumn` value already exists.
 *
 * Wraps Drizzle v1's `.onConflictDoUpdate()` for retry-safe upsert semantics.
 *
 * @param db - The Drizzle database handle.
 * @param table - The Drizzle table reference.
 * @param row - The row data to insert or update.
 * @param keyColumn - The conflict-target column name (must be a UNIQUE or
 *   PRIMARY KEY column on the table).
 * @param conflictTarget - The column reference used as the `.target` for
 *   `.onConflictDoUpdate()`. Pass the Drizzle column reference (e.g.
 *   `table.idempotencyKey`).
 * @param set - The columns to update on conflict. If omitted, all columns
 *   in `row` are used as the update set.
 * @returns The number of rows inserted or updated (always 1).
 *
 * Refuses the write (throws {@link ExodusAbortWriteUnsafeError}) when a prior
 * exodus-on-open aborted in this process (T11828 · DHQ-059) — write-only guard.
 *
 * @example
 * ```ts
 * await upsertIdempotent(db, tasksTasksTable, updatedTask, 'idempotencyKey',
 *   tasksTasksTable.idempotencyKey);
 * ```
 *
 * @task T11513 (E4-T2)
 * @task T11828 (write-side exodus-abort guard)
 * @epic T11247 (E4)
 * @saga T11242
 */
export async function upsertIdempotent<TTable extends SQLiteTableWithColumns<TableConfig>>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts both project and global schema handles
  db: NodeSQLiteDatabase<any>,
  table: TTable,
  row: InferInsertModel<TTable>,
  /** The conflict-target column name (informational hint for callers). */
  _keyColumn: string,
  // biome-ignore lint/suspicious/noExplicitAny: column reference type varies by table
  conflictTarget: any,
  set?: Partial<InferInsertModel<TTable>>,
): Promise<number> {
  assertNoRecordedExodusAbort();
  // Seam 1 (T11627 ST-3): gate the chokepoint upsert through the writer lease —
  // same active-scope-registry path as insertIdempotent (scope + pinned dbPath),
  // no signature change.
  return withWriterLease(
    activeScope(),
    'tasks',
    async () => {
      const updateSet = set ?? row;
      const result = await db
        .insert(table)
        .values(row)
        .onConflictDoUpdate({
          target: conflictTarget,
          // biome-ignore lint/suspicious/noExplicitAny: updateSet shape varies by table; type-safe at call sites
          set: updateSet as any,
        })
        .returning();
      return result.length;
    },
    { dbPath: activeScopeDbPath() },
  );
}
