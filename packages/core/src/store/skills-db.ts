/**
 * Per-user skills registry lifecycle module — opener, helpers.
 *
 * The per-user skills registry is a global-tier domain described in
 * `docs/architecture/SG-CLEO-SKILLS-architecture-v3.md` §4.
 *
 * ## E6-L5 — thin-facade migration (T11525)
 *
 * `openSkillsDb()` is now a thin facade that delegates the database open to
 * {@link openDualScopeDb}('global') — the canonical dual-scope chokepoint
 * (E3/E4 · T11512/T11517) already adopted by the tasks (E6-L1), brain (E6-L2),
 * conduit (E6-L3), and nexus (E6-L4) domains. The skills registry tables now
 * live inside the consolidated GLOBAL `cleo.db` under `getCleoHome()`, sharing
 * the SAME native handle the nexus / signaldock global domains use — NOT a
 * separate `skills.db` file.
 *
 * ## Why prefixed `skills_*` tables (no establishLegacy rebuild)
 *
 * Unlike nexus (E6-L4), the skills registry does NOT run its legacy
 * `drizzle-skills` migration on the shared handle. That migration created BARE
 * `skills` / `skill_usage` / … tables — and the bare `skills` name COLLIDES with
 * the signaldock domain's own legacy `skills` slug-catalog now that both share
 * one `cleo.db`. The consolidated `drizzle-cleo-global` migration already creates
 * the registry tables under the domain-prefixed names (`skills_skills`,
 * `skills_skill_usage`, …), column-identical to the legacy shape plus additive
 * enum/timestamp/boolean CHECK constraints that ACCEPT every value the runtime
 * writers produce (ISO-8601 text, 0/1 booleans — verified). So skills-db simply
 * binds the (now prefix-renamed) `skillsSchema` drizzle queries to those
 * already-created consolidated tables. No drop+rebuild is needed because there is
 * no consolidated-vs-legacy shape incompatibility (the L4 precondition is absent).
 *
 * The residency MOVE of skills global→project and the exodus data copy from the
 * legacy standalone `skills.db` are SEPARATE later tasks (T11553 / T11538).
 *
 * @task T9651
 * @task T11525 - E6-L5: route openSkillsDb through openDualScopeDb('global') (SG-DB-SUBSTRATE-V2)
 * @epic T9571
 * @epic T11249
 * @saga T9560
 * @adr ADR-068, ADR-069
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §4
 */

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { and, eq } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoHome } from '../paths.js';
import { getCurrentWriteOrigin } from '../sentient/skill-provenance.js';
// E6-L5 (T11525): dual-scope chokepoint — the skills registry opens the
// consolidated GLOBAL `cleo.db` through here. openDualScopeDb manages the
// DatabaseSync lifecycle, pragmas, and consolidated migrations (which create the
// prefixed `skills_*` tables). We extract the native handle and re-wrap it with
// the prefix-renamed skills schema so existing callers compile unchanged.
import { _resetDualScopeDbCache, openDualScopeDb, openDualScopeDbAtPath } from './dual-scope-db.js';
import * as skillsSchema from './schema/skills-schema.js';
import {
  type NewSkillRow,
  type SkillRow,
  type SkillSourceType,
  skills as skillsTable,
} from './schema/skills-schema.js';

/**
 * Legacy standalone skills.db file name within `getCleoHome()`.
 *
 * E6-L5 (T11525): the live skills registry now consolidates into the shared
 * GLOBAL `cleo.db`; this literal is retained only for the backup/exodus paths
 * that still read the pre-cutover standalone file.
 */
export const SKILLS_DB_FILENAME = 'skills.db';

/** Schema version constant. Retained for compatibility with external re-exporters. */
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
 * Resolve the canonical filesystem path for the skills registry DB.
 *
 * E6-L5 (T11525): resolves `getCleoHome()` + `cleo.db` — the consolidated GLOBAL
 * `cleo.db` that now hosts the `skills_*` registry tables (the same path
 * {@link openDualScopeDb}('global') opens). Always returns a path under
 * `getCleoHome()`. Throws if the resolved path somehow escapes that prefix — that
 * would indicate a regression in `getCleoHome()` itself and MUST be fixed at the
 * source, not silently tolerated.
 *
 * @returns Absolute path to the consolidated `cleo.db`.
 * @throws {Error} If the resolved path is not under `getCleoHome()`.
 */
export function getDefaultSkillsDbPath(): string {
  // Resolve via THIS module's getCleoHome binding so the path and the guard are
  // self-consistent — see the same note on signaldock-sqlite.getGlobalAgentRegistryDbPath
  // (T11525). resolveDualScopeDbPath('global') builds the identical path but binds
  // getCleoHome through dual-scope-db's module graph, which can diverge under
  // per-test vi.doMock timing.
  const cleoHome = getCleoHome();
  const dbPath = join(cleoHome, 'cleo.db');
  if (!dbPath.startsWith(cleoHome)) {
    /* c8 ignore next 6 — unreachable: dbPath is built FROM cleoHome above. */
    throw new Error(
      `BUG: getDefaultSkillsDbPath() resolved to "${dbPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). The skills registry is global-only per ` +
        `SG-CLEO-SKILLS-architecture-v3.md §4. Fix the caller, do not suppress.`,
    );
  }
  return dbPath;
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
   * leave this `undefined` to let the module resolve {@link getDefaultSkillsDbPath}.
   *
   * E6-L5 (T11525): the override path is opened as a consolidated GLOBAL
   * `cleo.db` (the prefixed `skills_*` tables are created by the consolidated
   * migration) via {@link openDualScopeDbAtPath}, so a test passing
   * `<tmpdir>/skills.db` materialises an isolated consolidated DB at that exact
   * path — distinct cache key from the canonical `cleo.db`.
   */
  path?: string;
}

/**
 * Open (or first-time materialise) the skills registry and return the Drizzle
 * handle bound to the prefixed `skills_*` tables.
 *
 * E6-L5 (T11525): delegates the physical open to {@link openDualScopeDb}('global')
 * (or {@link openDualScopeDbAtPath} for the test `{ path }` override) — the
 * canonical dual-scope chokepoint — and re-wraps its native handle with the
 * prefix-renamed `skillsSchema` drizzle instance. The consolidated
 * `drizzle-cleo-global` migration creates the `skills_*` tables; this module does
 * NOT run the legacy `drizzle-skills` migration (which would create the
 * signaldock-colliding bare `skills` table). Idempotent: repeated calls with the
 * same effective path return the cached singleton.
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
 * @returns A Drizzle ORM handle bound to the four `skills_*` registry tables.
 *
 * @task T9651
 * @task T11525
 */
export async function openSkillsDb(
  options?: OpenSkillsDbOptions,
): Promise<NodeSQLiteDatabase<typeof skillsSchema>> {
  // Fast-path: if no explicit override was requested AND a singleton already
  // exists, return it without re-resolving `getDefaultSkillsDbPath()`. This
  // is important for tests that open the DB at a tmpdir via `{path:...}` and
  // then exercise helpers that call `openSkillsDb()` with no args; without
  // this guard the helper call would swap the singleton over to the real
  // consolidated cleo.db path and leak writes outside the test sandbox.
  if (_skillsDb && !options?.path) return _skillsDb;

  const requestedPath = options?.path ?? getDefaultSkillsDbPath();

  // If singleton points at a different file, reset cleanly.
  if (_skillsDb && _skillsDbPath !== requestedPath) {
    resetSkillsDbState();
  }

  // Liveness guard (T11525): the skills registry SHARES the consolidated GLOBAL
  // `cleo.db` handle with the nexus / signaldock domains. A sibling may have
  // closed + re-opened the shared handle while our singleton still references the
  // now-closed one. Detect a stale (closed) handle and drop the singleton so we
  // re-derive from the live dual-scope cache below.
  if (_skillsDb && (_skillsNativeDb === null || !_skillsNativeDb.isOpen)) {
    resetSkillsDbState();
  }

  if (_skillsDb) return _skillsDb;

  if (_skillsInitPromise) return _skillsInitPromise;

  _skillsInitPromise = (async () => {
    _skillsDbPath = requestedPath;

    // ── Dual-scope chokepoint delegation (T11525 · E6-L5) ───────────────────
    // openDualScopeDb('global') applies the pragma SSoT, creates the directory,
    // runs the consolidated cleo-global migrations (which create the prefixed
    // `skills_*` tables), and manages the singleton cache. The `{ path }` test
    // override routes through the path-aware sibling against an isolated file.
    const dualHandle = options?.path
      ? await openDualScopeDbAtPath('global', options.path)
      : await openDualScopeDb('global');

    // Extract the underlying DatabaseSync. Drizzle exposes it via `$client`.
    const nativeDb = (dualHandle.db as { $client?: DatabaseSync }).$client ?? null;
    if (!nativeDb) {
      throw new Error(
        'E6-L5: openDualScopeDb returned a handle without $client — ' +
          'cannot extract DatabaseSync for the skills-schema wrapping.',
      );
    }
    _skillsNativeDb = nativeDb;

    // Wrap the native handle with the prefix-renamed skills schema so existing
    // callers (skillsSchema.* queries) bind to the consolidated `skills_*`
    // tables the dual-scope migration already created.
    const db = drizzle({ client: nativeDb, schema: skillsSchema });

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
 * Drop the skills-domain singleton references and trigger the coordinated close
 * of the shared GLOBAL `cleo.db` handle via the dual-scope cache.
 *
 * ## E6-L5 (T11525) — shared-handle close rule
 *
 * `_skillsNativeDb` is the SHARED consolidated GLOBAL `cleo.db` handle owned by
 * {@link openDualScopeDb}('global') and co-owned by the nexus / signaldock global
 * domains. This function MUST NOT call `.close()` on it directly — doing so would
 * tear the handle out from under those siblings (the exact bug class L4 fixed at
 * `dual-scope-db.ts`). Instead it evicts the GLOBAL-scope entry from the
 * dual-scope cache (a single coordinated close) and drops the local references.
 *
 * Safe to call multiple times. Used by `cleo backup restore` and tests that
 * mkdtemp a fresh location between cases.
 *
 * @task T9651
 * @task T11525
 */
export function closeSkillsDb(): void {
  // Drop only the local references. The scope-filtered cache reset performs the
  // single coordinated close of the shared GLOBAL handle.
  _skillsNativeDb = null;
  _skillsDb = null;
  _skillsDbPath = null;
  _skillsInitPromise = null;
  _resetDualScopeDbCache('global');
}

/**
 * Reset singleton state — used between tests to force a re-open against a new
 * tmpdir. E6-L5: identical to {@link closeSkillsDb} (both go through the
 * scope-filtered dual-scope cache reset; neither closes the shared handle
 * directly).
 *
 * @task T9651
 * @task T11525
 */
export function resetSkillsDbState(): void {
  _skillsNativeDb = null;
  _skillsDb = null;
  _skillsDbPath = null;
  _skillsInitPromise = null;
  _resetDualScopeDbCache('global');
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
