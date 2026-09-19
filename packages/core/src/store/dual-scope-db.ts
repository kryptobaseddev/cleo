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
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { getCleoHome, resolveCleoDir, worktreeScope } from '../paths.js';
import { observeOperation } from './background-ops.js';
import { type ExodusAbortDetail, getRecordedExodusAbort } from './exodus/abort-events.js';
import { migrateWithRetry, reconcileJournal } from './migration-manager.js';
import {
  resolveConsolidatedJournalSiblings,
  resolveCorePackageMigrationsFolder,
} from './resolve-migrations-folder.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';
import {
  makeWriterLeaseIdentity,
  registerDbIdentity,
  resolveDbIdentity,
  type WriterLeaseIdentity,
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
export type CleoProjectDb = NodeSQLiteDatabase;

/** Typed Drizzle handle for the global-scope `cleo.db`. */
export type CleoGlobalDb = NodeSQLiteDatabase;

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
   * Immutable writer-lease identity bound to this exact handle at construction
   * (T12042). The chokepoint write primitives derive scope + dbPath from this
   * identity via {@link resolveDbIdentity} — a caller cannot pair file-A
   * identity with file-B DB. Frozen and normalized.
   */
  readonly identity: WriterLeaseIdentity;
  /**
   * Whether the underlying native `DatabaseSync` connection is still
   * open. Reflects `nativeDb.isOpen` and is `false` after `close()`.
   */
  readonly isOpen: boolean;
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
 * Obtain the native connection owned by an already-open dual-scope handle.
 *
 * Validates the driver's runtime client instead of casting the schema-typed
 * Drizzle database, whose public type does not expose `$client`.
 *
 * @param handle - Exact cached or dedicated handle whose connection is required.
 * @returns Its native SQLite connection; ownership remains with the handle.
 * @throws When the driver exposes no native SQLite connection.
 * @remarks Dedicated migration handles retain independent connection ownership.
 * @example
 * ```ts
 * const native = getDualScopeNativeDb(handle);
 * native.prepare('SELECT 1').get();
 * ```
 */
export function getDualScopeNativeDb(handle: DualScopeDbHandle): DatabaseSync {
  const db = handle.db;
  if ('$client' in db && db.$client instanceof getDatabaseSyncCtor()) return db.$client;
  throw new Error(`No native SQLite connection for ${handle.scope}::${handle.dbPath}`);
}

/**
 * Options for {@link openDualScopeDbAtPath}.
 *
 * @task T11782 (FIX D — dedicated migrate connection)
 */
export interface OpenDualScopeAtPathOptions {
  /** Captured operation lifetime; defaults to the existing async routing scope when present. */
  readonly execution?: OperationExecutionContext;
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
  execution?: OperationExecutionContext;
  handle: DualScopeDbHandle | null;
  nativeDb: DatabaseSync | null;
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
 * @param options - Optional dedicated handle and captured operation lifetime.
 * @throws Error if the operation expires or a nested call replaces its captured context.
 * @remarks Cancellation guards asynchronous continuations and publication, but cannot
 * preempt synchronous SQLite work. A cancelled initializer never closes a published
 * handle which another caller may already use.
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
  options?: OpenDualScopeAtPathOptions,
): Promise<DualScopeDbHandle<'project'>>;
export async function openDualScopeDb(
  scope: 'global',
  cwd?: string,
  options?: OpenDualScopeAtPathOptions,
): Promise<DualScopeDbHandle<'global'>>;
export async function openDualScopeDb(
  scope: DualScope,
  cwd?: string,
  options?: OpenDualScopeAtPathOptions,
): Promise<DualScopeDbHandle> {
  const inherited = worktreeScope.getStore()?.execution;
  if (inherited && options?.execution && inherited !== options.execution) {
    throw new Error('Nested database opening cannot replace its captured execution context');
  }
  const execution = options?.execution ?? inherited;
  execution?.assertActive();
  const open = () => {
    const dbPath = resolveDualScopeDbPath(scope, cwd);
    // Dispatch on the scope literal so the overloaded path-aware opener resolves to
    // the correct typed return; the union `scope` cannot satisfy either literal
    // overload directly. The `cwd` is forwarded so the exodus-on-open hook
    // (E6 · T11553) can build a correct legacy-source plan for THIS canonical
    // open. The explicit-path form (test fixtures / legacy-path domains) never
    // receives a `cwd` and therefore never auto-migrates.
    return scope === 'project'
      ? openDualScopeDbAtPath('project', dbPath, cwd, options)
      : openDualScopeDbAtPath('global', dbPath, cwd, options);
  };
  return execution
    ? worktreeScope.run(
        {
          worktreeRoot: execution.identity.projectRoot,
          projectHash: execution.identity.projectId,
          execution,
        },
        open,
      )
    : open();
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
  execution?: OperationExecutionContext,
): Promise<DualScopeDbHandle> {
  execution?.assertActive();
  log.debug({ scope, dbPath }, 'opening DEDICATED (non-cached) dual-scope cleo.db (T11782 FIX D)');

  // Ensure the directory exists before opening.
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  execution?.assertActive();
  const DatabaseSyncCtor = getDatabaseSyncCtor();
  const nativeDb = new DatabaseSyncCtor(dbPath, { allowExtension: true });

  // Every operation after construction is wrapped so any exception —
  // pragmas, Drizzle wrapping, migration-folder resolution, lease, or
  // migration — closes the native handle before rethrow.
  try {
    // T11829: bound per-connection memory for one-shot/CLI opens (full SSoT for daemon).
    applyPerfPragmas(nativeDb, memoryBoundedPragmaOverrides());

    const drizzle = getDrizzle();
    // biome-ignore lint/suspicious/noExplicitAny: dual-scope handle is untyped at construction; typed via DualScopeDbHandle<TScope>
    const db = drizzle({ client: nativeDb }) as NodeSQLiteDatabase<any>;

    const migrationsFolder = resolveCorePackageMigrationsFolder(migrationsSetName(scope));

    // ── Cold-open lease (F4 · T12036) ──────────────────────────────────────
    // Dedicated opens also serialize their cold-open migrations through the same
    // writer-lease so they never race on the `__drizzle_migrations` journal
    // even when two dedicated opens of a fresh file are concurrent.
    const handle = await withColdOpenLease(
      scope,
      nativeDb,
      async (): Promise<DualScopeDbHandle> => {
        execution?.assertActive();
        reconcileJournal(
          nativeDb,
          migrationsFolder,
          existenceTable(scope),
          `dual-scope-db[${scope}]`,
          resolveConsolidatedJournalSiblings(migrationsSetName(scope)),
        );
        execution?.assertActive();
        migrateWithRetry(
          db,
          migrationsFolder,
          nativeDb,
          existenceTable(scope),
          `dual-scope-db[${scope}]`,
        );

        execution?.assertActive();
        log.debug({ scope, dbPath }, 'DEDICATED dual-scope cleo.db ready (T11782 FIX D)');

        const identity = makeWriterLeaseIdentity(scope, dbPath);
        registerDbIdentity(db, identity);

        return {
          db,
          scope,
          dbPath,
          identity,
          get isOpen() {
            return nativeDb.isOpen;
          },
          close() {
            // Dedicated handles are never cached — close only the native connection.
            try {
              nativeDb.close();
            } catch {
              // Idempotent — ignore double-close errors.
            }
          },
        };
      },
      { execution },
    );

    execution?.assertActive();
    return handle;
  } catch (err) {
    // Close the native handle on any failure after construction to avoid
    // leaking a file descriptor. The primary error is rethrown unchanged.
    try {
      nativeDb.close();
    } catch {
      // Already closed or never opened — safe to ignore.
    }
    throw err;
  }
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
 * @param exodusCwd - Internal canonical root enabling migration-on-open checks.
 * @param options - Optional dedicated handle and captured operation lifetime.
 * @throws Error if opening, migration, cancellation, or initializer ownership checks fail.
 * @remarks Scoped cancellation is cooperative; synchronous SQLite work can overrun
 * the deadline. Live waiters may retry after their initializing caller is cancelled.
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
  const inherited = worktreeScope.getStore()?.execution;
  if (inherited && options?.execution && inherited !== options.execution) {
    throw new Error('Nested database opening cannot replace its captured execution context');
  }
  const execution = options?.execution ?? inherited;
  execution?.assertActive();
  if (execution && !inherited) {
    return worktreeScope.run(
      {
        worktreeRoot: execution.identity.projectRoot,
        projectHash: execution.identity.projectId,
        execution,
      },
      () =>
        scope === 'project'
          ? openDualScopeDbAtPath('project', dbPath, exodusCwd, options)
          : openDualScopeDbAtPath('global', dbPath, exodusCwd, options),
    );
  }
  const dedicated = options?.dedicated === true;
  // Normalize the path before keying so equivalent spellings share one
  // cache entry — the chokepoint key mirrors the runtime's path.resolve.
  const normalizedPath = resolve(dbPath);
  const key = cacheKey(scope, normalizedPath);

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
        try {
          if (!execution) return await existing.initPromise;
          const observed = await observeOperation(execution, existing.initPromise);
          if (!observed.settled) throw observed.reason;
          if (!observed.success) throw observed.error;
          execution.assertActive();
          return observed.value;
        } catch (error) {
          execution?.assertActive();
          if (existing.execution?.signal.aborted && existing.execution !== execution) {
            // The cancelled initializer owns only its unpublished connection. A live
            // waiter gets its own attempt rather than inheriting that cancellation.
            return scope === 'project'
              ? openDualScopeDbAtPath('project', normalizedPath, exodusCwd, options)
              : openDualScopeDbAtPath('global', normalizedPath, exodusCwd, options);
          }
          throw error;
        }
      }
      if (existing.handle && existing.nativeDb?.isOpen) {
        return existing.handle;
      }
      _cache.delete(key);
    }
  }

  const log = getLogger('dual-scope-db');

  if (dedicated) {
    return openDedicatedDualScopeDb(scope, normalizedPath, log, execution);
  }

  // Create a placeholder entry so concurrent callers wait for the same init.
  // MUST run BEFORE the async IIFE is defined: the IIFE starts executing
  // synchronously, and the cold-open callback inside withColdOpenLease runs
  // synchronously before the outer IIFE yields — if the placeholder entry
  // doesn't exist yet, the callback cannot find and update it (T12035).
  let initResolve: ((h: DualScopeDbHandle) => void) | null = null;
  let initReject: ((e: unknown) => void) | null = null;
  const initPromise = new Promise<DualScopeDbHandle>((resolve, reject) => {
    initResolve = resolve;
    initReject = reject;
  });

  _cache.set(key, {
    execution,
    handle: null,
    nativeDb: null,
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

  // Start the actual init work. The IIFE is a fire-and-forget callback that
  // resolves/rejects the externally-created initPromise. Separating promise
  // creation from the async IIFE ensures the cache placeholder exists before
  // any synchronous work runs inside withColdOpenLease's fn callback (T12035).
  (async (): Promise<void> => {
    let openingNative: DatabaseSync | null = null;
    let published = false;
    try {
      execution?.assertActive();
      log.debug({ scope, dbPath: normalizedPath }, 'opening dual-scope cleo.db');

      // Ensure the directory exists before opening.
      const dir = dirname(normalizedPath);
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
      execution?.assertActive();
      const DatabaseSyncCtor = getDatabaseSyncCtor();
      const nativeDb = new DatabaseSyncCtor(normalizedPath, { allowExtension: true });
      openingNative = nativeDb;

      // Apply canonical pragma set (specs/sqlite-pragmas.json SSoT), bounding
      // per-connection memory for one-shot/CLI opens (full SSoT for daemon) — T11829.
      applyPerfPragmas(nativeDb, memoryBoundedPragmaOverrides());

      // Create the Drizzle ORM wrapper.
      const drizzle = getDrizzle();
      // biome-ignore lint/suspicious/noExplicitAny: dual-scope handle is untyped at construction; typed via DualScopeDbHandle<TScope>
      const db = drizzle({ client: nativeDb }) as NodeSQLiteDatabase<any>;

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
      // The identity is bound to the drizzle DB handle via
      // registerDbIdentity during construction — the chokepoint write
      // primitives resolve it from the exact handle binding (T12042), no
      // longer from a process-global active-scope registry.
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
          execution?.assertActive();
          reconcileJournal(
            nativeDb,
            migrationsFolder,
            existenceTable(scope),
            `dual-scope-db[${scope}]`,
            resolveConsolidatedJournalSiblings(migrationsSetName(scope)),
          );

          // Run any pending migrations.
          execution?.assertActive();
          migrateWithRetry(
            db,
            migrationsFolder,
            nativeDb,
            existenceTable(scope),
            `dual-scope-db[${scope}]`,
          );

          execution?.assertActive();
          log.debug({ scope, dbPath: normalizedPath }, 'dual-scope cleo.db ready');

          const identity = makeWriterLeaseIdentity(scope, normalizedPath);
          registerDbIdentity(db, identity);

          const built: DualScopeDbHandle = {
            db,
            scope,
            dbPath: normalizedPath,
            identity,
            get isOpen() {
              return nativeDb.isOpen;
            },
            close() {
              // Identity-guarded deletion: only evict from the singleton cache
              // when the current entry still references THIS exact handle. A stale
              // store close after a replacement was opened leaves the replacement
              // intact. The native connection is always closed regardless.
              const entry = _cache.get(key);
              if (entry?.handle === built) {
                _cache.delete(key);
              }
              try {
                nativeDb.close();
              } catch {
                // Idempotent — ignore double-close errors.
              }
            },
          };

          execution?.assertActive();
          // Update the cache entry to mark init complete.
          const entry = _cache.get(key);
          if (!entry || entry.initPromise !== initPromise) {
            throw new Error('Database initialization lost its cache ownership before publication');
          }
          if (entry) {
            entry.initPromise = null;
            entry.handle = built;
            entry.nativeDb = nativeDb;
            published = true;
          }

          return built;
        },
        { execution },
      );

      // ── Exodus-on-open (E6 · T11553) — runs AFTER the cold-open lease releases ──
      // Data-continuity safety net: on a canonical open where the consolidated
      // cleo.db is empty but the legacy fleet (tasks.db/brain.db/…) has rows for
      // THIS scope, lazily auto-migrate ONCE — gated by a parity verify, serialised
      // by a single-flight lock, rolled back to empty on parity failure (legacy
      // kept). Re-entrancy/concurrency are handled inside the hook. Lazy `import()`
      // breaks the cycle (exodus/migrate.ts imports openDualScopeDb from here).
      //
      // NOTE: `runExodusMigrate` opens DEDICATED connections (not cached).
      // When the migration finishes those dedicated handles close only their own
      // `DatabaseSync` — they never touch the singleton `_cache`. After a
      // `migrated`/`aborted` outcome the `handle` built above (and its
      // `nativeDb`) is CLOSED. We therefore re-open this scope fresh
      // (cache-miss, NOT armed — no `exodusCwd`) and return the new live
      // handle. That re-open flows through the cold-open lease again on a FRESH handle
      // (cheap claim/release — the DB is now migrated), with no contention against the
      // already-released outer lease.
      //
      // Armed ONLY when `exodusCwd` was threaded through the canonical
      // `openDualScopeDb` AND `dbPath` is the canonical path for that scope+cwd —
      // never for explicit-path opens (test fixtures / legacy-path domains).
      execution?.assertActive();
      let finalHandle = handle;
      if (exodusCwd !== undefined && normalizedPath === resolveDualScopeDbPath(scope, exodusCwd)) {
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
          execution?.assertActive();
          const { governor } = await import('../resources/governor.js');
          execution?.assertActive();
          const admit = await governor.tryAcquire('db-heavy');
          if (admit.deferred) {
            dbHeavyDeferred = true;
          } else {
            releaseDbHeavy = admit.release;
          }
        } catch {
          execution?.assertActive();
          // Governor unavailable — fail open (proceed un-gated).
        }
        if (dbHeavyDeferred) {
          execution?.assertActive();
          log.debug(
            { scope, dbPath: normalizedPath },
            'exodus-on-open skipped this open — db-heavy deferred under memory pressure ' +
              '(re-runs idempotently on a calmer open)',
          );
        } else {
          try {
            execution?.assertActive();
            const { maybeRunExodusOnOpen } = await import('./exodus/on-open.js');
            execution?.assertActive();
            const result = await maybeRunExodusOnOpen(scope, normalizedPath, nativeDb, exodusCwd);
            execution?.assertActive();
            if (result.outcome === 'migrated' || result.outcome === 'aborted') {
              // The migrate engine closed our handle — re-open fresh (un-armed) so the
              // caller receives a valid, live handle bound to the now-(de)populated DB.
              const reopened =
                scope === 'project'
                  ? await openDualScopeDbAtPath('project', normalizedPath)
                  : await openDualScopeDbAtPath('global', normalizedPath);
              if (result.outcome === 'aborted') {
                // T11828 (DHQ-059): the data-continuity gate aborted — the consolidated
                // DB is empty + consistent, legacy kept as source. Surface this to a
                // MUTATING caller (read-only callers ignore it) by (a) stamping a
                // structured marker on the returned handle and (b) broadcasting a typed
                // event. The non-zero error itself is raised on the write path via
                // `assertWriteDurable(handle)` — NOT here, so read opens never throw.
                const abort: ExodusAbortDetail = {
                  scope,
                  dbPath: normalizedPath,
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
                finalHandle = { ...reopened, exodusAbort: abort };
              } else {
                // A subsequent SUCCESSFUL migration resolves any prior abort recorded
                // for this scope, so writes are no longer rejected (T11828).
                const { clearExodusAborts } = await import('./exodus/abort-events.js');
                clearExodusAborts(scope);
                finalHandle = reopened;
              }
            }
          } catch (err) {
            execution?.assertActive();
            // Best-effort safety net: a hook failure must not make the DB
            // unopenable. Warn and re-open fresh; `cleo exodus migrate` remains the
            // manual path. (The handle may have been closed mid-migrate.)
            log.warn(
              { err, scope },
              'exodus-on-open hook failed (non-fatal); re-opening consolidated handle',
            );
            finalHandle =
              scope === 'project'
                ? await openDualScopeDbAtPath('project', normalizedPath)
                : await openDualScopeDbAtPath('global', normalizedPath);
          } finally {
            // Release the db-heavy slot on EVERY exit path (early returns above run
            // `finally` first). Idempotent; release errors are swallowed.
            if (releaseDbHeavy) await releaseDbHeavy().catch(() => {});
          }
        }
      }

      execution?.assertActive();
      initResolve!(finalHandle);
    } catch (err) {
      // Only the unpublished connection belongs exclusively to this initializer.
      // Published handles may already be in use by another caller.
      try {
        if (!published && openingNative?.isOpen) openingNative.close();
      } catch (closeError) {
        log.warn({ closeError }, 'failed to close unpublished database initializer');
      }
      initReject!(err);
    }
  })();

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
}

// ── CleoRuntime store registry (E6-L12 · T12036) ───────────────────────────────

/**
 * A typed handle to a single project's consolidated `cleo.db`, keyed by canonical
 * database path. Obtained from {@link CleoRuntime.openProject}.
 *
 * Each {@link ProjectStore} wraps ONE shared {@link DualScopeDbHandle} — closing
 * it affects only this project; other projects and the global scope are untouched.
 *
 * ## Lifecycle identity
 *
 * Every store carries an opaque identity tag. Its `close()` is stale-safe: it only
 * evicts the registry entry when that entry still belongs to THIS store (not a
 * replacement opened after close). An old stale `close()` is a no-op.
 *
 * @task T12036 (E6-L12)
 * @epic T11249 (E6)
 * @saga T11242
 */
export interface ProjectStore {
  /** The literal scope discriminator. */
  readonly scope: 'project';
  /** Absolute on-disk path to this project's `cleo.db`. */
  readonly dbPath: string;
  /**
   * Immutable writer-lease identity bound to this store's underlying
   * {@link DualScopeDbHandle} at construction (T12042).
   */
  readonly identity: WriterLeaseIdentity;
  /** The typed Drizzle ORM handle for the project-scope consolidated schema. */
  readonly db: CleoProjectDb;
  /**
   * Whether the underlying native `DatabaseSync` connection is still
   * open. `false` after `close()`. Delegates to
   * {@link DualScopeDbHandle.isOpen}.
   */
  readonly isOpen: boolean;
  /**
   * Set when the exodus-on-open auto-migration aborted for this project
   * (T11828 · DHQ-059). `undefined` on a normal open.
   */
  readonly exodusAbort?: ExodusAbortDetail;
  /**
   * Close this project's handle and evict it from the runtime registry
   * if-and-only-if the registry still points to this store. Safe to call
   * multiple times (idempotent). Does NOT affect the global scope or other
   * open projects.
   */
  close(): void;
}

/**
 * A typed handle to the global consolidated `cleo.db`, keyed by canonical
 * database path. Obtained from {@link CleoRuntime.openGlobal}.
 *
 * The {@link GlobalStore} wraps the shared dual-scope chokepoint handle —
 * closing it only disposes the global entry, never any project.
 *
 * ## Lifecycle identity
 *
 * Same stale-safe semantics as {@link ProjectStore}: an old `close()` after a
 * reopen is a no-op.
 *
 * @task T12036 (E6-L12)
 * @epic T11249 (E6)
 * @saga T11242
 */
export interface GlobalStore {
  /** The literal scope discriminator. */
  readonly scope: 'global';
  /** Absolute on-disk path to the global `cleo.db`. */
  readonly dbPath: string;
  /**
   * Immutable writer-lease identity bound to this store's underlying
   * {@link DualScopeDbHandle} at construction (T12042).
   */
  readonly identity: WriterLeaseIdentity;
  /** The typed Drizzle ORM handle for the global-scope consolidated schema. */
  readonly db: CleoGlobalDb;
  /**
   * Whether the underlying native `DatabaseSync` connection is still
   * open. `false` after `close()`. Delegates to
   * {@link DualScopeDbHandle.isOpen}.
   */
  readonly isOpen: boolean;
  /**
   * Set when the exodus-on-open auto-migration aborted for the global scope
   * (T11828 · DHQ-059). `undefined` on a normal open.
   */
  readonly exodusAbort?: ExodusAbortDetail;
  /**
   * Close the global handle and evict it from the runtime registry
   * if-and-only-if the registry still points to this store. Safe to call
   * multiple times (idempotent).
   */
  close(): void;
}

/**
 * The CleoRuntime store registry — the explicit composition root that owns
 * project and global database entries keyed by canonical database path.
 *
 * Created via {@link createCleoRuntime}. Each entry in the registry is a
 * {@link ProjectStore} or {@link GlobalStore} that wraps a shared consolidated
 * {@link DualScopeDbHandle} obtained from the dual-scope chokepoint
 * ({@link openDualScopeDbAtPath}). The registry provides:
 *
 * - **Path-keyed identity** — entries are keyed by `${scope}::${canonical
 *   dbPath}` (scoped composite key), not cwd or "last opened project".
 *   Equivalent path spellings are normalized via `path.resolve` before keying
 *   so `/path/./to/cleo.db` and `/path/to/cleo.db` single-flight together.
 * - **Single-flight** — concurrent `openProject(p)` or `openGlobal()` calls
 *   for the same key share one initialization. If the entry is closed during
 *   that initialization, the acquired handle is closed and the openers reject.
 * - **Scoped disposal** — closing a project never closes another project or
 *   the global scope. `closeAll()` disposes every entry. Each store's `close()`
 *   is stale-safe: only evicts if the registry still references that exact
 *   store instance.
 * - **Cache-hit liveness** — when the underlying `DatabaseSync` was externally
 *   closed, the registry evicts and reopens (mirrors the dual-scope chokepoint
 *   pattern).
 *
 * ## Cross-runtime sharing
 *
 * Two separate {@link CleoRuntime} instances (created by independent calls to
 * {@link createCleoRuntime}) share the **process-global** dual-scope handle
 * cache (`_cache` in this module). A project opened by runtime A returns a
 * store whose `close()` closes that shared handle — runtime B's store for the
 * same path will observe `isOpen === false` on its store, and the
 * **cache-hit liveness** check in this runtime will reacquire a fresh handle
 * on the next `openProject`/`openGlobal`. This is by design: the runtime
 * registry owns **entry lifecycle**, not the underlying connection.
 *
 * For connection-level isolation, pass `{ dedicated: true }` to
 * {@link CleoRuntime.openProject} or {@link CleoRuntime.openGlobal}. This
 * opens a second `DatabaseSync` connection to the same file (WAL allows
 * concurrent connections), bypasses the shared chokepoint cache, and returns
 * a store whose `close()` closes only that dedicated connection. Dedicated
 * entries are NOT keyed or tracked by the runtime registry — they are
 * returned directly and the caller is responsible for closing them.
 *
 * @task T12036 (E6-L12)
 * @epic T11249 (E6)
 * @saga T11242
 */

/**
 * Options for {@link CleoRuntime.openProject} and
 * {@link CleoRuntime.openGlobal}.
 *
 * @task T12036 (E6-L12)
 */
export interface CleoRuntimeOpenOptions {
  /**
   * When `true`, open a DEDICATED, NON-cached connection — a second SQLite
   * handle to the same file, independent of the singleton `_cache`. The
   * returned store is NOT tracked in the runtime registry and its `close()`
   * closes only that dedicated connection. Used for isolation between
   * concurrent consumers (e.g. a snapshot worker, a migration engine).
   *
   * @default false
   */
  readonly dedicated?: boolean;

  /**
   * The project working directory that this open was resolved FROM.
   *
   * Forwarded verbatim to {@link openDualScopeDbAtPath} as its `exodusCwd`
   * argument, which is what arms the exodus-on-open legacy-fleet
   * auto-migration (E6 · T11553). {@link openDualScopeDb} passes its own
   * `cwd` for exactly this reason; a runtime open that omits it would
   * silently DISABLE auto-migration for users still carrying legacy
   * standalone `tasks.db` / `brain.db` files.
   *
   * Domain ports that replace a `getDb(cwd)`-style facade MUST forward the
   * caller's `cwd` here so behaviour is identical to the facade they retire.
   * Leave `undefined` for explicit-path opens (test fixtures, snapshots)
   * that must never auto-migrate.
   *
   * @task T12037 (E6-L13)
   */
  readonly exodusCwd?: string;
}

export interface CleoRuntime {
  /**
   * Open (or reuse) the project-scope `cleo.db` at the given path.
   *
   * The path may be relative or absolute — it is normalized via
   * `path.resolve()` before keying. The path MUST resolve to a project's
   * canonical `cleo.db` file (use {@link resolveDualScopeDbPath} to compute
   * it from a project root directory).
   *
   * Concurrent calls for the same normalized path single-flight — all callers
   * receive the same {@link ProjectStore} instance unless `dedicated: true`
   * was passed.
   *
   * @param dbPath - Absolute or relative path to the project's `cleo.db`.
   *   Normalized via `path.resolve()` before keying.
   * @param options - Optional open mode (e.g. `{ dedicated: true }`).
   * @returns A typed {@link ProjectStore} bound to the requested path.
   */
  openProject(dbPath: string, options?: CleoRuntimeOpenOptions): Promise<ProjectStore>;

  /**
   * Open (or reuse) the global-scope `cleo.db`. The path is resolved
   * internally via {@link getCleoHome}.
   *
   * Concurrent calls single-flight — all callers receive the same
   * {@link GlobalStore} instance unless `dedicated: true`.
   *
   * @param options - Optional open mode (e.g. `{ dedicated: true }`).
   * @returns A typed {@link GlobalStore} bound to the global scope.
   */
  openGlobal(options?: CleoRuntimeOpenOptions): Promise<GlobalStore>;

  /**
   * Open (or reuse) a global-scope `cleo.db` at an EXPLICIT path, bypassing the
   * `getCleoHome()` resolver.
   *
   * The path-aware sibling of {@link openGlobal}, mirroring
   * {@link openProject}. Exists for domains whose lifecycle API accepts an
   * explicit on-disk path — notably the skills registry's test-sandbox
   * `{ path }` override — so those opens still flow through ONE registry
   * instead of a private cache.
   *
   * Keyed as `global::<normalized path>`, so a sandbox file and the canonical
   * global `cleo.db` are distinct entries that never collide.
   *
   * @param dbPath - Absolute or relative path to a global-scope `cleo.db`.
   *   Normalized via `path.resolve()` before keying.
   * @param options - Optional open mode (e.g. `{ dedicated: true }`).
   * @returns A typed {@link GlobalStore} bound to the requested path.
   *
   * @task T12039 (E6-L15)
   */
  openGlobalAt(dbPath: string, options?: CleoRuntimeOpenOptions): Promise<GlobalStore>;

  /**
   * Close and evict a single project entry from the registry. The
   * underlying dual-scope handle is closed (evicted from the chokepoint
   * cache) and this project is removed from the registry map. Other
   * projects and the global scope are unaffected.
   *
   * If the project is mid-initialization, the in-flight open is cancelled:
   * its acquired handle is closed and its promise rejects.
   *
   * Idempotent — a path not in the registry is a no-op.
   *
   * @param dbPath - The path previously passed to {@link openProject}.
   *   Normalized internally.
   */
  closeProject(dbPath: string): void;

  /**
   * Close and evict every entry in the registry. Disposes all project
   * handles and the global handle if open. Cancels any in-flight opens.
   * Safe to call multiple times.
   */
  closeAll(): void;

  /**
   * The set of composite registry keys (`scope::normalizedDbPath`)
   * currently tracked by this runtime. The key format matches the
   * internal scope-qualified cache key and distinguishes a project
   * path from a global path that happens to share the same spelling.
   *
   * Read-only snapshot — concurrent opens/closes may race the snapshot.
   */
  readonly openPaths: ReadonlySet<string>;
}

/**
 * Opaque identity tag carried by every store for stale-safe close.
 */
type EntryId = number;

/**
 * Internal mutable state for a single runtime entry.
 */
interface RuntimeEntry {
  id: EntryId;
  store: ProjectStore | GlobalStore | null;
  initPromise: Promise<ProjectStore | GlobalStore> | null;
}

/**
 * Error thrown when a runtime entry is cancelled during initialization
 * (e.g. {@link CleoRuntime.closeProject} called while an open is in flight).
 */
class EntryCancelledError extends Error {
  constructor(scope: DualScope, dbPath: string) {
    super(`CleoRuntime entry cancelled during initialization: ${scope}::${dbPath}`);
    this.name = 'EntryCancelledError';
  }
}

/**
 * Thrown when the post-await liveness reacquisition exhausts its bounded
 * retries — two consecutive opens returned a dead handle. The caller can
 * distinguish a transient liveness loss (one retry succeeds) from a
 * persistent failure (both handles dead).
 *
 * @task T12036 (E6-L12)
 */
class LivenessExhaustedError extends Error {
  constructor(scope: DualScope, dbPath: string) {
    super(`CleoRuntime liveness exhausted after bounded reacquisition: ${scope}::${dbPath}`);
    this.name = 'LivenessExhaustedError';
  }
}

/**
 * Concrete implementation of the {@link CleoRuntime} store registry.
 *
 * Maintains a private `Map<string, RuntimeEntry>` keyed by the scope-qualified
 * composite `${scope}::${normalizedDbPath}`. Each call to {@link openProject}
 * or {@link openGlobal} flows through the existing dual-scope chokepoint
 * ({@link openDualScopeDbAtPath}) so migrations, pragmas, and the singleton
 * `_cache` are shared — the runtime adds explicit per-entry wrapping, identity
 * tracking, and scoped disposal on top.
 *
 * ## Key invariants
 *
 * 1. **Scope-qualified keys** — `'project::/abs/path'` and
 *    `'global::/abs/path'` are distinct keys even when the path is the same
 *    string. A `GlobalStore` can never be cast to a `ProjectStore` via a
 *    key collision.
 * 2. **Entry identity** — every entry carries a monotonically-increasing `id`.
 *    After `await openDualScopeDbAtPath`, the init publishes ONLY when the
 *    current entry's `id` still matches. If another call (close/re-open)
 *    replaced the entry, the acquired handle is closed and the init rejects.
 * 3. **Stale-safe close** — each store records its entry `id`. `close()` only
 *    evicts the registry entry when its `id` still matches; an old stale close
 *    is a no-op.
 * 4. **Cache-hit liveness** — before returning a cached store, the runtime
 *    checks {@link ProjectStore.isOpen} / {@link GlobalStore.isOpen}
 *    (which delegates to {@link DualScopeDbHandle.isOpen}, a typed getter
 *    reflecting the underlying `DatabaseSync.isOpen`). A handle closed
 *    externally (e.g. `_resetDualScopeDbCache`) is evicted and re-opened.
 * 5. **Path normalization** — all paths are normalized via `path.resolve()`
 *    before keying, so `/path/./to/db` and `/path/to/db` share one entry.
 * 6. **Dedicated mode** — passing `{ dedicated: true }` opens a second
 *    `DatabaseSync` connection (WAL-allowed) that bypasses the shared cache.
 *    Dedicated stores are NOT registered or tracked; the caller is responsible
 *    for closing them.
 *
 * @task T12036 (E6-L12)
 */
class CleoRuntimeImpl implements CleoRuntime {
  private readonly _registry = new Map<string, RuntimeEntry>();
  private _nextId: EntryId = 0;

  /**
   * Injectable opener function. Defaults to {@link openDualScopeDbAtPath}.
   * Tests override this to return a pre-closed handle for exercising the
   * post-await liveness branch. Not part of the public {@link CleoRuntime}
   * interface.
   */
  openDualScopeFn: typeof openDualScopeDbAtPath = openDualScopeDbAtPath;

  /** @inheritdoc */
  get openPaths(): ReadonlySet<string> {
    return new Set(this._registry.keys());
  }

  /** @inheritdoc */
  async openProject(dbPath: string, options?: CleoRuntimeOpenOptions): Promise<ProjectStore> {
    const normalized = resolve(dbPath);
    if (options?.dedicated) {
      const handle = await openDualScopeDbAtPath('project', normalized, options?.exodusCwd, {
        dedicated: true,
      });
      return this.buildStore('project', handle, 0) as ProjectStore;
    }
    return this.openEntry('project', normalized, 0, options?.exodusCwd) as Promise<ProjectStore>;
  }

  /** @inheritdoc */
  async openGlobal(options?: CleoRuntimeOpenOptions): Promise<GlobalStore> {
    const dbPath = resolveDualScopeDbPath('global');
    const normalized = resolve(dbPath);
    if (options?.dedicated) {
      const handle = await openDualScopeDbAtPath('global', normalized, options?.exodusCwd, {
        dedicated: true,
      });
      return this.buildStore('global', handle, 0) as GlobalStore;
    }
    return this.openEntry('global', normalized, 0, options?.exodusCwd) as Promise<GlobalStore>;
  }

  /** @inheritdoc */
  async openGlobalAt(dbPath: string, options?: CleoRuntimeOpenOptions): Promise<GlobalStore> {
    const normalized = resolve(dbPath);
    if (options?.dedicated) {
      const handle = await openDualScopeDbAtPath('global', normalized, options?.exodusCwd, {
        dedicated: true,
      });
      return this.buildStore('global', handle, 0) as GlobalStore;
    }
    return this.openEntry('global', normalized, 0, options?.exodusCwd) as Promise<GlobalStore>;
  }

  /** @inheritdoc */
  closeProject(dbPath: string): void {
    const normalized = resolve(dbPath);
    this.closeEntry('project', normalized);
  }

  /** @inheritdoc */
  closeAll(): void {
    // Snapshot keys: closeEntry mutates the map during iteration.
    for (const key of [...this._registry.keys()]) {
      try {
        this.closeEntryByKey(key);
      } catch {
        // Continue closing remaining entries.
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Open (or reuse) a scoped entry. All five key invariants are enforced
   * on this single code path.
   *
   * @param depth - Reacquisition depth guard. Starts at 0; capped at 1.
   *   When the post-await liveness check finds a dead handle, the bounded
   *   retry calls this with `depth + 1`. A second dead handle at depth 1
   *   throws {@link LivenessExhaustedError} instead of recursing further.
   */
  private async openEntry(
    scope: DualScope,
    dbPath: string,
    depth = 0,
    /**
     * Forwarded to the chokepoint as `exodusCwd` so a runtime open arms the
     * exodus-on-open legacy-fleet auto-migration exactly like
     * {@link openDualScopeDb} does. NOT part of the registry key — the key is
     * the canonical path this cwd already resolved to (T12037).
     */
    exodusCwd?: string,
  ): Promise<ProjectStore | GlobalStore> {
    const key = cacheKey(scope, dbPath);

    // ── Cache-hit liveness (invariant 4) ─────────────────────────────────
    const existing = this._registry.get(key);
    if (existing) {
      if (existing.initPromise) {
        return existing.initPromise;
      }
      if (existing.store?.isOpen) {
        return existing.store;
      }
      // Handle was closed externally — evict and re-open.
      this._registry.delete(key);
    }

    // ── Placeholder with identity (invariant 2) ──────────────────────────
    const entryId = ++this._nextId;
    let initResolve!: (store: ProjectStore | GlobalStore) => void;
    let initReject!: (err: unknown) => void;
    const initPromise = new Promise<ProjectStore | GlobalStore>((resolve, reject) => {
      initResolve = resolve;
      initReject = reject;
    });

    this._registry.set(key, { id: entryId, store: null, initPromise });

    // Evict on failure so a transient error doesn't poison.
    initPromise.catch(() => {
      const placeholder = this._registry.get(key);
      if (placeholder?.initPromise === initPromise) {
        this._registry.delete(key);
      }
    });

    try {
      // Dispatch on scope literal so the overloaded opener resolves to the
      // correct typed return. The union `DualScope` cannot satisfy either
      // literal overload directly.
      const dualHandle =
        scope === 'project'
          ? await this.openDualScopeFn('project', dbPath, exodusCwd)
          : await this.openDualScopeFn('global', dbPath, exodusCwd);

      // ── Publish only if THIS init is still current (invariant 2) ───────
      const current = this._registry.get(key);
      if (!current || current.id !== entryId) {
        // Cancelled during init. Do NOT close dualHandle — a replacement
        // entry for the same scope/key may be awaiting the same in-flight
        // chokepoint promise. The handle stays in the shared cache; the
        // replacement inherits it live.
        throw new EntryCancelledError(scope, dbPath);
      }

      // ── Post-await liveness (invariant 4b) ─────────────────────────
      // The chokepoint resolved with a live handle, but an external close
      // (e.g. _resetDualScopeDbCache or a test-injected dead-handle opener)
      // between the await and this publish can kill it. If the handle is
      // dead, close it (evict from cache), delete the placeholder, and
      // perform ONE bounded reacquisition.
      if (!dualHandle.isOpen) {
        dualHandle.close();
        this._registry.delete(key);

        if (depth >= 1) {
          throw new LivenessExhaustedError(scope, dbPath);
        }

        const retryStore = await this.openEntry(scope, dbPath, depth + 1, exodusCwd);
        initResolve(retryStore);
        return retryStore;
      }

      const store = this.buildStore(scope, dualHandle, entryId);
      current.store = store;
      current.initPromise = null;
      initResolve(store);
      return store;
    } catch (err) {
      initReject(err);
      throw err;
    }
  }

  /**
   * Build a typed {@link ProjectStore} or {@link GlobalStore} from a
   * {@link DualScopeDbHandle}. The store's `close()` is stale-safe
   * (invariant 3): it only evicts the registry entry when the entry's
   * identity still matches.
   */
  private buildStore(
    scope: DualScope,
    dualHandle: DualScopeDbHandle,
    entryId: EntryId,
  ): ProjectStore | GlobalStore {
    const dbPath = dualHandle.dbPath;
    const identity = dualHandle.identity;
    const exodusAbort = dualHandle.exodusAbort;
    const key = cacheKey(scope, dbPath);

    if (scope === 'project') {
      const store: ProjectStore = {
        scope: 'project',
        dbPath,
        identity,
        db: dualHandle.db as CleoProjectDb,
        get isOpen() {
          return dualHandle.isOpen;
        },
        exodusAbort,
        close: () => {
          dualHandle.close();
          this.cleanupEntry(key, entryId);
        },
      };
      return store;
    }

    const store: GlobalStore = {
      scope: 'global',
      dbPath,
      identity,
      db: dualHandle.db as CleoGlobalDb,
      get isOpen() {
        return dualHandle.isOpen;
      },
      exodusAbort,
      close: () => {
        dualHandle.close();
        this.cleanupEntry(key, entryId);
      },
    };
    return store;
  }

  /**
   * Conditionally evict a registry entry. Only deletes when the current
   * entry's identity still matches `entryId` — an old stale close is a no-op
   * (invariant 3).
   */
  private cleanupEntry(key: string, entryId: EntryId): void {
    const entry = this._registry.get(key);
    if (entry && entry.id === entryId) {
      this._registry.delete(key);
    }
  }

  /**
   * Close and evict a single scoped entry from the registry by composite
   * key. Cancels in-flight opens by deleting the placeholder entry — the
   * in-flight init detects the missing/id-mismatched entry and rejects
   * after its `await` resolves (invariant 2).
   */
  private closeEntry(scope: DualScope, dbPath: string): void {
    this.closeEntryByKey(cacheKey(scope, dbPath));
  }

  /**
   * Close and evict a single entry by composite registry key.
   */
  private closeEntryByKey(key: string): void {
    const entry = this._registry.get(key);
    if (!entry) return;
    // Delete FIRST so in-flight inits observe a missing entry
    // (invariant 2 — cancellation). Even if the store close below throws,
    // the entry is gone — the caller won't get it back and the dual-scope
    // chokepoint cache still owns the SQLite close.
    this._registry.delete(key);
    if (entry.store) {
      try {
        entry.store.close();
      } catch {
        // Close is best-effort; the entry is already evicted.
      }
    }
  }
}

/**
 * Override the dual-scope opener function used by the given
 * {@link CleoRuntime} instance. Tests inject a custom opener to return a
 * pre-closed handle, exercising the post-await liveness and bounded-
 * reacquisition code paths.
 *
 * The injected function receives the same `(scope, dbPath)` signature as
 * {@link openDualScopeDbAtPath} and must return a
 * {@link DualScopeDbHandle}. Only non-dedicated opens (
 * {@link CleoRuntime.openProject} and {@link CleoRuntime.openGlobal}
 * without `{ dedicated: true }`) are affected. Dedicated opens always
 * call {@link openDualScopeDbAtPath} directly — a custom opener can
 * never turn a dedicated store into a cached/shared store.
 *
 * Pass `undefined` to restore the default (`openDualScopeDbAtPath`).
 *
 * @param runtime - The runtime instance to configure.
 * @param fn - The opener to use, or `undefined` to reset.
 *
 * @internal Test seam; imported directly from this module, not the barrel.
 */
export function setRuntimeOpenFn(
  runtime: CleoRuntime,
  fn: typeof openDualScopeDbAtPath | undefined,
): void {
  (runtime as CleoRuntimeImpl).openDualScopeFn = fn ?? openDualScopeDbAtPath;
}

/**
 * Create a new {@link CleoRuntime} store registry.
 *
 * The returned runtime is the explicit composition root for project and
 * global database entries. Use {@link CleoRuntime.openProject} to open a
 * project's `cleo.db` at a canonical path, and {@link CleoRuntime.openGlobal}
 * for the global scope. Closing a project via {@link CleoRuntime.closeProject}
 * or the store's own `close()` disposes only that entry.
 *
 * ## Cross-runtime behavior
 *
 * Two separate runtime instances SHARE the **process-global dual-scope
 * handle cache** (`_cache`). Closing a store in one runtime closes the
 * shared `DatabaseSync` — another runtime referencing the same path
 * will observe a closed connection. The **cache-hit liveness** check in
 * this runtime reacquires a fresh handle on the next `openProject`/
 * `openGlobal`. This is by design: the runtime owns **entry lifecycle**,
 * not the underlying connection. Use a dedicated connection for isolation.
 *
 * @returns A fresh {@link CleoRuntime} instance with an empty registry.
 *
 * @example
 * ```ts
 * import { createCleoRuntime, resolveDualScopeDbPath } from '@cleocode/core/db';
 *
 * const runtime = createCleoRuntime();
 * const projectA = await runtime.openProject(resolveDualScopeDbPath('project', '/path/to/projA'));
 * const projectB = await runtime.openProject(resolveDualScopeDbPath('project', '/path/to/projB'));
 * // projectA and projectB are distinct, independent handles.
 * projectA.close(); // Only closes projectA; projectB and any global handle are intact.
 * ```
 *
 * @task T12036 (E6-L12)
 * @epic T11249 (E6)
 * @saga T11242
 */
export function createCleoRuntime(): CleoRuntime {
  return new CleoRuntimeImpl();
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
 * Derives the writer-lease identity from the DB handle itself via
 * {@link resolveDbIdentity} — the identity was registered at
 * {@link DualScopeDbHandle} construction, so a caller cannot pair file-A
 * identity with file-B DB (T12042).
 *
 * @example
 * ```ts
 * import { tasksTasksTable } from '@cleocode/core/store/schema/cleo-project';
 * const inserted = await insertIdempotent(db, tasksTasksTable, newTask, 'idempotencyKey');
 * ```
 *
 * @task T11513 (E4-T2)
 * @task T11828 (write-side exodus-abort guard)
 * @task T12042 (E6-L12b — exact DB-bound identity)
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
  const identity = resolveDbIdentity(db);
  return withWriterLease(
    identity.scope,
    'tasks',
    async () => {
      const result = await db.insert(table).values(row).onConflictDoNothing().returning();
      return result.length;
    },
    { dbPath: identity.dbPath },
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
 * Derives the writer-lease identity from the DB handle itself via
 * {@link resolveDbIdentity} (T12042 — exact DB-bound identity, no fallback).
 *
 * @example
 * ```ts
 * await upsertIdempotent(db, tasksTasksTable, updatedTask, 'idempotencyKey',
 *   tasksTasksTable.idempotencyKey);
 * ```
 *
 * @task T11513 (E4-T2)
 * @task T11828 (write-side exodus-abort guard)
 * @task T12042 (E6-L12b — exact DB-bound identity)
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
  const identity = resolveDbIdentity(db);
  return withWriterLease(
    identity.scope,
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
    { dbPath: identity.dbPath },
  );
}
