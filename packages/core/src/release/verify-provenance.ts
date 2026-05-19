/**
 * `cleo provenance verify <version>` — Phase 2 of T9493 (T9529).
 *
 * Audits the 11 provenance tables for a given release tag. Every junction-table
 * row MUST resolve to a real parent row (FK integrity), no orphan rows MAY
 * exist for the release, and ADR-051 evidence atoms recorded at plan time MUST
 * still be reachable from the tag.
 *
 * Design (read-only):
 *
 *   - Loads the release row by `version` from `releasesNew`.
 *   - For each junction table associated with the release (`release_commits`,
 *     `task_commits` for that release's commits, `pr_commits`, `pr_tasks`,
 *     `release_changes`, `release_artifacts`), runs a LEFT JOIN query and
 *     collects rows whose parent is missing.
 *   - For each `evidence_atom` in `<version>.plan.json` of kind `commit:<sha>`,
 *     runs `git merge-base --is-ancestor <sha> <tag>` and records non-zero
 *     exits as "stale".
 *   - Aggregates 8 categories into the `data.categories` envelope, sets
 *     `data.passed = false` iff ANY category failed, and propagates to the
 *     outer LAFS `success` flag.
 *
 * @task T9529
 * @epic T9493
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §4.6
 * @spec .cleo/rcasd/T9345/research/provenance-graph-design.md §11
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getLogger } from '../logger.js';
import { getProjectRoot } from '../paths.js';
import { getDb } from '../store/sqlite.js';

const log = getLogger('release:verify-provenance');

/** Default subprocess timeout for git invocations (60s per task rules). */
const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Plan-file dir relative to project root. */
const PLAN_DIR_REL = '.cleo/release';

/** Plan-archive dir relative to project root. */
const PLAN_ARCHIVE_DIR_REL = '.cleo/release/archive';

/** Default N for `--all` mode when no explicit count is supplied. */
const DEFAULT_ALL_LIMIT = 5;

// ─── Public types ───────────────────────────────────────────────────────────

/**
 * Options for {@link verifyProvenance}.
 *
 * Either `version` MUST be supplied (single-release mode) or `all: true`
 * (most-recent-N mode). When both are supplied, `version` wins.
 */
export interface VerifyProvenanceOptions {
  /** Specific release version string (e.g. `v2026.6.0`). */
  version?: string;
  /** When true, verifies the most-recent `limit` releases. */
  all?: boolean;
  /** Number of releases to verify in `--all` mode (default 5). */
  limit?: number;
  /** Project root override (defaults to CLEO_ROOT or cwd). */
  projectRoot?: string;
}

/** One stale evidence atom — surfaced verbatim to the caller. */
export interface StaleEvidenceAtom {
  /** Task ID whose evidence atom failed reachability. */
  taskId: string;
  /** The atom string as it appeared in `plan.tasks[].evidenceAtoms`. */
  atom: string;
  /** Human-readable explanation (e.g. "commit X not reachable from tag Y"). */
  reason: string;
}

/** Result envelope for ONE release version. */
export interface VerifyProvenanceCategories {
  /** Existence of the `releases` row for `<version>`. */
  releaseExists: { passed: boolean; count: number };
  /** Every `release_commits.commit_sha` resolves to a real `commits.sha`. */
  commitFkIntegrity: { passed: boolean; orphanCount: number; orphans: string[] };
  /** Every `task_commits.task_id` (for this release's commits) resolves. */
  taskCommitFkIntegrity: { passed: boolean; orphanCount: number; orphans: string[] };
  /** Every `pr_commits.commit_sha` (for PRs touching this release) resolves. */
  prCommitFkIntegrity: { passed: boolean; orphanCount: number; orphans: string[] };
  /** Every `pr_tasks.task_id` (for PRs touching this release) resolves. */
  prTaskFkIntegrity: { passed: boolean; orphanCount: number; orphans: string[] };
  /** Every `release_changes` row resolves to a real task OR to NULL. */
  releaseChangesIntegrity: { passed: boolean; orphanCount: number };
  /** Every `release_artifacts` row resolves to a real release. */
  releaseArtifactsIntegrity: { passed: boolean; orphanCount: number };
  /** ADR-051 evidence atoms still reachable from the tag. */
  evidenceStaleness: { passed: boolean; staleAtoms: StaleEvidenceAtom[] };
}

/** Per-release verification verdict. */
export interface VerifyProvenanceReleaseResult {
  /** Release version string. */
  version: string;
  /** True iff every category passed. */
  passed: boolean;
  /** Per-category diagnostic detail. */
  categories: VerifyProvenanceCategories;
}

/** Result envelope for {@link verifyProvenance}. */
export interface VerifyProvenanceResult {
  /** Releases verified (length 1 in single-version mode, N in --all mode). */
  releases: VerifyProvenanceReleaseResult[];
  /** Convenience alias for `releases[0].version` in single-mode. */
  version: string;
  /** True iff EVERY release verified passed every category. */
  passed: boolean;
  /** Aggregated categories for the FIRST release in `releases[]` (single-mode). */
  categories: VerifyProvenanceCategories;
  /** Total wall-clock duration in ms. */
  durationMs?: number;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Locate the plan JSON for `version`. Checks the live plan dir first, falls
 * back to the archive dir. Returns null when not found.
 */
function findPlanFile(version: string, projectRoot: string): string | null {
  const livePath = join(projectRoot, PLAN_DIR_REL, `${version}.plan.json`);
  if (existsSync(livePath)) return livePath;
  const archivePath = join(projectRoot, PLAN_ARCHIVE_DIR_REL, `${version}.plan.json`);
  if (existsSync(archivePath)) return archivePath;
  return null;
}

/** Minimal shape we need from a plan JSON — only `tasks[].evidenceAtoms`. */
interface PlanShape {
  tasks?: ReadonlyArray<{ id?: string; evidenceAtoms?: ReadonlyArray<string> }>;
}

/**
 * Parse the plan JSON for `version` and return the task/evidence shape. Returns
 * null when missing or malformed — caller treats absence as zero atoms to check.
 */
function loadPlanShape(version: string, projectRoot: string): PlanShape | null {
  const path = findPlanFile(version, projectRoot);
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as PlanShape;
  } catch (err) {
    log.warn(
      { path, err: err instanceof Error ? err.message : String(err) },
      'plan JSON unparseable — evidence staleness check skipped',
    );
    return null;
  }
}

/**
 * Check ADR-051 evidence staleness for one release. For every `commit:<sha>`
 * atom in the plan, run `git merge-base --is-ancestor <sha> <tag>` and record
 * non-zero exits as stale. Other atom kinds (note, decision, files, tool,
 * test-run) are skipped here — those are the reconcile-time staleness gate's
 * concern; verify only re-validates the reachability sub-condition.
 */
function checkEvidenceStaleness(
  version: string,
  projectRoot: string,
): VerifyProvenanceCategories['evidenceStaleness'] {
  const plan = loadPlanShape(version, projectRoot);
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return { passed: true, staleAtoms: [] };
  }
  const stale: StaleEvidenceAtom[] = [];
  for (const task of plan.tasks) {
    const taskId = typeof task.id === 'string' ? task.id : '';
    if (!taskId || !Array.isArray(task.evidenceAtoms)) continue;
    for (const atom of task.evidenceAtoms) {
      if (typeof atom !== 'string') continue;
      const colonIdx = atom.indexOf(':');
      if (colonIdx <= 0) continue;
      const kind = atom.slice(0, colonIdx);
      const value = atom.slice(colonIdx + 1);

      if (kind === 'commit') {
        try {
          execFileSync('git', ['merge-base', '--is-ancestor', value, version], {
            cwd: projectRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: SUBPROCESS_TIMEOUT_MS,
          });
        } catch {
          stale.push({
            taskId,
            atom,
            reason: `commit ${value} is not reachable from tag ${version}`,
          });
        }
      } else if (kind === 'files') {
        const paths = value
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean);
        for (const relPath of paths) {
          const abs = resolve(projectRoot, relPath);
          if (!existsSync(abs)) {
            stale.push({
              taskId,
              atom,
              reason: `file ${relPath} missing post-publish`,
            });
          }
        }
      } else if (kind === 'test-run') {
        const abs = resolve(projectRoot, value);
        if (!existsSync(abs)) {
          stale.push({
            taskId,
            atom,
            reason: `test-run file ${value} missing post-publish`,
          });
        }
      }
      // note:, decision:, tool: are not staleness-sensitive.
    }
  }
  return { passed: stale.length === 0, staleAtoms: stale };
}

/**
 * Row shape for the orphan-detection LEFT JOIN result.
 *
 * Each query in {@link verifyOneRelease} projects exactly one TEXT column —
 * the orphan key — so a single typed row interface covers every query.
 */
interface OrphanRow {
  v: string;
}

/**
 * Run a single orphan-detection query and return the orphan key list. Wraps
 * the drizzle `db.all` call so each category emits a strongly-typed row.
 */
async function fetchOrphans(
  db: Awaited<ReturnType<typeof getDb>>,
  query: ReturnType<typeof sql>,
): Promise<string[]> {
  const rows = await db.all<OrphanRow>(query);
  const out: string[] = [];
  for (const r of rows) {
    if (r && typeof r.v === 'string') out.push(r.v);
  }
  return out;
}

/**
 * Run all 8 verification categories for a single release version. Returns a
 * fully-populated {@link VerifyProvenanceReleaseResult}.
 */
async function verifyOneRelease(
  version: string,
  projectRoot: string,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<VerifyProvenanceReleaseResult> {
  // 1. releaseExists — count rows in releases where version=<version>.
  const releaseCountRows = await db.all<{ cnt: number }>(
    sql`SELECT COUNT(*) AS cnt FROM releases WHERE version = ${version}`,
  );
  const releaseCount = releaseCountRows[0]?.cnt ?? 0;
  const releaseExists = { passed: releaseCount > 0, count: releaseCount };

  // Look up the release id once — most downstream queries scope to it.
  const releaseIdRows = await db.all<{ id: string }>(
    sql`SELECT id FROM releases WHERE version = ${version} LIMIT 1`,
  );
  const releaseId = releaseIdRows[0]?.id ?? null;

  // When the release row is missing, every junction-table check is vacuously
  // "passed" (no rows to inspect) but we still mark the overall release as
  // failed because `releaseExists.passed === false`.
  if (releaseId === null) {
    return {
      version,
      passed: false,
      categories: {
        releaseExists,
        commitFkIntegrity: { passed: true, orphanCount: 0, orphans: [] },
        taskCommitFkIntegrity: { passed: true, orphanCount: 0, orphans: [] },
        prCommitFkIntegrity: { passed: true, orphanCount: 0, orphans: [] },
        prTaskFkIntegrity: { passed: true, orphanCount: 0, orphans: [] },
        releaseChangesIntegrity: { passed: true, orphanCount: 0 },
        releaseArtifactsIntegrity: { passed: true, orphanCount: 0 },
        evidenceStaleness: checkEvidenceStaleness(version, projectRoot),
      },
    };
  }

  // 2. commitFkIntegrity — release_commits.commit_sha → commits.sha
  const commitOrphans = await fetchOrphans(
    db,
    sql`SELECT rc.commit_sha AS v
        FROM release_commits rc
        LEFT JOIN commits c ON c.sha = rc.commit_sha
        WHERE rc.release_id = ${releaseId}
          AND c.sha IS NULL`,
  );

  // 3. taskCommitFkIntegrity — task_commits.task_id → tasks.id, scoped to
  //    THIS release's commit set.
  const taskCommitOrphans = await fetchOrphans(
    db,
    sql`SELECT tc.task_id AS v
        FROM task_commits tc
        LEFT JOIN tasks t ON t.id = tc.task_id
        WHERE tc.commit_sha IN (
          SELECT commit_sha FROM release_commits WHERE release_id = ${releaseId}
        )
          AND t.id IS NULL`,
  );

  // 4. prCommitFkIntegrity — pr_commits.commit_sha → commits.sha, scoped to
  //    PRs that intersect this release's commit set.
  const prCommitOrphans = await fetchOrphans(
    db,
    sql`SELECT pc.commit_sha AS v
        FROM pr_commits pc
        LEFT JOIN commits c ON c.sha = pc.commit_sha
        WHERE pc.pr_id IN (
          SELECT DISTINCT pc2.pr_id
          FROM pr_commits pc2
          WHERE pc2.commit_sha IN (
            SELECT commit_sha FROM release_commits WHERE release_id = ${releaseId}
          )
        )
          AND c.sha IS NULL`,
  );

  // 5. prTaskFkIntegrity — pr_tasks.task_id → tasks.id, scoped to PRs that
  //    intersect this release's commit set.
  const prTaskOrphans = await fetchOrphans(
    db,
    sql`SELECT pt.task_id AS v
        FROM pr_tasks pt
        LEFT JOIN tasks t ON t.id = pt.task_id
        WHERE pt.pr_id IN (
          SELECT DISTINCT pc2.pr_id
          FROM pr_commits pc2
          WHERE pc2.commit_sha IN (
            SELECT commit_sha FROM release_commits WHERE release_id = ${releaseId}
          )
        )
          AND t.id IS NULL`,
  );

  // 6. releaseChangesIntegrity — every release_changes row must point at our
  //    release row (no dangling release_changes for this version). A row with
  //    task_id NULL is permitted (per schema comment — orphan task_id is
  //    deliberate when classifying a non-task commit) but a row with a
  //    NON-null task_id pointing at a missing tasks.id IS an orphan.
  const releaseChangesOrphans = await fetchOrphans(
    db,
    sql`SELECT rc.id AS v
        FROM release_changes rc
        LEFT JOIN tasks t ON t.id = rc.task_id
        WHERE rc.release_id = ${releaseId}
          AND rc.task_id IS NOT NULL
          AND t.id IS NULL`,
  );

  // 7. releaseArtifactsIntegrity — release_artifacts.release_id → releases.id
  //    Since FK is ON DELETE CASCADE this should never produce rows; we still
  //    audit defensively in case a row was inserted bypassing the FK (e.g.
  //    direct sqlite3 write).
  const releaseArtifactsOrphans = await fetchOrphans(
    db,
    sql`SELECT ra.identifier AS v
        FROM release_artifacts ra
        LEFT JOIN releases r ON r.id = ra.release_id
        WHERE ra.release_id = ${releaseId}
          AND r.id IS NULL`,
  );

  // 8. evidenceStaleness — re-validate plan evidence atoms.
  const evidenceStaleness = checkEvidenceStaleness(version, projectRoot);

  const categories: VerifyProvenanceCategories = {
    releaseExists,
    commitFkIntegrity: {
      passed: commitOrphans.length === 0,
      orphanCount: commitOrphans.length,
      orphans: commitOrphans,
    },
    taskCommitFkIntegrity: {
      passed: taskCommitOrphans.length === 0,
      orphanCount: taskCommitOrphans.length,
      orphans: taskCommitOrphans,
    },
    prCommitFkIntegrity: {
      passed: prCommitOrphans.length === 0,
      orphanCount: prCommitOrphans.length,
      orphans: prCommitOrphans,
    },
    prTaskFkIntegrity: {
      passed: prTaskOrphans.length === 0,
      orphanCount: prTaskOrphans.length,
      orphans: prTaskOrphans,
    },
    releaseChangesIntegrity: {
      passed: releaseChangesOrphans.length === 0,
      orphanCount: releaseChangesOrphans.length,
    },
    releaseArtifactsIntegrity: {
      passed: releaseArtifactsOrphans.length === 0,
      orphanCount: releaseArtifactsOrphans.length,
    },
    evidenceStaleness,
  };

  const passed =
    categories.releaseExists.passed &&
    categories.commitFkIntegrity.passed &&
    categories.taskCommitFkIntegrity.passed &&
    categories.prCommitFkIntegrity.passed &&
    categories.prTaskFkIntegrity.passed &&
    categories.releaseChangesIntegrity.passed &&
    categories.releaseArtifactsIntegrity.passed &&
    categories.evidenceStaleness.passed;

  return { version, passed, categories };
}

/**
 * Resolve the list of release versions to verify based on
 * {@link VerifyProvenanceOptions}. Returns the most-recent `limit` versions
 * when `all` is set; otherwise returns `[version]` as a single-element array.
 *
 * Sort order in `--all` mode: published_at DESC, falling back to created_at
 * DESC for unpublished rows (which can happen during a partial reconcile).
 */
async function resolveVersions(
  opts: VerifyProvenanceOptions,
  db: Awaited<ReturnType<typeof getDb>>,
): Promise<EngineResult<string[]>> {
  if (opts.version) return engineSuccess([opts.version]);
  if (opts.all !== true) {
    return engineError(
      'E_INVALID_INPUT',
      'verifyProvenance requires either `version` or `all: true`',
      { details: { received: opts } },
    );
  }
  const limit =
    typeof opts.limit === 'number' && opts.limit > 0 ? Math.floor(opts.limit) : DEFAULT_ALL_LIMIT;
  const rows = await db.all<{ version: string }>(
    sql`SELECT version FROM releases
        ORDER BY COALESCE(published_at, reconciled_at, created_at) DESC
        LIMIT ${limit}`,
  );
  const versions: string[] = [];
  for (const r of rows) {
    if (r && typeof r.version === 'string') versions.push(r.version);
  }
  if (versions.length === 0) {
    return engineError(
      'E_PROVENANCE_INCOMPLETE',
      'No releases found in the provenance graph to verify',
      { details: { all: true, limit } },
    );
  }
  return engineSuccess(versions);
}

// ─── Main entrypoint ───────────────────────────────────────────────────────

/**
 * Audit the 11 provenance tables for a given release (or the N most-recent
 * releases when `opts.all` is set). READ-ONLY — does not mutate the DB.
 *
 * Returns `engineSuccess(VerifyProvenanceResult)` with `data.passed === true`
 * when every category passes for every release in scope. Returns
 * `engineError('E_PROVENANCE_INCOMPLETE', ...)` with the same envelope
 * payload available under `error.details.data` when any category fails — the
 * CLI surfaces this via a non-zero exit code per the SPEC.
 *
 * @param opts — See {@link VerifyProvenanceOptions}.
 * @returns EngineResult envelope.
 */
export async function verifyProvenance(
  opts: VerifyProvenanceOptions,
): Promise<EngineResult<VerifyProvenanceResult>> {
  const startedAt = Date.now();
  const projectRoot = getProjectRoot(opts.projectRoot);

  // Sanity-check input — without `version` we require `all: true`.
  if (!opts.version && opts.all !== true) {
    return engineError(
      'E_INVALID_INPUT',
      'verifyProvenance requires either `version` or `all: true`',
      { details: { received: opts } },
    );
  }

  const db = await getDb(projectRoot);

  const versionsRes = await resolveVersions(opts, db);
  if (!versionsRes.success) return versionsRes;
  const versions = versionsRes.data;

  const releases: VerifyProvenanceReleaseResult[] = [];
  for (const v of versions) {
    releases.push(await verifyOneRelease(v, projectRoot, db));
  }

  const passed = releases.every((r) => r.passed);
  const first = releases[0];
  if (!first) {
    return engineError('E_PROVENANCE_INCOMPLETE', 'No releases were verified', {
      details: { versions, opts },
    });
  }

  const result: VerifyProvenanceResult = {
    releases,
    version: first.version,
    passed,
    categories: first.categories,
    durationMs: Date.now() - startedAt,
  };

  if (!passed) {
    return engineError(
      'E_PROVENANCE_INCOMPLETE',
      `Provenance verification failed for ${releases.filter((r) => !r.passed).length}/${releases.length} release(s)`,
      {
        fix: 'Inspect categories[*] for the failing release(s) and re-run `cleo provenance backfill --since <prev>` or `cleo release reconcile <version>` to repair.',
        details: { data: result },
      },
    );
  }

  return engineSuccess(result);
}
