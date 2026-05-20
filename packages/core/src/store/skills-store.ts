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

import { desc, eq, lt, sql } from 'drizzle-orm';
import { withProvenance } from '../sentient/skill-provenance.js';
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
  type SkillPatchRow,
  type SkillPatchStatus,
  type SkillReviewOutcome,
  type SkillReviewRow,
  type SkillRow,
  type SkillSourceType,
  type SkillUsageRow,
  skillPatches as skillPatchesTable,
  skillReviews as skillReviewsTable,
  skills as skillsTable,
  skillUsage as skillUsageTable,
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
// Stats facets (T9690 — `cleo skills stats` engine support)
// ---------------------------------------------------------------------------

/**
 * One bucket from {@link countByLifecycle}.
 */
export interface SkillLifecycleCount {
  /** Lifecycle bucket. */
  readonly state: SkillLifecycleState;
  /** Count of skills in this bucket. */
  readonly count: number;
}

/**
 * Group `skills` by `lifecycle_state` and return the per-bucket count.
 *
 * @returns One row per lifecycle bucket present in the table; absent buckets
 *   are omitted (callers fill in zeros if they want a fixed-shape report).
 *
 * @task T9690
 */
export async function countByLifecycle(): Promise<SkillLifecycleCount[]> {
  const db = await openSkillsDb();
  const rows = db
    .select({
      state: skillsTable.lifecycleState,
      count: sql<number>`COUNT(*)`.as('count'),
    })
    .from(skillsTable)
    .groupBy(skillsTable.lifecycleState)
    .orderBy(skillsTable.lifecycleState)
    .all();
  return rows.map((r) => ({ state: r.state as SkillLifecycleState, count: Number(r.count) }));
}

/**
 * One bucket from {@link countBySourceType}.
 */
export interface SkillSourceTypeCount {
  /** Source-type bucket. */
  readonly sourceType: SkillSourceType;
  /** Count of skills in this bucket. */
  readonly count: number;
}

/**
 * Group `skills` by `source_type` and return the per-bucket count.
 *
 * @task T9690
 */
export async function countBySourceType(): Promise<SkillSourceTypeCount[]> {
  const db = await openSkillsDb();
  const rows = db
    .select({
      sourceType: skillsTable.sourceType,
      count: sql<number>`COUNT(*)`.as('count'),
    })
    .from(skillsTable)
    .groupBy(skillsTable.sourceType)
    .orderBy(skillsTable.sourceType)
    .all();
  return rows.map((r) => ({
    sourceType: r.sourceType as SkillSourceType,
    count: Number(r.count),
  }));
}

/**
 * List all skill rows where `is_agent_created` is true, ordered by
 * `installed_at` descending.
 *
 * @task T9690
 */
export async function listAgentCreated(): Promise<SkillRow[]> {
  const db = await openSkillsDb();
  return db
    .select()
    .from(skillsTable)
    .where(eq(skillsTable.isAgentCreated, true))
    .orderBy(desc(skillsTable.installedAt))
    .all();
}

// ---------------------------------------------------------------------------
// Retention (T9693 — `cleo skills prune-telemetry`)
// ---------------------------------------------------------------------------

/**
 * Result envelope from {@link pruneUsageOlderThan}.
 */
export interface PruneUsageResult {
  /** Rows deleted by this call. */
  readonly deletedRows: number;
  /** Oldest `observed_at` still in the table after the prune (`null` if empty). */
  readonly oldestRemaining: string | null;
  /** Newest `observed_at` still in the table after the prune (`null` if empty). */
  readonly newestRemaining: string | null;
}

/**
 * Delete `skill_usage` rows whose `observed_at` is strictly before the
 * given ISO-8601 cutoff.
 *
 * The post-delete `oldestRemaining` / `newestRemaining` fields are returned
 * so the CLI can show a before/after snapshot without re-querying.
 *
 * @param cutoffIso - ISO-8601 timestamp. Rows with `observed_at < cutoffIso`
 *   are deleted; rows with `observed_at = cutoffIso` are retained.
 *
 * @task T9693
 */
export async function pruneUsageOlderThan(cutoffIso: string): Promise<PruneUsageResult> {
  const db = await openSkillsDb();
  const beforeCount = db
    .select({ c: sql<number>`COUNT(*)`.as('c') })
    .from(skillUsageTable)
    .where(lt(skillUsageTable.observedAt, cutoffIso))
    .all();
  const toDelete = Number(beforeCount[0]?.c ?? 0);

  if (toDelete > 0) {
    db.delete(skillUsageTable).where(lt(skillUsageTable.observedAt, cutoffIso)).run();
  }

  const bounds = db
    .select({
      oldest: sql<string | null>`MIN(${skillUsageTable.observedAt})`.as('oldest'),
      newest: sql<string | null>`MAX(${skillUsageTable.observedAt})`.as('newest'),
    })
    .from(skillUsageTable)
    .all();

  return {
    deletedRows: toDelete,
    oldestRemaining: bounds[0]?.oldest ?? null,
    newestRemaining: bounds[0]?.newest ?? null,
  };
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

  // bulkImportFromHermes seeds Sphere A canonical rows — wrap in the
  // `pr-generator` provenance frame so the T9708 write-guard at
  // `upsertSkillRow` allows the canonical insert. Callers outside the
  // owner-CI pipeline that need this entry-point MUST first justify why
  // they are mutating canonical rows (i.e. they ARE the PR generator).
  return withProvenance('pr-generator', async () => {
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
  });
}

// ---------------------------------------------------------------------------
// Review + patch adapters (T9750 — extracted from `cleo sentient` CLI)
// ---------------------------------------------------------------------------

/**
 * One row in {@link listSkillReviews} output joining `skill_reviews` to the
 * most recent `skill_patches` row for the same skill plus the parent
 * `skills` row.
 *
 * The CLI uses this exact shape; persisting it in CORE keeps the adapter
 * and CLI handler in lock-step without a duplicate type.
 *
 * @task T9750
 */
export interface SkillReviewListEntry {
  /** `skill_reviews.id`. */
  readonly reviewId: number;
  /** `skill_reviews.skill_name`. */
  readonly skillName: string;
  /** ISO-8601 review timestamp. */
  readonly reviewedAt: string;
  /** Council verdict. */
  readonly outcome: SkillReviewOutcome;
  /** Free-form chairman / grade summary. */
  readonly summary: string | null;
  /** Linked patch id (latest by `proposedAt`), or `null` if none. */
  readonly patchId: number | null;
  /** Patch status when present. */
  readonly patchStatus: SkillPatchStatus | null;
  /** True when the parent `skills.source_type` is `'canonical'`. */
  readonly isCanonical: boolean;
}

/**
 * Filter options for {@link listSkillReviews}.
 *
 * @task T9750
 */
export interface ListSkillReviewsFilters {
  /**
   * When `true`, drop entries whose latest patch is NOT in the `'proposed'`
   * state. Used by the CLI to surface only actionable rows.
   */
  readonly pendingOnly?: boolean;
  /**
   * Max number of rows to return. Non-finite or non-positive values are
   * normalised to `50`.
   */
  readonly limit?: number;
}

/**
 * List review rows (newest-first) with the most-recent linked patch +
 * `isCanonical` flag joined in. Replaces the inline `openSkillsDb` blocks
 * in `cleo sentient review-status list` (T9727 → T9750).
 *
 * @param filters - See {@link ListSkillReviewsFilters}.
 * @returns Joined snapshot, already filtered by `pendingOnly` and capped at
 *   `limit`. Empty array when no reviews exist.
 *
 * @task T9750
 */
export async function listSkillReviews(
  filters: ListSkillReviewsFilters = {},
): Promise<SkillReviewListEntry[]> {
  const rawLimit = filters.limit;
  const limit =
    Number.isInteger(rawLimit) && rawLimit !== undefined && rawLimit > 0 ? rawLimit : 50;
  const pendingOnly = filters.pendingOnly === true;
  const db = await openSkillsDb();

  const reviews = db
    .select()
    .from(skillReviewsTable)
    .orderBy(skillReviewsTable.reviewedAt)
    .limit(limit)
    .all();

  const entries: SkillReviewListEntry[] = [];
  for (const review of reviews) {
    const skillRow = db
      .select()
      .from(skillsTable)
      .where(eq(skillsTable.name, review.skillName))
      .limit(1)
      .all()[0];
    const latestPatch = db
      .select()
      .from(skillPatchesTable)
      .where(eq(skillPatchesTable.skillName, review.skillName))
      .orderBy(desc(skillPatchesTable.proposedAt))
      .limit(1)
      .all()[0];
    if (pendingOnly && latestPatch?.status !== 'proposed') {
      continue;
    }
    entries.push({
      reviewId: review.id,
      skillName: review.skillName,
      reviewedAt: review.reviewedAt,
      outcome: review.outcome,
      summary: review.summary ?? null,
      patchId: latestPatch?.id ?? null,
      patchStatus: latestPatch?.status ?? null,
      isCanonical: skillRow?.sourceType === 'canonical',
    });
  }
  return entries;
}

/**
 * Detailed envelope returned by {@link getSkillReview}. Bundles the review
 * row, all associated patches, the parent skill row, and the canonical flag.
 *
 * @task T9750
 */
export interface SkillReviewDetail {
  /** The `skill_reviews` row, or `null` if no row matches `reviewId`. */
  readonly review: SkillReviewRow | null;
  /** All `skill_patches` rows whose `review_id` equals `reviewId`. */
  readonly patches: readonly SkillPatchRow[];
  /** Parent `skills` row, or `null` if the join misses (orphan review). */
  readonly skillRow: SkillRow | null;
  /** True when `skillRow?.sourceType === 'canonical'`. */
  readonly isCanonical: boolean;
}

/**
 * Fetch a single review by id with all linked patches + parent skill row.
 *
 * Returns `{ review: null, ... }` when `reviewId` is absent so callers can
 * differentiate "not found" from server error without try/catch.
 *
 * @param reviewId - `skill_reviews.id` — MUST be a positive integer; the
 *   caller is responsible for validating the input before passing it in.
 *
 * @task T9750
 */
export async function getSkillReview(reviewId: number): Promise<SkillReviewDetail> {
  const db = await openSkillsDb();
  const review = db
    .select()
    .from(skillReviewsTable)
    .where(eq(skillReviewsTable.id, reviewId))
    .get();
  if (!review) {
    return { review: null, patches: [], skillRow: null, isCanonical: false };
  }
  const skillRow =
    db.select().from(skillsTable).where(eq(skillsTable.name, review.skillName)).limit(1).all()[0] ??
    null;
  const patches = db
    .select()
    .from(skillPatchesTable)
    .where(eq(skillPatchesTable.reviewId, reviewId))
    .all();
  return {
    review,
    patches,
    skillRow,
    isCanonical: skillRow?.sourceType === 'canonical',
  };
}

/**
 * Detailed envelope returned by {@link getSkillPatch}. Bundles the patch
 * row plus the parent skill row + canonical flag — the exact shape the
 * `cleo sentient review-status accept` handler needs to route between
 * Sphere A PR-cut and Sphere B local-apply.
 *
 * @task T9750
 */
export interface SkillPatchDetail {
  /** The `skill_patches` row, or `null` if `patchId` does not exist. */
  readonly patch: SkillPatchRow | null;
  /** Parent `skills` row, or `null` (orphan patch). */
  readonly skillRow: SkillRow | null;
  /** True when `skillRow?.sourceType === 'canonical'`. */
  readonly isCanonical: boolean;
}

/**
 * Fetch a single patch by id plus its parent skill row.
 *
 * @param patchId - `skill_patches.id` — MUST be a positive integer.
 *
 * @task T9750
 */
export async function getSkillPatch(patchId: number): Promise<SkillPatchDetail> {
  const db = await openSkillsDb();
  const patch = db.select().from(skillPatchesTable).where(eq(skillPatchesTable.id, patchId)).get();
  if (!patch) {
    return { patch: null, skillRow: null, isCanonical: false };
  }
  const skillRow =
    db.select().from(skillsTable).where(eq(skillsTable.name, patch.skillName)).limit(1).all()[0] ??
    null;
  return {
    patch,
    skillRow,
    isCanonical: skillRow?.sourceType === 'canonical',
  };
}

/**
 * Result of {@link markSkillPatchRejected}.
 *
 * @task T9750
 */
export interface MarkSkillPatchRejectedResult {
  /** True when an UPDATE actually ran (status flipped to `'rejected'`). */
  readonly updated: boolean;
  /** Snapshot row immediately after the UPDATE (or pre-call if no-op). */
  readonly patch: SkillPatchRow | null;
}

/**
 * Mark a `skill_patches` row as `'rejected'`.
 *
 * Idempotent — calling again on an already-rejected row returns
 * `updated:false` with the same snapshot. Safe to call on missing ids
 * (returns `{ updated: false, patch: null }`).
 *
 * @param patchId - `skill_patches.id` to reject.
 *
 * @task T9750
 */
export async function markSkillPatchRejected(
  patchId: number,
): Promise<MarkSkillPatchRejectedResult> {
  const db = await openSkillsDb();
  const existing = db
    .select()
    .from(skillPatchesTable)
    .where(eq(skillPatchesTable.id, patchId))
    .get();
  if (!existing) {
    return { updated: false, patch: null };
  }
  if (existing.status === 'rejected') {
    return { updated: false, patch: existing };
  }
  db.update(skillPatchesTable)
    .set({ status: 'rejected' })
    .where(eq(skillPatchesTable.id, patchId))
    .run();
  const after =
    db.select().from(skillPatchesTable).where(eq(skillPatchesTable.id, patchId)).get() ?? null;
  return { updated: true, patch: after };
}

// ---------------------------------------------------------------------------
// Re-exports — keep this module the single import site for Sphere B callers.
// ---------------------------------------------------------------------------

export type {
  NewSkillRow,
  NewSkillUsageRow,
  SkillLifecycleState,
  SkillPatchRow,
  SkillPatchStatus,
  SkillReviewOutcome,
  SkillReviewRow,
  SkillRow,
  SkillSourceType,
  SkillUsageRow,
};
