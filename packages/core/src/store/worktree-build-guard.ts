/**
 * Worktree-build migration guard (T12687).
 *
 * A CLI built inside a linked git worktree carries that branch's UNRELEASED
 * migrations. Path resolution maps a worktree to its parent project's store
 * (T12460), so running that build — `cleo check arch`, an unsandboxed CLI
 * test, a reviewer trying a PR build — migrated the LIVE main-checkout store.
 * Incident 2026-09-29: cleo-nexus's slice-2 build wrote `__drizzle_migrations`
 * row 114 into the live cleocode store; the released CLI then deleted the
 * unknown row as an orphan and the next slice-2 open re-ran `ADD COLUMN` and
 * failed.
 *
 * The guard: when the running code lives inside a linked worktree and the
 * store it would migrate lies outside that worktree, pending migrations are
 * NOT applied (and the journal is not reconciled) unless
 * `CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS=1`. The store still opens, so
 * read-only commands keep working against the owning store.
 *
 * Unaffected:
 * - installed builds (the code path contains a `node_modules` segment);
 * - builds in a main checkout or any non-worktree directory;
 * - stores inside the build's own worktree, and stores under a temp dir or a
 *   declared test sandbox root (`CLEO_TEST_ALLOWED_DB_ROOTS`);
 * - stores with no pending migration (nothing would be written).
 *
 * @task T12687
 */

import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { isGitLinkedCheckout } from '../project-scope.js';

/** Opt-in that lets a worktree build migrate a store outside its worktree. */
export const ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV = 'CLEO_ALLOW_WORKTREE_BUILD_MIGRATIONS';

/** Inputs of {@link worktreeBuildMigrationRefusal}; defaults describe this process. */
export interface WorktreeBuildGuardOptions {
  /** A file of the running build. Defaults to this module. */
  codePath: string;
  /** Environment consulted for the opt-in. Defaults to `process.env`. */
  env: NodeJS.ProcessEnv;
  /** Directories whose stores are always allowed (scratch). Defaults to the temp dirs. */
  tmpRoots: readonly string[];
}

/**
 * Where scratch stores live: the temp dir of this process, the platform temp
 * bases (a child process may see a different TMPDIR than the fixture that
 * created its store), and the test sandbox roots vitest.setup.ts declares.
 * No live project store lives under these.
 */
function scratchRoots(): string[] {
  const bases = [tmpdir(), '/tmp', '/var/tmp'];
  if (process.platform === 'darwin') bases.push('/private/var/folders');
  return [
    ...bases,
    ...(process.env['CLEO_TEST_ALLOWED_DB_ROOTS'] ?? '').split(delimiter).filter(Boolean),
  ];
}

let overrides: Partial<WorktreeBuildGuardOptions> | null = null;

/**
 * Replace the guard's view of the running build (tests only: a test process
 * runs from source, so it cannot move its own code into a fixture worktree).
 *
 * @param next - Partial options, or null to restore the defaults.
 * @internal
 */
export function setWorktreeBuildGuardForTests(
  next: Partial<WorktreeBuildGuardOptions> | null,
): void {
  overrides = next;
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
    try {
      // A `.git` directory: a main checkout — not a worktree build.
      if (realpathSync(`${dir}${sep}.git`)) return null;
    } catch {
      // No `.git` here — keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Why migrations must not be applied to `dbPath` from this build, or null
 * when they may.
 *
 * @param dbPath - Store about to be migrated.
 * @param options - Injection points; defaults describe this process.
 * @returns The refusal naming the build's worktree and the store, or null.
 * @task T12687
 */
export function worktreeBuildMigrationRefusal(
  dbPath: string,
  options: Partial<WorktreeBuildGuardOptions> = {},
): string | null {
  const opts: WorktreeBuildGuardOptions = {
    codePath: fileURLToPath(import.meta.url),
    env: process.env,
    tmpRoots: scratchRoots(),
    ...overrides,
    ...options,
  };
  if (opts.codePath.split(/[\\/]/).includes('node_modules')) return null;
  const buildWorktree = linkedWorktreeRootOf(opts.codePath);
  if (buildWorktree === null) return null;
  const store = realOrResolved(dbPath);
  if (isWithin(buildWorktree, store)) return null;
  if (opts.tmpRoots.some((root) => isWithin(realOrResolved(root), store))) return null;
  if (opts.env[ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV] === '1') return null;
  return (
    `Refusing to migrate ${store}: this CLI was built inside the git worktree ${buildWorktree}, ` +
    'and its migrations may be unreleased. The store opened without them, so read-only commands ' +
    'still work. Run the released `cleo` against this store, or opt in with ' +
    `${ALLOW_WORKTREE_BUILD_MIGRATIONS_ENV}=1 (T12687).`
  );
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
          nativeDb.prepare('SELECT hash FROM "__drizzle_migrations"').all() as Array<{
            hash: string;
          }>
        ).map((row) => row.hash),
      )
    : new Set<string>();
  return migrations.filter((m) => !applied.has(m.hash)).map((m) => m.name ?? m.hash);
}

const warned = new Set<string>();

/**
 * The guard at a migration site: when this build must not migrate the store
 * and something is pending, report once per store and return `true` (skip).
 *
 * @param nativeDb - Store handle (its `location()` is the store path).
 * @param migrations - The lineage's local migrations.
 * @returns `true` when the caller must skip reconciliation and migration.
 * @task T12687
 */
export function skipMigrationsForWorktreeBuild(
  nativeDb: DatabaseSync,
  migrations: readonly MigrationMeta[],
): boolean {
  const dbPath = nativeDb.location();
  if (!dbPath) return false; // in-memory
  const refusal = worktreeBuildMigrationRefusal(dbPath);
  if (refusal === null) return false;
  const pending = pendingMigrations(nativeDb, migrations);
  if (pending.length === 0) return false;
  const key = `${dbPath}\0${pending.join(',')}`;
  if (!warned.has(key)) {
    warned.add(key);
    process.stderr.write(`[cleo] ${refusal} Pending: ${pending.join(', ')}\n`);
  }
  return true;
}
