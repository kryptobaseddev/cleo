/**
 * Release operations backed by the canonical `releases` SQLite table.
 *
 * Originally migrated from `.cleo/releases.json` into `release_manifests`
 * by T5580. T9686-B2 unified `release_manifests` into the new `releases`
 * table (T9508) and dropped the legacy table — every read/write here now
 * targets the single canonical `releases` table via Drizzle ORM.
 *
 * T9756 (T9738-D / A4) eliminated the dual PK shape introduced by T9686-B2.
 * Every row — legacy-migrated AND new-pipeline — now uses the uniform
 * `<projectHash>:<version>` PK shape. The migration at
 * `20260520163500_t9756-uniform-releases-pk/` rewrites historical
 * `legacy:<version>` rows in place. New writes (via {@link prepareRelease}
 * and {@link migrateReleasesFromJson}) derive `<projectHash>` from
 * {@link generateProjectHash} so all rows share one shape.
 *
 * Provenance discrimination is no longer carried by the PK prefix. The
 * `tasksJson` column (NOT NULL on legacy rows, NULL on new-pipeline rows)
 * serves as the column-level discriminator consumed by
 * {@link releasesRowToManifest}.
 *
 * The status enum on the unified table is the union of both lifecycles:
 *   New T9492: planned / pr-opened / pr-merged / published / reconciled
 *   Legacy T5580: prepared / committed / tagged / pushed
 *   Shared terminals: rolled_back / failed / cancelled
 *
 * @task T5580
 * @task T4788
 * @task T9686 (unification)
 * @task T9756 (uniform PK shape)
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import { generateProjectHash } from '../nexus/hash.js';
import { createPage } from '../pagination.js';
import { getProjectRoot, resolveCanonicalCleoDir, resolveProjectByCwd } from '../paths.js';
import * as schema from '../store/tasks-schema.js';
import type { ReleaseChannel } from './channel.js';
import { resolveChannelFromBranch } from './channel.js';
import type { BranchProtectionResult } from './github-pr.js';
import { detectBranchProtection } from './github-pr.js';
import type { PushMode } from './release-config.js';
import {
  getChannelConfig,
  getGitFlowConfig,
  getPushMode,
  loadReleaseConfig,
} from './release-config.js';
import { resolveVersionBumpTargets } from './version-bump.js';

// ── Provenance dual-write retirement (T9541) ─────────────────────────────────

/**
 * Sentinel file recording that the CLEO_PROVENANCE_DUAL_WRITE env var has been
 * retired. Written once per project on the first shipped release after the
 * upgrade — its presence is the audit signal that retirement has occurred.
 *
 * @task T9541
 * @see SPEC-T9345 §12.2
 */
const DUAL_WRITE_RETIRED_FLAG = '.cleo/audit/dual-write-retired.flag';

/**
 * Append-only JSONL log of dual-write retirement events. Each entry records a
 * single observation that `markReleaseShipped` ran post-retirement (env var
 * gone, new-table writes unconditional). Errors are swallowed so audit writes
 * never block release operations.
 *
 * @task T9541
 */
const DUAL_WRITE_RETIRED_LOG = '.cleo/audit/dual-write-retired.jsonl';

/**
 * Record the first post-retirement run for a project (idempotent).
 *
 * Writes a sentinel flag file plus a single JSONL entry the first time
 * {@link markReleaseShipped} executes after the env var is removed. Subsequent
 * runs are no-ops (sentinel already exists).
 *
 * Audit writes are best-effort — filesystem errors never propagate.
 *
 * @param projectRoot - Absolute path to the CLEO project root.
 * @param version     - Release version being shipped.
 *
 * @task T9541
 */
function recordDualWriteRetirementOnce(projectRoot: string, version: string): void {
  try {
    const flagPath = join(projectRoot, DUAL_WRITE_RETIRED_FLAG);
    if (existsSync(flagPath)) {
      return;
    }
    mkdirSync(dirname(flagPath), { recursive: true });
    const timestamp = new Date().toISOString();
    writeFileSync(
      flagPath,
      JSON.stringify(
        {
          retiredAt: timestamp,
          task: 'T9541',
          phase: 'Phase 6 / 2 of 2 of T9499',
          note: 'CLEO_PROVENANCE_DUAL_WRITE env var retired; new-table writes are unconditional.',
        },
        null,
        2,
      ),
      { encoding: 'utf-8' },
    );
    const logPath = join(projectRoot, DUAL_WRITE_RETIRED_LOG);
    appendFileSync(
      logPath,
      `${JSON.stringify({
        timestamp,
        task: 'T9541',
        event: 'dual-write-retired',
        version,
        note: 'First post-retirement markReleaseShipped invocation observed.',
      })}\n`,
      { encoding: 'utf-8' },
    );
  } catch {
    // non-fatal — audit writes must never block release operations
  }
}

async function getDb(cwd?: string): ReturnType<typeof import('../store/sqlite.js')['getDb']> {
  const { getDb: _getDb } = await import('../store/sqlite.js');
  return _getDb(cwd);
}

// ── Types ────────────────────────────────────────────────────────────

/**
 * Status values admitted by the unified `releases` table (T9686-B2).
 *
 * The status value itself discriminates the source pipeline — no separate
 * `pipeline` column is needed.
 *
 * - **New T9492 pipeline**: `planned | pr-opened | pr-merged | published |
 *   reconciled` — set by `cleo release plan` / `open` / `reconcile`.
 * - **Legacy T5580 pipeline**: `prepared | committed | tagged | pushed` —
 *   set by `cleo release prepare` / `commit` / `tag` / `push`. (The historic
 *   `draft` value is retained for backward compatibility with any callers
 *   that branch on it, but no live row in the production DB has ever held
 *   `draft`.)
 * - **Shared terminals**: `rolled_back | failed | cancelled`.
 *
 * Consumers MUST handle both lifecycles. Code that needs to know which
 * pipeline owns a row can branch on `manifest.source` ('new' | 'legacy'),
 * derived from the row PK at read time.
 *
 * @task T9686
 */
export type ReleaseManifestStatus =
  // legacy statuses (T5580 pipeline)
  | 'draft'
  | 'prepared'
  | 'committed'
  | 'tagged'
  | 'pushed'
  | 'rolled_back'
  // new pipeline statuses (T9492 pipeline)
  | 'planned'
  | 'pr-opened'
  | 'pr-merged'
  | 'published'
  | 'reconciled'
  | 'failed'
  | 'cancelled';

/** Release manifest structure. */
export interface ReleaseManifest {
  version: string;
  status: ReleaseManifestStatus;
  createdAt: string;
  preparedAt?: string;
  committedAt?: string;
  taggedAt?: string;
  pushedAt?: string;
  tasks: string[];
  notes?: string;
  changelog?: string;
  previousVersion?: string;
  commitSha?: string;
  gitTag?: string;
  /**
   * Provenance discriminator added by T9686.
   *
   * - `'new'` — row came from the `releases` table (new pipeline).
   * - `'legacy'` — row came from the `release_manifests` table (pre-T9492).
   *
   * Callers that only care about the legacy shape can ignore this field; it is
   * always populated by reads through `releases_view`.
   *
   * @task T9686
   */
  source?: 'new' | 'legacy';
}

export interface ReleaseListOptions {
  status?: ReleaseManifest['status'];
  limit?: number;
  offset?: number;
}

function normalizeLimit(limit: number | undefined): number | undefined {
  return typeof limit === 'number' && limit > 0 ? limit : undefined;
}

function normalizeOffset(offset: number | undefined): number | undefined {
  return typeof offset === 'number' && offset > 0 ? offset : undefined;
}

function effectivePageLimit(
  limit: number | undefined,
  offset: number | undefined,
): number | undefined {
  return limit ?? (offset !== undefined ? 50 : undefined);
}

/**
 * Project-root resolution for {@link generateProjectHash} that mirrors the
 * tolerant fallback used by {@link resolveCanonicalCleoDir}: try the strict
 * `getProjectRoot` walk-up first, fall back to the literal `cwd` (or
 * `process.cwd()`) when the strict check fails.
 *
 * Without this fallback, callers operating in tmp directories that do not
 * yet satisfy the strict `.cleo + .git` predicate (e.g. unit-test sandboxes,
 * the `cleo init` bootstrap path) would crash before they could compute a
 * stable hash for the release PK.
 *
 * @task T9756
 * @internal
 */
function resolveProjectRootForHash(cwd?: string): string {
  try {
    return getProjectRoot(cwd);
  } catch {
    return cwd ?? process.cwd(); // CWD-OK: hash-input fallback when getProjectRoot rejects (tests / cleo init bootstrap)
  }
}

/** Task record shape needed for release operations. */
export interface ReleaseTaskRecord {
  id: string;
  title: string;
  status: string;
  parentId?: string;
  completedAt?: string | null;
  labels?: string[];
  /** Structured task type — 'epic' | 'task' | 'subtask'. Used for changelog filtering and categorization. */
  type?: string;
  /** Task description. Used to enrich changelog entries when meaningfully different from the title. */
  description?: string;
}

// ── Internal helpers ─────────────────────────────────────────────────

function isValidVersion(version: string): boolean {
  return /^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version);
}

function validateCalVerWindow(
  version: string,
  now = new Date(),
): { valid: boolean; message: string } {
  const normalized = version.startsWith('v') ? version.slice(1) : version;
  const base = normalized.split('-')[0] ?? normalized;
  const parts = base.split('.');

  if (parts.length !== 3) {
    return { valid: false, message: `Invalid CalVer format: ${version}` };
  }

  const tagYear = Number.parseInt(parts[0] ?? '', 10);
  const tagMonth = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(tagYear) || !Number.isInteger(tagMonth)) {
    return { valid: false, message: `Invalid CalVer date components: ${version}` };
  }

  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
  const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;

  const isPreRelease = normalized.includes('-');
  if (isPreRelease) {
    const valid =
      (tagYear === currentYear || tagYear === nextYear) &&
      (tagMonth === currentMonth || tagMonth === nextMonth);
    return {
      valid,
      message: valid
        ? `CalVer OK (pre-release): ${version}`
        : `Pre-release ${version} outside allowed CalVer range ${currentYear}.${currentMonth} or ${nextYear}.${nextMonth}`,
    };
  }

  const valid = tagYear === currentYear && tagMonth === currentMonth;
  return {
    valid,
    message: valid
      ? `CalVer OK (stable): ${version}`
      : `${version} does not match current CalVer ${currentYear}.${currentMonth}`,
  };
}

function normalizeVersion(version: string): string {
  return version.startsWith('v') ? version : `v${version}`;
}

/**
 * Project a unified `releases` row down to the {@link ReleaseManifest}
 * shape consumed by CLI surfaces. After T9686-B2 the `releases` table
 * carries both new-pipeline and legacy-pipeline columns.
 *
 * Provenance discriminator (T9756): every row now uses the uniform
 * `<projectHash>:<version>` PK shape, so the previous `legacy:`-prefix
 * heuristic has been replaced by a column-level check — legacy-migrated
 * rows have a populated `tasksJson` column (the legacy schema declared it
 * `NOT NULL DEFAULT '[]'`), while new-pipeline rows leave it NULL because
 * per-task changes live in {@link schema.releaseChanges}.
 *
 * Field-mapping notes:
 * - `tasks` — parsed from `tasksJson` for legacy-migrated rows. New-pipeline
 *   rows leave `tasksJson` NULL because the per-task list lives in
 *   {@link schema.releaseChanges}; callers that need it should query that
 *   table separately. List endpoints report 0 for new-pipeline rows until
 *   `release_changes` is populated by reconcile.
 * - `commitSha` — sourced from the unified `merge_commit_sha` column for
 *   both pipelines.
 * - `pushedAt` — for legacy rows, sourced from `pushed_at`; for new-pipeline
 *   rows we fall back to `publishedAt` so callers that sort by "ship time"
 *   don't have to special-case the row source.
 *
 * @task T9686
 * @task T9756 (uniform PK shape)
 * @internal
 */
function releasesRowToManifest(row: schema.ReleaseRow): ReleaseManifest {
  // T9756: `tasksJson` is the post-uniform-PK provenance discriminator. The
  // legacy `release_manifests` schema declared `tasks_json NOT NULL DEFAULT
  // '[]'`, so every legacy-migrated row has a non-null value here; new-
  // pipeline rows always leave it NULL.
  const source: 'new' | 'legacy' = row.tasksJson === null ? 'new' : 'legacy';
  let tasks: string[] = [];
  if (row.tasksJson) {
    try {
      const parsed = JSON.parse(row.tasksJson) as unknown;
      if (Array.isArray(parsed)) tasks = parsed as string[];
    } catch {
      // malformed JSON — leave tasks empty, don't fail the read
    }
  }

  const manifest: ReleaseManifest = {
    version: row.version,
    status: row.status as ReleaseManifestStatus,
    createdAt: row.createdAt,
    tasks,
    source,
  };
  if (row.preparedAt) manifest.preparedAt = row.preparedAt;
  if (row.committedAt) manifest.committedAt = row.committedAt;
  if (row.taggedAt) manifest.taggedAt = row.taggedAt;
  // For new-pipeline rows, expose publishedAt as pushedAt so callers that
  // sort by "ship time" don't have to special-case the row source.
  const effectivePushedAt = row.pushedAt ?? row.publishedAt;
  if (effectivePushedAt) manifest.pushedAt = effectivePushedAt;
  if (row.notes) manifest.notes = row.notes;
  if (row.changelog) manifest.changelog = row.changelog;
  if (row.previousVersion) manifest.previousVersion = row.previousVersion;
  if (row.mergeCommitSha) manifest.commitSha = row.mergeCommitSha;
  if (row.gitTag) manifest.gitTag = row.gitTag;
  return manifest;
}

interface LatestPushedVersion {
  version: string;
  pushedAt: string | null;
}

async function findLatestPushedVersion(cwd?: string): Promise<LatestPushedVersion | undefined> {
  const db = await getDb(cwd);
  const rows = await db
    .select({
      version: schema.releases.version,
      pushedAt: schema.releases.pushedAt,
    })
    .from(schema.releases)
    .where(eq(schema.releases.status, 'pushed'))
    .orderBy(desc(schema.releases.pushedAt))
    .limit(1)
    .all();
  return rows[0];
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Prepare a release (create a release manifest entry).
 * @task T4788
 */
export async function prepareRelease(
  version: string,
  tasks: string[] | undefined,
  notes: string | undefined,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
): Promise<{
  version: string;
  status: string;
  tasks: string[];
  taskCount: number;
}> {
  if (!version) {
    throw new Error('version is required');
  }
  if (!isValidVersion(version)) {
    throw new Error(`Invalid version format: ${version} (expected X.Y.Z or YYYY.M.patch)`);
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);

  const existing = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (existing.length > 0) {
    throw new Error(`Release ${normalizedVersion} already exists (status: ${existing[0]!.status})`);
  }

  const previousVersion = await findLatestPushedVersion(cwd);

  let releaseTasks = tasks ?? [];
  if (releaseTasks.length === 0) {
    const allTasks = await loadTasksFn();
    const cutoff = previousVersion?.pushedAt ?? null;
    releaseTasks = allTasks
      .filter(
        (t) => t.status === 'done' && t.completedAt && (cutoff === null || t.completedAt > cutoff),
      )
      .map((t) => t.id);
  }

  // Filter out epic IDs
  const allTasks = await loadTasksFn();
  const epicIds = new Set(
    allTasks.filter((t) => allTasks.some((c) => c.parentId === t.id)).map((t) => t.id),
  );
  releaseTasks = releaseTasks.filter((id) => !epicIds.has(id));
  const now = new Date().toISOString();
  // T9756: write the uniform `<projectHash>:<version>` PK shape. `tasksJson`
  // is the non-PK provenance discriminator (see `releasesRowToManifest`) —
  // legacy-prepare rows are still distinguishable from new-pipeline rows
  // because they populate `tasksJson` and `preparedAt`. Mirrors the
  // tolerant resolution `resolveCanonicalCleoDir` uses so tests/init paths that
  // don't yet satisfy `getProjectRoot`'s strict `.cleo + .git` predicate
  // can still derive a stable hash from cwd.
  const projectHash = generateProjectHash(resolveProjectRootForHash(cwd));
  const id = `${projectHash}:${normalizedVersion}`;

  await db
    .insert(schema.releases)
    .values({
      id,
      version: normalizedVersion,
      status: 'prepared',
      tasksJson: JSON.stringify(releaseTasks),
      notes: notes ?? null,
      previousVersion: previousVersion?.version ?? null,
      createdAt: now,
      preparedAt: now,
      projectHash,
    })
    .run();

  return {
    version: normalizedVersion,
    status: 'prepared',
    tasks: releaseTasks,
    taskCount: releaseTasks.length,
  };
}

// T9784-A (#414): `generateReleaseChangelog` was deleted alongside the
// legacy `release.changelog` engine-op + the `cleo release changelog` verb.
// The canonical write surface is `cleo changeset add` (T9793); the
// canonical aggregator is `aggregateChangesetsForRelease` in
// `release/changesets-aggregator.ts`.

/**
 * List all releases from the canonical `releases` table (T9686-B2 unified).
 *
 * Reads directly from the unified `releases` table — no view, no UNION,
 * single source of truth. New-pipeline rows and legacy-migrated rows are
 * returned in the same shape; the `source` discriminator is derived from
 * the row's `id` prefix (`legacy:` vs `<projectHash>:`).
 *
 * @task T4788
 * @task T9686
 */
export async function listReleases(
  optionsOrCwd?: ReleaseListOptions | string,
  cwd?: string,
): Promise<{
  releases: Array<{
    version: string;
    status: string;
    createdAt: string;
    taskCount: number;
    source?: 'new' | 'legacy';
  }>;
  total: number;
  filtered: number;
  latest?: string;
  page: ReturnType<typeof createPage>;
}> {
  const options =
    typeof optionsOrCwd === 'string' || optionsOrCwd === undefined ? {} : optionsOrCwd;
  const effectiveCwd = typeof optionsOrCwd === 'string' ? optionsOrCwd : cwd;
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const pageLimit = effectivePageLimit(limit, offset);

  const db = await getDb(effectiveCwd);

  const totalRow = await db.select({ n: count() }).from(schema.releases).get();
  const total = totalRow?.n ?? 0;

  const conditions = options.status
    ? [
        eq(
          schema.releases.status,
          options.status as ReleaseManifestStatus & schema.ReleaseRow['status'],
        ),
      ]
    : [];
  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const filteredRow = await db
    .select({ n: count() })
    .from(schema.releases)
    .where(whereClause)
    .get();
  const filtered = filteredRow?.n ?? 0;

  let query = db
    .select()
    .from(schema.releases)
    .where(whereClause)
    .orderBy(desc(schema.releases.createdAt));

  if (pageLimit !== undefined) {
    query = query.limit(pageLimit) as typeof query;
  }
  if (offset !== undefined) {
    query = query.offset(offset) as typeof query;
  }

  const rows = await query.all();
  const latest = await findLatestPushedVersion(effectiveCwd);

  return {
    releases: rows.map((row) => {
      const manifest = releasesRowToManifest(row);
      return {
        version: manifest.version,
        status: manifest.status,
        createdAt: manifest.createdAt,
        taskCount: manifest.tasks.length,
        ...(manifest.source ? { source: manifest.source } : {}),
      };
    }),
    total,
    filtered,
    latest: latest?.version,
    page: createPage({ total: filtered, limit: pageLimit, offset }),
  };
}

/**
 * Show release details from the canonical `releases` table (T9686-B2 unified).
 *
 * Single-table read, no view. Surfaces both new-pipeline rows (`status` in
 * planned/pr-opened/pr-merged/published/reconciled) and legacy-migrated
 * rows (`status` in prepared/committed/tagged/pushed/rolled_back). Throws
 * when the version is not present in the unified table.
 *
 * @task T4788
 * @task T9686
 */
export async function showRelease(version: string, cwd?: string): Promise<ReleaseManifest> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  const row = rows[0];
  if (!row) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }
  return releasesRowToManifest(row);
}

/**
 * Mark release as committed (metadata only).
 * @task T4788
 */
export async function commitRelease(
  version: string,
  cwd?: string,
): Promise<{ version: string; status: string; committedAt: string }> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  if (rows[0]!.status !== 'prepared') {
    throw new Error(
      `Release ${normalizedVersion} is in state '${rows[0]!.status}', expected 'prepared'`,
    );
  }

  const committedAt = new Date().toISOString();
  await db
    .update(schema.releases)
    .set({ status: 'committed', committedAt })
    .where(eq(schema.releases.version, normalizedVersion))
    .run();

  return { version: normalizedVersion, status: 'committed', committedAt };
}

/**
 * Mark release as tagged (metadata only).
 * @task T4788
 */
export async function tagRelease(
  version: string,
  cwd?: string,
): Promise<{ version: string; status: string; taggedAt: string }> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const taggedAt = new Date().toISOString();
  await db
    .update(schema.releases)
    .set({ status: 'tagged', taggedAt })
    .where(eq(schema.releases.version, normalizedVersion))
    .run();

  return { version: normalizedVersion, status: 'tagged', taggedAt };
}

/**
 * Run release validation gates.
 * @task T4788
 * @task T5586
 */
export async function runReleaseGates(
  version: string,
  loadTasksFn: () => Promise<ReleaseTaskRecord[]>,
  cwd?: string,
  opts?: { dryRun?: boolean },
): Promise<{
  version: string;
  allPassed: boolean;
  gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }>;
  passedCount: number;
  failedCount: number;
  metadata: ReleaseGateMetadata;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const row = rows[0]!;
  const releaseTasks: string[] = JSON.parse(row.tasksJson ?? '[]');

  const gates: Array<{ name: string; status: 'passed' | 'failed'; message: string }> = [];

  gates.push({
    name: 'version_valid',
    status: isValidVersion(normalizedVersion) ? 'passed' : 'failed',
    message: isValidVersion(normalizedVersion)
      ? 'Version format is valid'
      : 'Invalid version format',
  });

  const releaseConfig = loadReleaseConfig(cwd);
  if (releaseConfig.versioningScheme === 'calver') {
    const calver = validateCalVerWindow(normalizedVersion);
    gates.push({
      name: 'calver_window',
      status: calver.valid ? 'passed' : 'failed',
      message: calver.message,
    });
  }

  gates.push({
    name: 'has_tasks',
    status: releaseTasks.length > 0 ? 'passed' : 'failed',
    message:
      releaseTasks.length > 0 ? `${releaseTasks.length} tasks included` : 'No tasks in release',
  });

  gates.push({
    name: 'has_changelog',
    status: row.changelog ? 'passed' : 'failed',
    message: row.changelog
      ? 'Changelog generated'
      : 'No changelog generated. Run release.changelog first.',
  });

  const allTasks = await loadTasksFn();
  const incompleteTasks = releaseTasks.filter((id) => {
    const task = allTasks.find((t) => t.id === id);
    return task && task.status !== 'done';
  });

  gates.push({
    name: 'tasks_complete',
    status: incompleteTasks.length === 0 ? 'passed' : 'failed',
    message:
      incompleteTasks.length === 0
        ? 'All tasks completed'
        : `${incompleteTasks.length} tasks not completed: ${incompleteTasks.join(', ')}`,
  });

  // G2: Build artifact — dist/ must exist (Node projects only)
  // Project-agnostic: reads buildArtifactPaths from release-config.json if present,
  // otherwise falls back to common conventions (dist/, build/, out/).
  // The old monorepo-specific `packages/cleo/dist/cli/index.js` path is no longer
  // hardcoded — it is only checked if the project provides no buildArtifactPaths config.
  const projectRoot = cwd ?? getProjectRoot();
  const isNodeProject = existsSync(join(projectRoot, 'package.json'));
  if (isNodeProject && !releaseConfig.skipBuildArtifactGate) {
    // Read project-configured build artifact paths from release-config.json
    const configuredArtifactPaths = releaseConfig.buildArtifactPaths ?? [];
    const defaultArtifactPaths = [
      join(projectRoot, 'dist'),
      join(projectRoot, 'build'),
      join(projectRoot, 'out'),
    ];
    const checkPaths =
      configuredArtifactPaths.length > 0
        ? configuredArtifactPaths.map((p: string) => join(projectRoot, p))
        : defaultArtifactPaths;
    const distExists = checkPaths.some((p: string) => existsSync(p));
    gates.push({
      name: 'build_artifact',
      status: distExists ? 'passed' : 'failed',
      message: distExists
        ? 'Build artifacts present'
        : `Build artifacts not found — run your build command. Checked: ${checkPaths.map((p: string) => p.replace(projectRoot + '/', '')).join(', ')}`,
    });
  } else if (isNodeProject && releaseConfig.skipBuildArtifactGate) {
    gates.push({
      name: 'build_artifact',
      status: 'passed',
      message: 'Build artifact gate skipped (skipBuildArtifactGate=true in release-config.json)',
    });
  }

  // GD1: Clean working tree (CHANGELOG.md and version bump targets are allowed to be dirty)
  // Skipped in dry-run mode — dry-run makes no commits so tree cleanliness is irrelevant.
  // Untracked files (?? lines) are excluded from the dirty check — they do not affect git
  // commit/tag operations and must not block releases.
  if (opts?.dryRun) {
    gates.push({
      name: 'clean_working_tree',
      status: 'passed',
      message: 'Skipped in dry-run mode',
    });
  } else {
    // Dynamically build exclusion set from configured + workspace-auto-discovered
    // version bump targets plus CHANGELOG.md. Using resolveVersionBumpTargets
    // here (rather than getVersionBumpConfig) means auto-discovered package.json
    // and Cargo.toml files are recognised as expected-dirty after step 0's bump.
    const { targets: bumpTargets } = resolveVersionBumpTargets(cwd);
    const allowedDirty = new Set(['CHANGELOG.md', ...bumpTargets.map((t) => t.file)]);
    let workingTreeClean = true;
    let dirtyFiles: string[] = [];
    try {
      const porcelain = execFileSync('git', ['status', '--porcelain'], {
        cwd: projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      dirtyFiles = porcelain
        .split('\n')
        .filter((l) => l.trim())
        // Exclude untracked files (?? prefix) — they don't affect commits or tags
        .filter((l) => !l.startsWith('?? '))
        .map((l) => l.slice(3).trim())
        .filter((f) => !allowedDirty.has(f));
      workingTreeClean = dirtyFiles.length === 0;
    } catch {
      /* git not available — skip */
    }
    const excludeList = [...allowedDirty].join(', ');
    gates.push({
      name: 'clean_working_tree',
      status: workingTreeClean ? 'passed' : 'failed',
      message: workingTreeClean
        ? `Working tree clean (excluding ${excludeList})`
        : `Uncommitted changes in: ${dirtyFiles.slice(0, 5).join(', ')}${dirtyFiles.length > 5 ? ` (+${dirtyFiles.length - 5} more)` : ''}`,
    });
  }

  // GD2: Branch target — use GitFlow config if available, else defaults
  const isPreRelease = normalizedVersion.includes('-');
  let currentBranch = '';
  try {
    currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    /* git not available — skip */
  }

  const gitFlowCfg = getGitFlowConfig(releaseConfig);
  const channelCfg = getChannelConfig(releaseConfig);

  const expectedBranch = isPreRelease ? gitFlowCfg.branches.develop : gitFlowCfg.branches.main;

  const isFeatureBranch =
    currentBranch.startsWith(gitFlowCfg.branches.featurePrefix) ||
    currentBranch.startsWith(gitFlowCfg.branches.hotfixPrefix) ||
    currentBranch.startsWith(gitFlowCfg.branches.releasePrefix);

  const branchOk =
    !currentBranch || // git unavailable → pass
    currentBranch === 'HEAD' || // detached HEAD → pass
    currentBranch === expectedBranch || // exactly right branch → pass
    (isPreRelease && isFeatureBranch); // feature/hotfix/release branch with pre-release → pass

  // Resolve channel from current branch
  const detectedChannel: ReleaseChannel = currentBranch
    ? resolveChannelFromBranch(currentBranch, channelCfg)
    : isPreRelease
      ? 'beta'
      : 'latest';

  gates.push({
    name: 'branch_target',
    status: branchOk ? 'passed' : 'failed',
    message: branchOk
      ? `On correct branch: ${currentBranch} (channel: ${detectedChannel})`
      : `Expected branch '${expectedBranch}' for ${isPreRelease ? 'pre-release' : 'stable'} release, but on '${currentBranch}'`,
  });

  // GD3: Branch protection — detect if push requires a PR (informational, never fails)
  const pushMode = getPushMode(releaseConfig);
  let requiresPR = false;
  if (pushMode === 'pr') {
    requiresPR = true;
  } else if (pushMode === 'auto') {
    try {
      const protectionResult: BranchProtectionResult = await detectBranchProtection(
        expectedBranch,
        'origin',
        projectRoot,
      );
      requiresPR = protectionResult.protected;
    } catch {
      // Branch protection detection is best-effort; never block release
      requiresPR = false;
    }
  }
  gates.push({
    name: 'branch_protection',
    status: 'passed',
    message: requiresPR
      ? `Branch '${expectedBranch}' is protected — release-prepare workflow will create a PR`
      : `Branch '${expectedBranch}' allows direct push`,
  });

  const allPassed = gates.every((g) => g.status === 'passed');

  const metadata: ReleaseGateMetadata = {
    channel: detectedChannel,
    requiresPR,
    targetBranch: expectedBranch,
    currentBranch,
  };

  return {
    version: normalizedVersion,
    allPassed,
    gates,
    passedCount: gates.filter((g) => g.status === 'passed').length,
    failedCount: gates.filter((g) => g.status === 'failed').length,
    metadata,
  };
}

/**
 * Cancel and remove a release in draft or prepared state.
 * Only releases that have not yet been committed to git can be cancelled.
 * For committed/tagged/pushed releases, use rollbackRelease() instead.
 *
 * @task T5602
 */
export async function cancelRelease(
  version: string,
  projectRoot?: string,
): Promise<{ success: boolean; message: string; version: string }> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(projectRoot);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    return {
      success: false,
      message: `Release ${normalizedVersion} not found`,
      version: normalizedVersion,
    };
  }

  const status = rows[0]!.status;
  const cancellableStates = ['draft', 'prepared'] as const;

  if (!(cancellableStates as readonly string[]).includes(status)) {
    return {
      success: false,
      message: `Cannot cancel a release in '${status}' state. Use 'release rollback' instead.`,
      version: normalizedVersion,
    };
  }

  await db.delete(schema.releases).where(eq(schema.releases.version, normalizedVersion)).run();

  return {
    success: true,
    message: `Release ${normalizedVersion} cancelled and removed`,
    version: normalizedVersion,
  };
}

/**
 * Rollback a release.
 * @task T4788
 */
export async function rollbackRelease(
  version: string,
  reason?: string,
  cwd?: string,
): Promise<{
  version: string;
  previousStatus: string;
  status: string;
  reason: string;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    throw new Error(`Release ${normalizedVersion} not found`);
  }

  const previousStatus = rows[0]!.status;
  await db
    .update(schema.releases)
    .set({ status: 'rolled_back' })
    .where(eq(schema.releases.version, normalizedVersion))
    .run();

  return {
    version: normalizedVersion,
    previousStatus,
    status: 'rolled_back',
    reason: reason ?? 'No reason provided',
  };
}

/**
 * Metadata captured during gate evaluation, returned alongside gate results.
 * Downstream (engine layer) uses this to determine PR vs direct push.
 */
export interface ReleaseGateMetadata {
  /** npm dist-tag channel resolved from the current branch. */
  channel: ReleaseChannel;
  /** Whether the target branch requires a PR (branch protection detected or mode='pr'). */
  requiresPR: boolean;
  /** Branch that should be targeted for this release type. */
  targetBranch: string;
  /** Branch the repo is currently on. */
  currentBranch: string;
}

/** Push policy configuration from config.release.push. */
export interface PushPolicy {
  enabled?: boolean;
  remote?: string;
  requireCleanTree?: boolean;
  allowedBranches?: string[];
  /** Push mode override: 'direct' | 'pr' | 'auto' (default: 'direct'). */
  mode?: PushMode;
  /** Override PR target branch (default: auto-detected from GitFlow config). */
  prBase?: string;
}

/**
 * Read push policy from project config.
 * Returns undefined if no push config exists.
 */
async function readPushPolicy(cwd?: string): Promise<PushPolicy | undefined> {
  const configPath = join(resolveCanonicalCleoDir(resolveProjectByCwd(cwd)), 'config.json');
  let config: Record<string, unknown> | undefined;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!config) return undefined;
  const release = config.release as Record<string, unknown> | undefined;
  if (!release) return undefined;
  return release.push as PushPolicy | undefined;
}

/**
 * Push release to remote via git.
 *
 * Respects config.release.push policy:
 * - remote: override default remote (fallback to 'origin')
 * - requireCleanTree: verify git working tree is clean before push
 * - allowedBranches: verify current branch is in the allowed list
 * - enabled: if false and no explicit push flag, caller should skip
 *
 * @task T4788
 * @task T4276
 */
export async function pushRelease(
  version: string,
  remote?: string,
  cwd?: string,
  opts?: {
    explicitPush?: boolean;
    mode?: PushMode;
    prBase?: string;
    epicId?: string;
    guided?: boolean;
  },
): Promise<{
  version: string;
  status: string;
  remote: string;
  pushedAt: string;
  requiresPR?: boolean;
}> {
  if (!version) {
    throw new Error('version is required');
  }

  const normalizedVersion = normalizeVersion(version);
  const projectRoot = getProjectRoot(cwd);
  const pushPolicy = await readPushPolicy(cwd);

  // Resolve effective push mode: opts.mode > pushPolicy.mode > config > 'direct'
  const configPushMode = getPushMode(loadReleaseConfig(cwd));
  const effectivePushMode: PushMode = opts?.mode ?? pushPolicy?.mode ?? configPushMode;

  // If branch protection detected and mode allows PR creation, signal PR required
  if (effectivePushMode === 'pr' || effectivePushMode === 'auto') {
    const targetRemoteForCheck = remote ?? pushPolicy?.remote ?? 'origin';
    let branchIsProtected = effectivePushMode === 'pr'; // 'pr' always requires PR
    if (effectivePushMode === 'auto') {
      try {
        const protection = await detectBranchProtection(
          pushPolicy?.allowedBranches?.[0] ?? 'main',
          targetRemoteForCheck,
          projectRoot,
        );
        branchIsProtected = protection.protected;
      } catch {
        // Best-effort; default to direct push if detection fails
        branchIsProtected = false;
      }
    }
    if (branchIsProtected) {
      return {
        version: normalizedVersion,
        status: 'requires_pr',
        remote: targetRemoteForCheck,
        pushedAt: new Date().toISOString(),
        requiresPR: true,
      };
    }
  }

  // If push policy says disabled and caller didn't explicitly pass --push, skip
  if (pushPolicy && pushPolicy.enabled === false && !opts?.explicitPush) {
    throw new Error(
      'Push is disabled by config (release.push.enabled=false). Use --push to override.',
    );
  }

  // Determine remote: explicit param > config > 'origin'
  const targetRemote = remote ?? pushPolicy?.remote ?? 'origin';

  // Check requireCleanTree
  // Untracked files (?? lines) are excluded — they do not affect push operations.
  if (pushPolicy?.requireCleanTree) {
    const statusOutput = execFileSync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const trackedDirty = statusOutput
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('?? '))
      .join('\n');
    if (trackedDirty.trim().length > 0) {
      throw new Error(
        'Git working tree is not clean. Commit or stash changes before pushing (config: release.push.requireCleanTree=true).',
      );
    }
  }

  // Check allowedBranches
  if (pushPolicy?.allowedBranches && pushPolicy.allowedBranches.length > 0) {
    const currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: projectRoot,
      timeout: 10000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (!pushPolicy.allowedBranches.includes(currentBranch)) {
      throw new Error(
        `Current branch '${currentBranch}' is not in allowed branches: ${pushPolicy.allowedBranches.join(', ')} (config: release.push.allowedBranches).`,
      );
    }
  }

  execFileSync('git', ['push', targetRemote, '--follow-tags'], {
    cwd: projectRoot,
    timeout: 60000,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return {
    version: normalizedVersion,
    status: 'pushed',
    remote: targetRemote,
    pushedAt: new Date().toISOString(),
  };
}

/**
 * Update release status after push, with optional provenance fields.
 * @task T4788
 * @task T5580
 */
export async function markReleasePushed(
  version: string,
  pushedAt: string,
  cwd?: string,
  provenance?: { commitSha?: string; gitTag?: string },
): Promise<void> {
  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);
  await db
    .update(schema.releases)
    .set({
      status: 'pushed',
      pushedAt,
      ...(provenance?.commitSha != null ? { commitSha: provenance.commitSha } : {}),
      ...(provenance?.gitTag != null ? { gitTag: provenance.gitTag } : {}),
    })
    .where(eq(schema.releases.version, normalizedVersion))
    .run();
}

/**
 * Mark a release as shipped (pushed) and write task→commit provenance rows
 * into `task_commits` unconditionally.
 *
 * Post-retirement semantics (SPEC-T9345 §12.2 · T9541):
 *   - The `CLEO_PROVENANCE_DUAL_WRITE` env var is retired — new-table writes
 *     are now unconditional. The legacy `release_manifests` row is preserved
 *     (F12 backward-compat per ADR-073).
 *   - Every task ID in `release_manifests.tasksJson` gets a corresponding row
 *     in `task_commits` using the provided `commitSha`,
 *     `link_kind='implements'` and `link_source='manual'`.
 *   - On the first invocation per project after the upgrade, a sentinel flag
 *     and audit log entry are written to record retirement (best-effort).
 *
 * @param version     - Release version string (e.g. `v2026.6.0`).
 * @param pushedAt    - ISO-8601 timestamp of the push event.
 * @param cwd         - Optional project root override.
 * @param provenance  - Optional commit SHA and git tag.
 * @returns           Promise resolving to the number of `task_commits` rows inserted.
 *
 * @task T9510
 * @task T9541
 * @see SPEC-T9345 §8.3
 * @see SPEC-T9345 §12.2
 */
export async function markReleaseShipped(
  version: string,
  pushedAt: string,
  cwd?: string,
  provenance?: { commitSha?: string; gitTag?: string },
): Promise<{ taskCommitsInserted: number }> {
  // Record retirement audit signal on first post-upgrade run (idempotent).
  recordDualWriteRetirementOnce(cwd ?? getProjectRoot(), version);

  // Step 1: legacy write (F12 — release_manifests is never removed).
  await markReleasePushed(version, pushedAt, cwd, provenance);

  // Step 2: provenance write — infer task→commit links from tasksJson.
  const commitSha = provenance?.commitSha;
  if (!commitSha) {
    // Without a concrete commit SHA we cannot write valid FK rows.
    return { taskCommitsInserted: 0 };
  }

  const normalizedVersion = normalizeVersion(version);
  const db = await getDb(cwd);

  // Read the manifest row to get the task list.
  const rows = await db
    .select({ tasksJson: schema.releases.tasksJson })
    .from(schema.releases)
    .where(eq(schema.releases.version, normalizedVersion))
    .limit(1)
    .all();

  if (rows.length === 0) {
    return { taskCommitsInserted: 0 };
  }

  const taskIds = JSON.parse(rows[0]!.tasksJson ?? '[]') as string[];
  if (taskIds.length === 0) {
    return { taskCommitsInserted: 0 };
  }

  let inserted = 0;
  const now = new Date().toISOString();

  for (const taskId of taskIds) {
    // Best-effort: INSERT OR IGNORE avoids failure when the row already exists
    // (composite PK: task_id, commit_sha, link_kind).
    try {
      await db.run(
        sql`INSERT OR IGNORE INTO task_commits
          (task_id, commit_sha, link_kind, link_source, created_at)
          VALUES
          (${taskId}, ${commitSha}, ${'implements'}, ${'manual'}, ${now})`,
      );
      inserted++;
    } catch {
      // Non-fatal: if task_commits table doesn't exist yet (pre-migration env)
      // or a constraint fires unexpectedly, skip gracefully.
    }
  }

  return { taskCommitsInserted: inserted };
}

/**
 * One-time migration: read .cleo/releases.json and insert each release into
 * the release_manifests table. Renames the file to releases.json.migrated on success.
 *
 * @task T5580
 */
export async function migrateReleasesJsonToSqlite(
  projectRoot?: string,
): Promise<{ migrated: number }> {
  const releasesPath = join(
    resolveCanonicalCleoDir(resolveProjectByCwd(projectRoot)),
    'releases.json',
  );

  if (!existsSync(releasesPath)) {
    return { migrated: 0 };
  }

  interface LegacyReleasesIndex {
    releases: Array<{
      version: string;
      status: string;
      createdAt: string;
      preparedAt?: string;
      committedAt?: string;
      taggedAt?: string;
      pushedAt?: string;
      tasks: string[];
      notes?: string;
      changelog?: string;
      previousVersion?: string;
    }>;
    latest?: string;
  }

  let raw: LegacyReleasesIndex | undefined;
  try {
    const contents = await readFile(releasesPath, 'utf-8');
    raw = JSON.parse(contents) as LegacyReleasesIndex;
  } catch {
    return { migrated: 0 };
  }
  if (!raw || !Array.isArray(raw.releases)) {
    return { migrated: 0 };
  }

  const db = await getDb(projectRoot);
  let migrated = 0;

  for (const r of raw.releases) {
    // Skip if already exists by version
    const existing = await db
      .select({ id: schema.releases.id })
      .from(schema.releases)
      .where(eq(schema.releases.version, r.version))
      .limit(1)
      .all();

    if (existing.length > 0) continue;

    // T9756: emit the uniform `<projectHash>:<version>` PK shape. The
    // populated `tasksJson` column still discriminates these rows as
    // legacy-origin for `releasesRowToManifest`.
    const projectHash = generateProjectHash(resolveProjectRootForHash(projectRoot));
    const id = `${projectHash}:${r.version}`;
    await db
      .insert(schema.releases)
      .values({
        id,
        version: r.version,
        // Trust the legacy file's status string — the widened enum
        // (T9686-B2) admits all legacy values.
        status: r.status as schema.ReleaseRow['status'],
        tasksJson: JSON.stringify(r.tasks ?? []),
        notes: r.notes ?? null,
        changelog: r.changelog ?? null,
        previousVersion: r.previousVersion ?? null,
        createdAt: r.createdAt,
        preparedAt: r.preparedAt ?? null,
        committedAt: r.committedAt ?? null,
        taggedAt: r.taggedAt ?? null,
        pushedAt: r.pushedAt ?? null,
        projectHash,
      })
      .run();

    migrated++;
  }

  // Rename legacy file on success
  renameSync(releasesPath, releasesPath + '.migrated');

  return { migrated };
}
// T11011: migrated
