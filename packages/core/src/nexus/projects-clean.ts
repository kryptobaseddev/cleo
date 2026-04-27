/**
 * NEXUS project registry bulk-clean.
 *
 * Purges project_registry rows matching configurable path/status criteria.
 * Supports dry-run mode and returns a summary result.
 *
 * @task T1473
 */

import path from 'node:path';

/** Thrown when no filter criteria are provided to cleanProjects. */
export class NoCriteriaError extends Error {
  /** @override */
  override readonly name = 'NoCriteriaError';

  constructor() {
    super(
      'No filter criteria provided. Refusing to purge all projects without explicit criteria.\n' +
        'Use at least one of: --pattern <regex>, --include-temp, --include-tests, --unhealthy, --never-indexed',
    );
  }
}

/** Thrown when --pattern is not a valid JS regex. */
export class InvalidPatternError extends Error {
  /** @override */
  override readonly name = 'InvalidPatternError';

  constructor(pattern: string, cause: unknown) {
    super(
      `Invalid --pattern regex '${pattern}': ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Options for {@link cleanProjects}. */
export interface CleanProjectsOptions {
  /** When true, perform a dry-run scan only — no deletions. */
  dryRun: boolean;
  /** JS regex pattern matched against project_path. */
  pattern?: string;
  /** Match paths containing a .temp/ segment. */
  includeTemp?: boolean;
  /** Match paths containing tmp/test/fixture/scratch/sandbox segments. */
  includeTests?: boolean;
  /** Match rows where health_status is 'unhealthy'. */
  matchUnhealthy?: boolean;
  /** Match rows where last_indexed IS NULL. */
  matchNeverIndexed?: boolean;
}

/** Result envelope for {@link cleanProjects}. */
export interface CleanProjectsResult {
  /** Whether this was a dry-run (no deletions performed). */
  dryRun: boolean;
  /** Number of rows matching criteria. */
  matched: number;
  /** Number of rows actually deleted (0 when dryRun is true). */
  purged: number;
  /** Rows remaining after deletion. */
  remaining: number;
  /** Sample of matched project paths (first 10). */
  sample: string[];
  /** Total registry rows scanned. */
  totalCount: number;
}

const TEMP_RE = /(^|\/)\.temp(\/|$)/;
const TESTS_RE = /(^|\/)(tmp|test|fixture|scratch|sandbox)(\/|$)/;

/**
 * Bulk-purge project registry rows matching configurable criteria.
 *
 * At least one of `pattern`, `includeTemp`, `includeTests`, `matchUnhealthy`,
 * or `matchNeverIndexed` must be set — otherwise throws {@link NoCriteriaError}.
 * If `pattern` is set but invalid, throws {@link InvalidPatternError}.
 * When `dryRun` is true, performs only a preview scan with no deletions.
 *
 * @param opts - Clean options.
 * @returns Clean result with match count and sample.
 * @throws {NoCriteriaError} When no filter criteria are provided.
 * @throws {InvalidPatternError} When `opts.pattern` is not a valid regex.
 *
 * @example
 * const preview = await cleanProjects({ dryRun: true, includeTemp: true });
 * console.log(preview.matched, 'projects would be purged');
 */
export async function cleanProjects(opts: CleanProjectsOptions): Promise<CleanProjectsResult> {
  const hasCriteria =
    opts.pattern !== undefined ||
    opts.includeTemp ||
    opts.includeTests ||
    opts.matchUnhealthy ||
    opts.matchNeverIndexed;

  if (!hasCriteria) {
    throw new NoCriteriaError();
  }

  let patternRegex: RegExp | null = null;
  if (opts.pattern !== undefined) {
    try {
      patternRegex = new RegExp(opts.pattern);
    } catch (err) {
      throw new InvalidPatternError(opts.pattern, err);
    }
  }

  /**
   * Return true if a project matches any active criteria.
   */
  function matchesCriteria(projectPath: string, healthStatus: string, lastIndexed: string | null): boolean {
    if (patternRegex?.test(projectPath)) return true;
    if (opts.includeTemp && TEMP_RE.test(projectPath)) return true;
    if (opts.includeTests && TESTS_RE.test(projectPath)) return true;
    if (opts.matchUnhealthy && healthStatus === 'unhealthy') return true;
    if (opts.matchNeverIndexed && lastIndexed === null) return true;
    return false;
  }

  const { getNexusDb } = await import('@cleocode/core/store/nexus-sqlite' as string);
  const { projectRegistry: regTable, nexusAuditLog: auditTable } = await import(
    '@cleocode/core/store/nexus-schema' as string
  );
  const { randomUUID } = await import('node:crypto');
  const { inArray } = await import('drizzle-orm');
  const db = await getNexusDb();

  type RegistryRow = {
    projectId: string;
    projectPath: string;
    healthStatus: string;
    lastIndexed: string | null;
  };

  const allRows = (await db
    .select({
      projectId: regTable.projectId,
      projectPath: regTable.projectPath,
      healthStatus: regTable.healthStatus,
      lastIndexed: regTable.lastIndexed,
    })
    .from(regTable)) as RegistryRow[];

  const matches = allRows.filter((row) =>
    matchesCriteria(row.projectPath, row.healthStatus, row.lastIndexed),
  );

  const totalCount = allRows.length;
  const matched = matches.length;
  const sample = matches.slice(0, 10).map((r) => path.resolve(r.projectPath));

  if (opts.dryRun || matched === 0) {
    return {
      dryRun: opts.dryRun,
      matched,
      purged: 0,
      remaining: totalCount,
      sample,
      totalCount,
    };
  }

  // Delete matched rows
  const idsToDelete = matches.map((r) => r.projectId);
  await db.delete(regTable).where(inArray(regTable.projectId, idsToDelete));

  const remaining = totalCount - matched;

  // Audit log (best-effort)
  try {
    await db.insert(auditTable).values({
      id: randomUUID(),
      action: 'projects.clean',
      domain: 'nexus',
      operation: 'projects.clean',
      success: 1,
      detailsJson: JSON.stringify({
        pattern: opts.pattern ?? null,
        presets: {
          includeTemp: opts.includeTemp,
          includeTests: opts.includeTests,
          matchUnhealthy: opts.matchUnhealthy,
          matchNeverIndexed: opts.matchNeverIndexed,
        },
        count: matched,
        sample,
      }),
    });
  } catch {
    // Audit failure is non-fatal
  }

  return {
    dryRun: false,
    matched,
    purged: matched,
    remaining,
    sample,
    totalCount,
  };
}
