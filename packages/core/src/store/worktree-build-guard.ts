/**
 * Worktree-build schema-write guard (T12687).
 *
 * A CLI built inside a linked git worktree carries that branch's UNRELEASED
 * migrations and schema code. Path resolution maps a worktree to its parent
 * project's store (T12460), so running that build — `cleo check arch`, an
 * unsandboxed CLI test, a reviewer trying a PR build — changed the schema of
 * the LIVE main-checkout store. Incident 2026-09-29: cleo-nexus's slice-2
 * build wrote `__drizzle_migrations` row 114 into the live cleocode store; the
 * released CLI then deleted the unknown row as an orphan and the next slice-2
 * open re-ran `ADD COLUMN` and failed.
 *
 * ## One decision per store, enforced on the handle
 *
 * {@link schemaWriteRefusal} decides, once per store path, whether this build
 * may change that store's schema. When it may not,
 * {@link installSchemaWriteGuard} installs a SQLite authorizer on the handle
 * that DENIES every schema change — `ALTER`, `DROP`, and any `CREATE` of an
 * object that does not already exist (a `CREATE … IF NOT EXISTS` of an
 * existing object is a no-op and stays allowed). That covers every DDL site
 * at once — drizzle migrations, `ensureColumns`, raw `ALTER`s, table
 * rebuilds, twin collapse, exodus — including sites added later. Migration
 * sites additionally fail fast with {@link WorktreeBuildSchemaError} when the
 * build has pending migrations: the store would not match what this build
 * reads, so it refuses rather than failing later with `no such column`.
 *
 * ## Who is a dev build
 *
 * The build stamp `dist/build-provenance.json` (written at build time) names
 * the linked worktree the build was made in, or null for a main checkout / CI
 * clone — how released packages are built. The stamp travels with the build,
 * so an `npm pack`ed worktree build installed globally, or a `dist` copied
 * outside any checkout, is still recognised. Without a stamp (running from
 * source), the running file's own location decides, and a path under
 * `node_modules` counts as installed.
 *
 * Allowed without an opt-in: stores inside the build's own worktree, and the
 * test harness (`VITEST`, or a store below a {@link TEST_SANDBOX_MARKER} for CLI
 * children a test spawns). A temp directory alone is NOT an exemption — a
 * project cloned under `/tmp` is a real store. Everything else needs
 * `CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS=1`.
 *
 * @task T12687
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ExitCode } from '@cleocode/contracts';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { CleoError } from '../errors.js';
import { isGitLinkedCheckout } from '../project-scope.js';

/** Opt-in that lets a worktree build change the schema of a store outside its worktree. */
export const ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV = 'CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS';

/**
 * File the test harness (`vitest.setup.ts`) writes at the root of each fork's
 * sandbox. A store below it is a fixture — including one opened by a CLI child
 * process the test spawned: such a child carries `VITEST` only when the test
 * passes its own environment through, and many build an explicit `env`.
 * A marker inside a git checkout is ignored: the sandbox is never in one, so a
 * marker there was committed or planted in a real project.
 */
export const TEST_SANDBOX_MARKER = '.cleo-test-sandbox';

/** Error code of {@link WorktreeBuildSchemaError}. */
export const E_WORKTREE_BUILD_SCHEMA = 'E_WORKTREE_BUILD_SCHEMA';

/** Build stamp written by `scripts/write-build-provenance.mjs`. */
export interface BuildProvenance {
  /**
   * Linked worktree the build was made in, or null (main checkout / CI clone).
   * Absent when git could not tell at build time — the guard then decides from
   * the build's path instead of trusting the stamp.
   */
  linkedWorktree: string | null;
}

/** Inputs of {@link schemaWriteRefusal}; defaults describe this process. */
export interface WorktreeBuildGuardOptions {
  /** A file of the running build. Defaults to this module. */
  codePath: string;
  /** The build stamp; `undefined` reads it from beside the build, `null` means none. */
  provenance: BuildProvenance | null | undefined;
  /** Environment consulted for the opt-in and the test harness. */
  env: NodeJS.ProcessEnv;
  /** Honour {@link TEST_SANDBOX_MARKER} (default true; guard tests turn it off). */
  honourTestSandbox: boolean;
}

let overrides: Partial<WorktreeBuildGuardOptions> | null = null;
const decisions = new Map<string, string | null>();

/**
 * Replace the guard's view of the running build (tests only: a test process
 * runs from source inside the harness, so it cannot be a dev build itself).
 *
 * @param next - Partial options, or null to restore the defaults.
 * @internal
 */
export function setWorktreeBuildGuardForTests(
  next: Partial<WorktreeBuildGuardOptions> | null,
): void {
  overrides = next;
  decisions.clear();
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isWithin(root: string, path: string): boolean {
  const local = relative(root, path);
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
}

/** Whether `dir` or an ancestor is a git checkout (has `.git`). */
function insideGitCheckout(dir: string): boolean {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Whether a {@link TEST_SANDBOX_MARKER} sits in `path` or an ancestor, outside
 * any git checkout (a marker inside a checkout is refused).
 */
function insideTestSandbox(path: string): boolean {
  let dir = dirname(path);
  for (;;) {
    if (existsSync(join(dir, TEST_SANDBOX_MARKER))) return !insideGitCheckout(dir);
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Root of the linked git worktree containing `path`, or null when the nearest
 * enclosing checkout is a main checkout (or there is none).
 *
 * @param path - Any path.
 * @returns The linked worktree root, or null.
 */
export function linkedWorktreeRootOf(path: string): string | null {
  let dir = realOrResolved(path);
  for (;;) {
    if (isGitLinkedCheckout(dir)) return dir;
    if (existsSync(join(dir, '.git'))) return null; // a main checkout
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The build stamp beside the running build: the nearest `build-provenance.json`
 * walking up from `codePath`, stopping at the package root.
 *
 * @param codePath - A file of the running build.
 * @returns The stamp, or null when there is none (running from source).
 */
export function readBuildProvenance(codePath: string): BuildProvenance | null {
  let dir = dirname(codePath);
  for (;;) {
    const stamp = join(dir, 'build-provenance.json');
    if (existsSync(stamp)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(stamp, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && 'linkedWorktree' in parsed) {
          const value = (parsed as { linkedWorktree: unknown }).linkedWorktree;
          // Only an explicit null or a path is trusted; anything else falls back.
          if (value === null || typeof value === 'string') return { linkedWorktree: value };
        }
      } catch {
        // An unreadable stamp decides nothing; fall back to the path.
      }
      return null;
    }
    if (existsSync(join(dir, 'package.json'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The linked worktree this build came from, or null for a released build.
 *
 * @param options - Injection points; defaults describe this process.
 * @returns The worktree root, or null.
 */
export function devBuildWorktree(options: Partial<WorktreeBuildGuardOptions> = {}): string | null {
  const codePath = options.codePath ?? overrides?.codePath ?? fileURLToPath(import.meta.url);
  const provenance =
    options.provenance !== undefined
      ? options.provenance
      : overrides?.provenance !== undefined
        ? overrides.provenance
        : readBuildProvenance(codePath);
  if (provenance) return provenance.linkedWorktree;
  if (codePath.split(/[\\/]/).includes('node_modules')) return null;
  return linkedWorktreeRootOf(codePath);
}

/**
 * Why this build must not change the schema of `dbPath`, or null when it may.
 *
 * @param dbPath - Store path.
 * @param options - Injection points; defaults describe this process.
 * @returns The refusal naming the build's worktree, the store and the opt-in.
 * @task T12687
 */
export function schemaWriteRefusal(
  dbPath: string,
  options: Partial<WorktreeBuildGuardOptions> = {},
): string | null {
  const env = options.env ?? overrides?.env ?? process.env;
  const buildWorktree = devBuildWorktree(options);
  if (buildWorktree === null) return null;
  const store = realOrResolved(dbPath);
  if (isWithin(realOrResolved(buildWorktree), store)) return null;
  if (env['VITEST']) return null; // the test harness owns its fixture stores
  const honourTestSandbox = options.honourTestSandbox ?? overrides?.honourTestSandbox ?? true;
  if (honourTestSandbox && insideTestSandbox(store)) return null;
  if (env[ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV] === '1') return null;
  return (
    `Refusing to change the schema of ${store}: this CLI was built inside the git worktree ` +
    `${buildWorktree}, and its schema may be unreleased. Run the released \`cleo\` against this ` +
    `store, or opt in with ${ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV}=1 (T12687).`
  );
}

/** Backwards-compatible alias of {@link schemaWriteRefusal}. */
export const worktreeBuildMigrationRefusal = schemaWriteRefusal;

/**
 * The per-store decision, memoised for the process (one decision per store).
 *
 * @param dbPath - Store path.
 * @returns The refusal, or null when schema writes are allowed.
 */
function decisionFor(dbPath: string): string | null {
  const key = realOrResolved(dbPath);
  if (!decisions.has(key)) decisions.set(key, schemaWriteRefusal(key));
  return decisions.get(key) ?? null;
}

/**
 * Whether this build may change the schema of the store behind `nativeDb`.
 *
 * @param nativeDb - Store handle (`location()` is its path; in-memory is always allowed).
 * @returns `true` when schema writes are allowed.
 */
export function schemaWritesAllowed(nativeDb: DatabaseSync): boolean {
  const dbPath = nativeDb.location();
  return !dbPath || decisionFor(dbPath) === null;
}

/** Refusal raised when a dev build would change a foreign store's schema (T12687). */
export class WorktreeBuildSchemaError extends CleoError {
  constructor(message: string) {
    super(ExitCode.CONFIG_ERROR, `${E_WORKTREE_BUILD_SCHEMA}: ${message}`, {
      fix:
        'Use the released `cleo` for this store, run the build against a store inside its own ' +
        `worktree, or set ${ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV}=1 to accept the schema change.`,
    });
  }
}

/** Whether `error` is (or wraps) a {@link WorktreeBuildSchemaError}. */
export function isWorktreeBuildSchemaError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(E_WORKTREE_BUILD_SCHEMA);
}

type SqliteConstants = typeof import('node:sqlite').constants;

/**
 * SQLite action codes, loaded on first use: `node:sqlite` must not load at
 * module-init time (sqlite.ts imports this module; T1331 lazy-init contract).
 */
let authorizerCodes:
  | {
      sqlite: SqliteConstants;
      creates: Map<number, 'table' | 'index' | 'trigger' | 'view'>;
      changes: Set<number>;
    }
  | undefined;

function codes(): NonNullable<typeof authorizerCodes> {
  if (authorizerCodes) return authorizerCodes;
  const sqlite = (createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite'))
    .constants;
  authorizerCodes = {
    sqlite,
    creates: new Map([
      [sqlite.SQLITE_CREATE_TABLE, 'table'],
      [sqlite.SQLITE_CREATE_VTABLE, 'table'],
      [sqlite.SQLITE_CREATE_INDEX, 'index'],
      [sqlite.SQLITE_CREATE_TRIGGER, 'trigger'],
      [sqlite.SQLITE_CREATE_VIEW, 'view'],
    ]),
    changes: new Set([
      sqlite.SQLITE_ALTER_TABLE,
      sqlite.SQLITE_DROP_TABLE,
      sqlite.SQLITE_DROP_INDEX,
      sqlite.SQLITE_DROP_TRIGGER,
      sqlite.SQLITE_DROP_VIEW,
      sqlite.SQLITE_DROP_VTABLE,
    ]),
  };
  return authorizerCodes;
}

/** Per-schema policy on a guarded handle: its refusal (null = allowed) and existing objects. */
interface SchemaPolicy {
  refusal: string | null;
  objects: Set<string>;
}

/** Guard state per handle. */
interface HandleGuard {
  /** Policy per schema name, from `PRAGMA database_list` at install/refresh. */
  schemas: Map<string, SchemaPolicy>;
  /**
   * Refusal for a store ATTACHed since the last refresh, whose alias is not
   * yet mapped: DDL on any unmapped schema is denied while it is set.
   */
  unmappedAttachRefusal: string | null;
  /** The most recent denial, for the error explanation. */
  lastDenied: { what: string; refusal: string } | null;
}

const guards = new WeakMap<DatabaseSync, HandleGuard>();

function readSchemas(nativeDb: DatabaseSync): Map<string, SchemaPolicy> {
  const schemas = new Map<string, SchemaPolicy>();
  const list = nativeDb.prepare('PRAGMA database_list').all() as Array<{
    name: string;
    file: string;
  }>;
  for (const { name, file } of list) {
    if (name === 'temp') continue;
    const rows = nativeDb
      .prepare(`SELECT type, name FROM "${name.replaceAll('"', '""')}".sqlite_master`)
      .all() as Array<{ type: string; name: string }>;
    schemas.set(name, {
      refusal: file ? decisionFor(file) : null, // '' = in-memory
      objects: new Set(rows.map((r) => `${r.type}:${r.name}`)),
    });
  }
  return schemas;
}

let processBuildWorktree: string | null | undefined;

/** Whether this process is a dev build outside the test harness (the guard's precondition). */
function guardActive(): boolean {
  const env = overrides?.env ?? process.env;
  if (env['VITEST']) return false;
  if (overrides) return devBuildWorktree() !== null;
  if (processBuildWorktree === undefined) processBuildWorktree = devBuildWorktree();
  return processBuildWorktree !== null;
}

/**
 * Install the schema-write guard on a freshly opened writable handle. Call it
 * right after opening, before any schema code runs.
 *
 * Only a dev build (outside the test harness) installs anything; released
 * builds pay nothing. The authorizer then applies, PER SCHEMA, the decision
 * for that schema's file: on a refused schema it denies `ALTER`, `DROP` and
 * any `CREATE` of an object that does not already exist. That covers the main
 * schema and any store ATTACHed later — an exempt handle (in-memory or inside
 * the build's own worktree) that attaches a foreign store is guarded on the
 * attached schema too.
 *
 * @param nativeDb - Freshly opened writable handle.
 * @returns `true` when the main schema itself is refused.
 * @task T12687
 */
export function installSchemaWriteGuard(nativeDb: DatabaseSync): boolean {
  if (!guardActive()) return false;
  const location = nativeDb.location();
  const mainRefusal = location ? decisionFor(location) : null; // in-memory is always allowed
  if (typeof nativeDb.setAuthorizer !== 'function') {
    // No authorizer in this Node: refuse a refused store outright rather than
    // leave schema code unguarded.
    if (mainRefusal) throw new WorktreeBuildSchemaError(mainRefusal);
    return false;
  }
  const state: HandleGuard = {
    schemas: readSchemas(nativeDb),
    unmappedAttachRefusal: null,
    lastDenied: null,
  };
  guards.set(nativeDb, state);
  const { sqlite, creates, changes } = codes();
  nativeDb.setAuthorizer((action, arg1, arg2, dbName) => {
    if (action === sqlite.SQLITE_ATTACH) {
      const refusal = arg1 ? decisionFor(arg1) : null;
      if (refusal && !state.unmappedAttachRefusal) state.unmappedAttachRefusal = refusal;
      return sqlite.SQLITE_OK;
    }
    const createType = creates.get(action);
    if (createType === undefined && !changes.has(action)) return sqlite.SQLITE_OK;
    // SQLITE_ALTER_TABLE passes (schema, table) in arg1/arg2 and no dbName;
    // every other action passes the schema as dbName.
    const schema = (action === sqlite.SQLITE_ALTER_TABLE ? arg1 : dbName) ?? 'main';
    if (schema === 'temp') return sqlite.SQLITE_OK;
    const policy = state.schemas.get(schema);
    const refusal = policy ? policy.refusal : state.unmappedAttachRefusal;
    if (refusal === null) return sqlite.SQLITE_OK;
    // CREATE … IF NOT EXISTS of an existing object is a no-op.
    if (createType !== undefined && policy?.objects.has(`${createType}:${arg1}`)) {
      return sqlite.SQLITE_OK;
    }
    state.lastDenied = {
      what:
        createType !== undefined
          ? `CREATE ${createType} ${schema}.${arg1}`
          : `schema change on ${schema}.${(action === sqlite.SQLITE_ALTER_TABLE ? arg2 : arg1) ?? ''}`,
      refusal,
    };
    return sqlite.SQLITE_DENY;
  });
  return mainRefusal !== null;
}

/**
 * Re-read the schema map after an `ATTACH`, so the attached schema gets its own
 * decision and no-op `CREATE … IF NOT EXISTS` statements on it stay allowed.
 *
 * @param nativeDb - A handle passed to {@link installSchemaWriteGuard}.
 */
export function refreshSchemaWriteGuard(nativeDb: DatabaseSync): void {
  const state = guards.get(nativeDb);
  if (!state) return;
  state.schemas = readSchemas(nativeDb);
  state.unmappedAttachRefusal = null;
}

/**
 * Turn SQLite's bare `not authorized` from a guarded handle into the refusal
 * that says why and what to do. Other errors are returned unchanged.
 *
 * @param nativeDb - The handle the error came from.
 * @param error - The caught error.
 * @returns The error to rethrow.
 */
export function explainSchemaWriteDenial(nativeDb: DatabaseSync, error: unknown): unknown {
  if (!(error instanceof Error) || !/not authorized/i.test(error.message)) return error;
  const denied = guards.get(nativeDb)?.lastDenied;
  if (!denied) return error;
  return new WorktreeBuildSchemaError(`${denied.refusal} Denied: ${denied.what}.`);
}

/**
 * Migrations of one lineage that `nativeDb`'s journal does not yet record.
 *
 * @param nativeDb - Store handle.
 * @param migrations - The lineage's local migrations.
 * @returns Names (or hashes) of the pending migrations; all of them when the
 *   journal table does not exist yet.
 */
export function pendingMigrations(
  nativeDb: DatabaseSync,
  migrations: readonly MigrationMeta[],
): string[] {
  const hasJournal = nativeDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .get();
  const applied = hasJournal
    ? new Set(
        (
          nativeDb.prepare('SELECT hash FROM main."__drizzle_migrations"').all() as Array<{
            hash: string;
          }>
        ).map((row) => row.hash),
      )
    : new Set<string>();
  return migrations.filter((m) => !applied.has(m.hash)).map((m) => m.name ?? m.hash);
}

/**
 * The guard at a migration site: when this build may not change the store's
 * schema and the lineage has pending migrations, FAIL FAST — the store does
 * not match what this build reads, so continuing would only fail later with
 * `no such column`.
 *
 * @param nativeDb - Store handle.
 * @param migrations - The lineage's local migrations.
 * @throws {WorktreeBuildSchemaError} naming the build worktree, the store,
 *   the pending migrations and the opt-in.
 * @task T12687
 */
export function assertNoPendingMigrationsForWorktreeBuild(
  nativeDb: DatabaseSync,
  migrations: readonly MigrationMeta[],
): void {
  const dbPath = nativeDb.location();
  if (!dbPath) return;
  const refusal = decisionFor(dbPath);
  if (refusal === null) return;
  const pending = pendingMigrations(nativeDb, migrations);
  if (pending.length === 0) return;
  throw new WorktreeBuildSchemaError(`${refusal} Pending migrations: ${pending.join(', ')}.`);
}
