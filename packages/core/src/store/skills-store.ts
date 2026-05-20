/**
 * Typed Drizzle adapter facade over `skills.db` — Sphere B foundation.
 *
 * Wraps the lower-level chokepoint opener {@link openSkillsDb} with a thin,
 * type-safe API the rest of the SDK / CLI uses to write telemetry, browse
 * the registry, and bulk-import the Hermes seed manifest.
 *
 * ## Why a separate facade?
 *
 * `skills-db.ts` owns the database lifecycle (open, migrate, close). It also
 * exposes 3 hand-rolled helpers ({@link getSkillRow}, {@link upsertSkillRow},
 * {@link listSkillsBySource}) because the T9651 charter required them.
 *
 * This module (T9688) builds the broader Sphere B query surface on top of
 * those primitives WITHOUT touching the public API of `skills-db.ts`. The
 * existing exports are re-exported below so downstream callers have a single
 * import site — `@cleocode/core/store/skills-store`.
 *
 * ## Surface (acceptance criteria T9688)
 *
 * - `insertUsage`            — append a telemetry row to `skill_usage`.
 * - `getSkillByName`         — alias for {@link getSkillRow} (Sphere B naming).
 * - `listByLifecycle`        — enumerate skills filtered by lifecycle state.
 * - `getTopUsed`             — usage rollup powering council-seeding rankings.
 * - `listSkillsBySource`     — re-export of {@link listSkillsBySource}.
 * - `bulkImportFromHermes`   — stub for the Hermes seed manifest importer
 *                              (full implementation lands in T96xx; this stub
 *                              materialises the parameter contract so callers
 *                              can wire up against a stable signature today).
 *
 * @task T9688
 * @epic T9571
 * @saga T9560
 * @adr ADR-068 (DB-open chokepoint), ADR-069 (Coordination Layers)
 * @architecture docs/architecture/SG-CLEO-SKILLS-architecture-v3.md §4-§5
 */

import { desc, eq, sql } from 'drizzle-orm';
import {
  getSkillRow as _getSkillRow,
  listSkillsBySource as _listSkillsBySource,
  upsertSkillRow as _upsertSkillRow,
  openSkillsDb,
} from './skills-db.js';
import {
  type NewSkillRow,
  type NewSkillUsageRow,
  type SkillLifecycleState,
  type SkillRow,
  type SkillSourceType,
  type SkillUsageRow,
  skillUsage as skillUsageTable,
  skills as skillsTable,
} from './skills-schema.js';

// ---------------------------------------------------------------------------
// Telemetry — Sphere B writes (Sphere A is opt-out aggregated only, §5)
// ---------------------------------------------------------------------------

/**
 * Insert a telemetry event into `skill_usage`.
 *
 * No validation beyond what the Drizzle CHECK constraints already enforce.
 * The caller is responsible for not emitting events for `canonical`
 * (Sphere A) skill rows when the user has opted out of telemetry — that
 * policy lives at the call site, not in this storage primitive.
 *
 * @param row - Telemetry payload. `skillName` and `eventKind` are required;
 *   `observedAt` defaults to `CURRENT_TIMESTAMP` server-side and `metadata`
 *   defaults to `'{}'`.
 * @returns The persisted row, including the server-assigned `id` and
 *   `observedAt`.
 *
 * @task T9688
 */
export async function insertUsage(row: NewSkillUsageRow): Promise<SkillUsageRow> {
  const db = await openSkillsDb();
  const inserted = db.insert(skillUsageTable).values(row).returning().all();
  const persisted = inserted[0];
  if (!persisted) {
    /* c8 ignore next */
    throw new Error(
      `insertUsage: INSERT returned no rows for skillName='${row.skillName}' eventKind='${row.eventKind}'`,
    );
  }
  return persisted;
}

// ---------------------------------------------------------------------------
// Read helpers — Sphere B query surface
// ---------------------------------------------------------------------------

/**
 * Fetch a single skill row by unique `name`.
 *
 * Re-exports {@link getSkillRow} from `skills-db.ts` under the Sphere B
 * naming convention requested by the T9688 charter so call sites don't
 * need to know about the two-module split.
 *
 * @param name - The skill identifier (e.g. `ct-orchestrator`).
 * @returns The row, or `null` if no skill is registered with that name.
 *
 * @task T9688
 */
export async function getSkillByName(name: string): Promise<SkillRow | null> {
  return _getSkillRow(name);
}

/**
 * List all skills in a given lifecycle state, ordered by `name`.
 *
 * Useful for cleanup sweeps and council-seeding manifests that need to walk
 * `active` rows only without touching archived/stale entries.
 *
 * @param state - Lifecycle state filter — see {@link SkillLifecycleState}.
 * @returns All matching rows, possibly empty.
 *
 * @task T9688
 */
export async function listByLifecycle(state: SkillLifecycleState): Promise<SkillRow[]> {
  const db = await openSkillsDb();
  return db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.lifecycleState, state))
    .orderBy(skillsTable.name)
    .all();
}

/**
 * Aggregate row returned by {@link getTopUsed}.
 *
 * Each entry pairs a skill name with the count of `skill_usage` rows that
 * reference it. Ordered by `count` descending — ties broken by `skillName`
 * ascending for deterministic snapshots.
 */
export interface SkillUsageRollup {
  /** The skill identifier (matches {@link SkillRow.name}). */
  readonly skillName: string;
  /** Number of `skill_usage` rows referencing this skill in the queried window. */
  readonly count: number;
}

/**
 * Top-N usage rollup powering the council-seeding ranker.
 *
 * Aggregates `skill_usage.skill_name` and orders by event count descending.
 * The `limit` is enforced at the SQL layer so the result set stays bounded
 * even on large telemetry tables.
 *
 * @param limit - Maximum number of rows to return. MUST be a positive
 *   integer; non-finite or non-positive values are normalised to `10`.
 * @returns Up to `limit` rollup rows, ordered by `count DESC, skillName ASC`.
 *
 * @task T9688
 */
export async function getTopUsed(limit = 10): Promise<SkillUsageRollup[]> {
  const normalisedLimit = Number.isInteger(limit) && limit > 0 ? limit : 10;
  const db = await openSkillsDb();
  const rows = db
    .select({
      skillName: skillUsageTable.skillName,
      count: sql<number>`COUNT(*)`.as('count'),
    })
    .from(skillUsageTable)
    .groupBy(skillUsageTable.skillName)
    .orderBy(desc(sql`COUNT(*)`), skillUsageTable.skillName)
    .limit(normalisedLimit)
    .all();
  return rows.map((r) => ({ skillName: r.skillName, count: Number(r.count) }));
}

/**
 * List all skills whose `source_type` equals the given provenance.
 *
 * Re-exported from `skills-db.ts` so callers only need to import from
 * `@cleocode/core/store/skills-store`.
 *
 * @task T9688
 */
export async function listSkillsBySource(
  sourceType: SkillSourceType,
  options?: { lifecycleState?: SkillLifecycleState },
): Promise<SkillRow[]> {
  return _listSkillsBySource(sourceType, options);
}

// ---------------------------------------------------------------------------
// Hermes import — STUB (full impl lands in a downstream task)
// ---------------------------------------------------------------------------

/**
 * Manifest entry for a single skill being imported from a Hermes seed.
 *
 * Mirrors the column shape of {@link NewSkillRow} but excludes server-managed
 * fields (`id`, `installedAt` default, etc.) so callers can build the array
 * from a JSON manifest without re-deriving defaults.
 */
export interface HermesSeedEntry {
  /** Skill identifier — must be globally unique. */
  readonly name: string;
  /** Semver from frontmatter, if present. */
  readonly version?: string;
  /** Resolved on-disk path (post-clone). */
  readonly installPath: string;
  /** Origin URL for the seed (Hermes manifest source). */
  readonly sourceUrl?: string;
  /** XDG canonical path if this entry is being seeded as Sphere A. */
  readonly canonicalPath?: string;
}

/**
 * Result envelope returned by {@link bulkImportFromHermes}.
 *
 * The full implementation will populate `imported`, `skipped`, and `failed`
 * with per-entry details. The stub returns the input length under `imported`
 * so callers can integration-test the wire contract today.
 */
export interface BulkImportResult {
  /** Number of entries successfully upserted into `skills`. */
  readonly imported: number;
  /** Number of entries skipped (e.g. already present with same hash). */
  readonly skipped: number;
  /** Names of entries that failed validation. */
  readonly failed: readonly string[];
}

/**
 * Bulk-import a Hermes-generated skill seed manifest into `skills.db`.
 *
 * ⚠️ STUB IMPLEMENTATION (T9688 charter explicitly scopes this as a stub).
 *
 * The current behaviour delegates each entry to {@link upsertSkillRow} with
 * `sourceType='canonical'` and `installedAt=NOW()`. It is intentionally
 * permissive — full validation, hash-based skip logic, and partial-failure
 * reporting are deferred to a downstream task under SG-CLEO-SKILLS.
 *
 * The contract IS stable: callers can safely wire against this signature
 * today and the future expansion will not break them.
 *
 * @param entries - Hermes seed entries. Empty arrays are a no-op.
 * @returns Counts of imported / skipped / failed entries.
 *
 * @task T9688
 */
export async function bulkImportFromHermes(
  entries: readonly HermesSeedEntry[],
): Promise<BulkImportResult> {
  if (entries.length === 0) {
    return { imported: 0, skipped: 0, failed: [] };
  }

  const now = new Date().toISOString();
  const failed: string[] = [];
  let imported = 0;

  for (const entry of entries) {
    const row: NewSkillRow = {
      name: entry.name,
      version: entry.version ?? null,
      sourceType: 'canonical',
      sourceUrl: entry.sourceUrl ?? null,
      installPath: entry.installPath,
      canonicalPath: entry.canonicalPath ?? null,
      installedAt: now,
      lastUpdatedAt: now,
      lifecycleState: 'active',
      pinned: false,
      isAgentCreated: false,
      archivedAt: null,
      archivedFromPath: null,
    };

    try {
      await _upsertSkillRow(row);
      imported++;
    } catch {
      failed.push(entry.name);
    }
  }

  return { imported, skipped: 0, failed };
}

// ---------------------------------------------------------------------------
// Re-exports — keep this module the single import site for Sphere B callers.
// ---------------------------------------------------------------------------

export type {
  NewSkillRow,
  NewSkillUsageRow,
  SkillLifecycleState,
  SkillRow,
  SkillSourceType,
  SkillUsageRow,
};
