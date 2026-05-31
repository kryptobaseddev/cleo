/**
 * Per-user skills.db lifecycle module — opener, migrations, helpers.
 *
 * `skills.db` is a global-tier SQLite database that lives next to `tasks.db`
 * and `brain.db` under `getCleoHome()` (e.g. `~/.local/share/cleo/skills.db`).
 * It stores the per-user skills registry described in
 * `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §4.
 *
 * ## Chokepoint compliance (ADR-068 + D003)
 *
 * Every CLEO SQLite open MUST flow through `openCleoDb(role, cwd)`. This
 * module implements the `'skills'` branch of that chokepoint — it is the
 * ONLY place a raw `new DatabaseSync(...)` is permitted for skills.db,
 * because it sits under `packages/core/src/store/` which is allowlisted by
 * `scripts/lint-no-raw-db-opens.mjs`.
 *
 * ## Why not in conduit.db / signaldock.db?
 *
 * Per architecture v3 §1, the database boundaries are intentional:
 *   - `signaldock.db` — cross-project AGENT identity (global)
 *   - `tasks.db`     — per-project task tracking
 *   - `brain.db`     — per-project memory
 *   - `skills.db`    — per-user SKILL registry (this module, global)
 *
 * Skills are user-scoped (a single Claude install is one user), so they
 * live under `getCleoHome()` — never inside a project's `.cleo/` folder.
 *
 * @task T9651
 * @epic T9571
 * @saga T9560
 * @adr ADR-068, ADR-069
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §4
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { and, eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoHome } from '../paths.js';
import { getCurrentWriteOrigin } from '../sentient/skill-provenance.js';
import { migrateWithRetry, reconcileJournal, tableExists } from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import * as skillsSchema from './schema/skills-schema.js';
import {
  type NewSkillRow,
  type SkillRow,
  type SkillSourceType,
  skills as skillsTable,
} from './schema/skills-schema.js';
import { isSqliteBusy, openNativeDatabase } from './sqlite.js';

/** Database file name within `getCleoHome()`. */
export const SKILLS_DB_FILENAME = 'skills.db';

/** Schema version stamped into `_skills_meta`. Bump on every schema change. */
export const SKILLS_SCHEMA_VERSION = '2026.5.81';

// ---------------------------------------------------------------------------
// Singleton state — one open handle per process, reset across tests.
// ---------------------------------------------------------------------------

let _skillsDb: NodeSQLiteDatabase<typeof skillsSchema> | null = null;
let _skillsNativeDb: DatabaseSync | null = null;
let _skillsDbPath: string | null = null;
let _skillsInitPromise: Promise<NodeSQLiteDatabase<typeof skillsSchema>> | null = null;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical filesystem path for `skills.db`.
 *
 * Always returns a path under `getCleoHome()`. Throws if the resolved path
 * somehow escapes that prefix — that would indicate a regression in
 * `getCleoHome()` itself and MUST be fixed at the source, not silently
 * tolerated.
 *
 * @returns Absolute path to `skills.db`.
 * @throws {Error} If the resolved path is not under `getCleoHome()`.
 */
export function getDefaultSkillsDbPath(): string {
  const cleoHome = getCleoHome();
  const dbPath = join(cleoHome, SKILLS_DB_FILENAME);
  if (!dbPath.startsWith(cleoHome)) {
    throw new Error(
      `BUG: getDefaultSkillsDbPath() resolved to "${dbPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). skills.db is global-only per ` +
        `SG-CLEO-SKILLS-architecture-v3.md §4. Fix the caller, do not suppress.`,
    );
  }
  return dbPath;
}

/**
 * Resolve the absolute path to the `drizzle-skills` migrations folder.
 *
 * Delegates to {@link resolveCorePackageMigrationsFolder} which handles the
 * three install layouts (workspace dev, bundled dist, global install) via
 * `import.meta.resolve()` with a `createRequire().resolve()` fallback.
 */
export function resolveSkillsMigrationsFolder(): string {
  return resolveCorePackageMigrationsFolder('drizzle-skills');
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Apply the drizzle journal + pending migrations to the open `skills.db`.
 *
 * Uses the same retry-on-BUSY loop as `nexus-sqlite.ts` so concurrent CLI
 * invocations don't trip over each other during first-install bootstrap.
 *
 * @task T9651
 */
function runSkillsMigrations(
  nativeDb: DatabaseSync,
  db: NodeSQLiteDatabase<typeof skillsSchema>,
): void {
  const migrationsFolder = resolveSkillsMigrationsFolder();

  // Bootstrap: if the table exists from a prior bare-SQL apply but the
  // drizzle journal hasn't been seeded, mark the initial migration as
  // already applied. This mirrors the nexus-sqlite Scenario-1 bootstrap.
  if (tableExists(nativeDb, 'skills') && !tableExists(nativeDb, '__drizzle_migrations')) {
    const migrations = readMigrationFiles({ migrationsFolder });
    const baseline = migrations[0];
    if (baseline) {
      nativeDb
        .prepare(
          `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)`,
        )
        .run();
      nativeDb
        .prepare(
          `INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES ('${baseline.hash}', ${baseline.folderMillis})`,
        )
        .run();
    }
  }

  // Reconcile any partial / out-of-band migrations before the regular run.
  reconcileJournal(nativeDb, migrationsFolder, 'skills', 'skills');

  const MAX_RETRIES = 5;
  const BASE_DELAY_MS = 100;
  const MAX_DELAY_MS = 2000;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      migrateWithRetry(db, migrationsFolder, nativeDb, 'skills', 'skills');
      return;
    } catch (err) {
      if (!isSqliteBusy(err) || attempt === MAX_RETRIES) throw err;
      lastError = err;
      const delay = Math.min(
        BASE_DELAY_MS * 2 ** (attempt - 1) * (1 + Math.random() * 0.5),
        MAX_DELAY_MS,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(delay));
    }
  }
  /* c8 ignore next */
  throw lastError;
}

/**
 * Stamp the `_skills_meta.schema_version` sentinel so the next process can
 * take a fast-path through `ensureSkillsDb`.
 */
function writeSkillsSchemaVersionSentinel(nativeDb: DatabaseSync): void {
  try {
    nativeDb.exec(
      `CREATE TABLE IF NOT EXISTS _skills_meta (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
       );
       INSERT OR REPLACE INTO _skills_meta (key, value, updated_at)
       VALUES ('schema_version', '${SKILLS_SCHEMA_VERSION}', strftime('%s', 'now'));`,
    );
  } catch {
    // Non-fatal — the next open will simply take the fall-through path.
  }
}

// ---------------------------------------------------------------------------
// Public opener
// ---------------------------------------------------------------------------

/**
 * Options for {@link openSkillsDb}.
 */
export interface OpenSkillsDbOptions {
  /**
   * Override the on-disk path. Used by tests; production callers should
   * leave this `undefined` to let the module resolve `getDefaultSkillsDbPath()`.
   */
  path?: string;
}

/**
 * Open (or first-time materialise) `skills.db` and return the Drizzle handle.
 *
 * Idempotent: repeated calls with the same effective path return the cached
 * singleton. Concurrent callers share a single in-flight init promise so
 * migrations never race.
 *
 * @example
 * ```typescript
 * import { openSkillsDb } from '@cleocode/core/store/skills-db';
 *
 * const db = await openSkillsDb();
 * const all = await db.select().from(skills).all();
 * ```
 *
 * @param options - Override the default path (test-only).
 * @returns A Drizzle ORM handle bound to the four skills.db tables.
 *
 * @task T9651
 */
export async function openSkillsDb(
  options?: OpenSkillsDbOptions,
): Promise<NodeSQLiteDatabase<typeof skillsSchema>> {
  // Fast-path: if no explicit override was requested AND a singleton already
  // exists, return it without re-resolving `getDefaultSkillsDbPath()`. This
  // is important for tests that open the DB at a tmpdir via `{path:...}` and
  // then exercise helpers that call `openSkillsDb()` with no args; without
  // this guard the helper call would swap the singleton over to the real
  // user-home path and leak writes outside the test sandbox.
  if (_skillsDb && !options?.path) return _skillsDb;

  const requestedPath = options?.path ?? getDefaultSkillsDbPath();

  // If singleton points at a different file, reset cleanly.
  if (_skillsDb && _skillsDbPath !== requestedPath) {
    resetSkillsDbState();
  }

  if (_skillsDb) return _skillsDb;

  if (_skillsInitPromise) return _skillsInitPromise;

  _skillsInitPromise = (async () => {
    _skillsDbPath = requestedPath;

    // Ensure the parent directory exists before SQLite tries to create the file.
    if (!existsSync(dirname(requestedPath))) {
      mkdirSync(dirname(requestedPath), { recursive: true });
    }

    const nativeDb = openNativeDatabase(requestedPath);
    _skillsNativeDb = nativeDb;

    const db = drizzle({ client: nativeDb, schema: skillsSchema });

    runSkillsMigrations(nativeDb, db);
    writeSkillsSchemaVersionSentinel(nativeDb);

    _skillsDb = db;
    return db;
  })();

  try {
    return await _skillsInitPromise;
  } finally {
    _skillsInitPromise = null;
  }
}

/**
 * Close the singleton handle and release the underlying native DB.
 *
 * Safe to call multiple times. Used by `cleo backup restore skills.db` and
 * tests that mkdtemp a fresh location between cases.
 */
export function closeSkillsDb(): void {
  if (_skillsNativeDb) {
    try {
      if (_skillsNativeDb.isOpen) {
        _skillsNativeDb.close();
      }
    } catch {
      // Ignore — the singleton is about to be reset.
    }
    _skillsNativeDb = null;
  }
  _skillsDb = null;
  _skillsDbPath = null;
}

/**
 * Reset singleton state WITHOUT closing — used between tests to force a
 * re-open against a new tmpdir.
 */
export function resetSkillsDbState(): void {
  closeSkillsDb();
  _skillsInitPromise = null;
}

/**
 * Return the raw `node:sqlite` handle for the open skills.db (or null if
 * not yet initialised). Exposed for the backup/restore pipeline.
 */
export function getSkillsNativeDb(): DatabaseSync | null {
  return _skillsNativeDb;
}

/**
 * Return the absolute path of the currently open skills.db handle, or
 * `null` if no handle is open. Honors test-supplied overrides — the
 * default-resolver path is NOT returned unless a real open happened.
 *
 * Used by the T9693 prune CLI to report `dbSizeBefore` / `dbSizeAfter`
 * against the actually-open file (which may be a tmpdir in tests).
 *
 * @task T9693
 */
export function getOpenSkillsDbPath(): string | null {
  return _skillsDbPath;
}

// ---------------------------------------------------------------------------
// Read / write helpers (acceptance criterion 4)
// ---------------------------------------------------------------------------

/**
 * Fetch a single row from the `skills` table by unique `name`.
 *
 * @param name - The skill identifier (e.g. `ct-orchestrator`).
 * @returns The row, or `null` if no skill is registered with that name.
 *
 * @task T9651
 */
export async function getSkillRow(name: string): Promise<SkillRow | null> {
  const db = await openSkillsDb();
  const rows = db.select().from(skillsTable).where(eq(skillsTable.name, name)).limit(1).all();
  return rows[0] ?? null;
}

/**
 * Error code raised by {@link assertCanonicalWriteAllowed} when a write
 * targets a canonical (Sphere A) row from anything other than the
 * `pr-generator` provenance frame.
 *
 * @task T9708
 */
export const E_CANONICAL_READ_ONLY = 'E_CANONICAL_READ_ONLY';

/**
 * Enforce the canonical-row write-guard on a single {@link NewSkillRow}.
 *
 * Per SG-CLEO-SKILLS architecture-v3 §4-§6, canonical (Sphere A) rows are
 * synthesised exclusively by the owner-CI workflow that opens PRs against
 * the cleocode repo. Any other origin attempting to mutate a canonical
 * row — foreground CLI, background-review fork, an absent provenance
 * frame — MUST be refused.
 *
 * The guard inspects the AsyncLocalStorage frame established by
 * {@link withProvenance}/{@link setCurrentWriteOrigin} (T9705). When the
 * incoming row's `sourceType` is `'canonical'` AND the current origin is
 * anything other than `'pr-generator'`, the function throws with
 * {@link E_CANONICAL_READ_ONLY}. Non-canonical writes are always allowed.
 *
 * This is a defensive layer — the on-disk artefact (`canonical_path` and
 * the bridge symlink to `~/.claude/skills/agents-shared/<name>`) is also
 * mode-protected, but defense-in-depth at the DB write site closes the
 * gap when a future migration legitimately needs to mutate a canonical
 * row (the migration runs inside `withProvenance('pr-generator', ...)`).
 *
 * @param row - The candidate insert/update payload.
 * @throws Error with `code === 'E_CANONICAL_READ_ONLY'` when the guard
 *   refuses the write. The message names the skill and the offending
 *   origin for diagnostics.
 *
 * @task T9708
 * @epic T9563
 * @saga T9560
 */
export function assertCanonicalWriteAllowed(row: NewSkillRow): void {
  if (row.sourceType !== 'canonical') {
    return;
  }
  const origin = getCurrentWriteOrigin();
  if (origin === 'pr-generator') {
    return;
  }
  const observed = origin ?? 'unset';
  const err: Error & { code?: string } = new Error(
    `${E_CANONICAL_READ_ONLY}: refusing canonical write for skill='${row.name}' ` +
      `(observed write-origin='${observed}', required='pr-generator'). ` +
      'Canonical rows are owner-CI-only — run inside withProvenance("pr-generator", ...) ' +
      'or mark the skill as user/community/agent-created.',
  );
  err.code = E_CANONICAL_READ_ONLY;
  throw err;
}

/**
 * Insert-or-update a row keyed by `name`.
 *
 * Implements an upsert via `ON CONFLICT(name) DO UPDATE` so callers don't
 * need to branch on whether the registry already knows about the skill.
 *
 * `id` is ignored on insert (autoincrement) and never mutated on update —
 * the surrogate key is process-stable but not part of the upsert contract.
 *
 * As of T9708 this function also enforces the canonical-row write-guard:
 * any attempt to upsert a row with `sourceType='canonical'` outside of a
 * `withProvenance('pr-generator', ...)` frame is refused with
 * {@link E_CANONICAL_READ_ONLY}. See {@link assertCanonicalWriteAllowed}.
 *
 * @param row - The row payload. `name` is required and `source_type` MUST
 *   be one of the {@link SkillSourceType} enum members; otherwise the
 *   underlying CHECK constraint fires.
 * @returns The row as it now exists on disk (post-upsert).
 *
 * @task T9651
 * @task T9708
 */
export async function upsertSkillRow(row: NewSkillRow): Promise<SkillRow> {
  assertCanonicalWriteAllowed(row);
  const db = await openSkillsDb();

  // Drizzle ORM v1 `.onConflictDoUpdate({ target, set })` updates everything
  // except the conflict target. We exclude `id` from the update set so the
  // surrogate primary key never gets re-assigned.
  const { id: _omitId, ...updateSet } = row;

  db.insert(skillsTable)
    .values(row)
    .onConflictDoUpdate({
      target: skillsTable.name,
      set: updateSet,
    })
    .run();

  const fresh = await getSkillRow(row.name);
  if (!fresh) {
    /* c8 ignore next */
    throw new Error(`upsertSkillRow: row for name='${row.name}' vanished after upsert`);
  }
  return fresh;
}

/**
 * List all skills whose `source_type` equals the given provenance.
 *
 * Ordered by `name` for stable callers (no `ORDER BY` in tests would otherwise
 * be flaky on Linux vs macOS sqlite builds).
 *
 * @param sourceType - One of the {@link SkillSourceType} enum members.
 * @param options - Optional filter narrowing.
 * @returns All matching rows, possibly empty.
 *
 * @task T9651
 */
export async function listSkillsBySource(
  sourceType: SkillSourceType,
  options?: { lifecycleState?: 'active' | 'stale' | 'archived' },
): Promise<SkillRow[]> {
  const db = await openSkillsDb();
  const lifecycleFilter = options?.lifecycleState
    ? eq(skillsTable.lifecycleState, options.lifecycleState)
    : undefined;
  const whereExpr = lifecycleFilter
    ? and(eq(skillsTable.sourceType, sourceType), lifecycleFilter)
    : eq(skillsTable.sourceType, sourceType);
  return db.select().from(skillsTable).where(whereExpr).orderBy(skillsTable.name).all();
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { NodeSQLiteDatabase };
export { skillsSchema };
