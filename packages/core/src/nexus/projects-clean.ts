/**
 * NEXUS project registry bulk clean.
 *
 * Filters and purges project_registry rows matching configurable criteria
 * (regex pattern, presets for temp/test paths, health status, index freshness).
 * Respects dry-run mode and supports readline confirmation from the CLI layer.
 *
 * @task T1473
 */

/** Options for {@link cleanProjects}. */
export interface ProjectsCleanOptions {
  /** When true, return match count without deleting anything. */
  dryRun?: boolean;
  /** JS regex string to match against project_path. */
  pattern?: string;
  /** Preset: match paths containing a .temp/ segment. */
  includeTemp?: boolean;
  /** Preset: match paths containing tmp/test/fixture/scratch/sandbox. */
  includeTests?: boolean;
  /** Match rows where health_status is "unhealthy". */
  matchUnhealthy?: boolean;
  /** Match rows where last_indexed IS NULL. */
  matchNeverIndexed?: boolean;
}

/** Result envelope for {@link cleanProjects}. */
export interface ProjectsCleanResult {
  /** Whether the run was dry-run only. */
  dryRun: boolean;
  /** Number of rows that matched the criteria. */
  matched: number;
  /** Number of rows actually purged (0 on dry-run). */
  purged: number;
  /** Number of rows remaining after purge. */
  remaining: number;
  /** Up to 10 sample paths from matched rows. */
  sample: string[];
  /** Total rows in registry before purge. */
  totalCount: number;
}

/** Error thrown when no filter criteria are provided. */
export class NoCriteriaError extends Error {
  readonly code = 'E_NO_CRITERIA';
  constructor() {
    super(
      'No filter criteria provided. Refusing to purge all projects without explicit criteria.\n' +
        'Use at least one of: --pattern <regex>, --include-temp, --include-tests, --unhealthy, --never-indexed',
    );
  }
}

/** Error thrown when the supplied regex pattern is invalid. */
export class InvalidPatternError extends Error {
  readonly code = 'E_INVALID_PATTERN';
  constructor(cause: unknown) {
    super(
      `Invalid --pattern regex: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Bulk purge project_registry rows matching given criteria.
 *
 * Validates criteria, filters all registry rows, and (unless dry-run) deletes
 * the matching rows in a single transaction. Writes an audit log entry on success.
 *
 * The CLI layer is responsible for the readline confirmation prompt — call this
 * only after the user has confirmed (or pass `dryRun: true` for preview).
 *
 * @param opts - Filter options.
 * @returns Clean result with match/purge counts and sample paths.
 * @throws {NoCriteriaError} When no filter criteria are provided.
 * @throws {InvalidPatternError} When the regex pattern is syntactically invalid.
 *
 * @example
 * const result = await cleanProjects({ includeTemp: true, dryRun: true });
 * console.log(result.matched);
 */
export async function cleanProjects(opts: ProjectsCleanOptions = {}): Promise<ProjectsCleanResult> {
  const {
    dryRun = false,
    pattern: patternRaw,
    includeTemp = false,
    includeTests = false,
    matchUnhealthy = false,
    matchNeverIndexed = false,
  } = opts;

  // Require at least one filter criteria
  const hasCriteria =
    patternRaw !== undefined ||
    includeTemp ||
    includeTests ||
    matchUnhealthy ||
    matchNeverIndexed;

  if (!hasCriteria) {
    throw new NoCriteriaError();
  }

  // Validate regex pattern
  let patternRegex: RegExp | null = null;
  if (patternRaw !== undefined) {
    try {
      patternRegex = new RegExp(patternRaw);
    } catch (err) {
      throw new InvalidPatternError(err);
    }
  }

  const TEMP_RE = /(^|\/)\.temp(\/|$)/;
  const TESTS_RE = /(^|\/)(tmp|test|fixture|scratch|sandbox)(\/|$)/;

  function matchesCriteria(
    projectPath: string,
    healthStatus: string,
    lastIndexed: string | null,
  ): boolean {
    if (patternRegex?.test(projectPath)) return true;
    if (includeTemp && TEMP_RE.test(projectPath)) return true;
    if (includeTests && TESTS_RE.test(projectPath)) return true;
    if (matchUnhealthy && healthStatus === 'unhealthy') return true;
    if (matchNeverIndexed && lastIndexed === null) return true;
    return false;
  }

  const { getNexusDb } = await import('@cleocode/core/store/nexus-sqlite' as string);
  const { projectRegistry: regTable, nexusAuditLog: auditTable } = await import(
    '@cleocode/core/store/nexus-schema' as string
  );
  const { inArray } = await import('drizzle-orm');
  const { randomUUID } = await import('node:crypto');
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
  const matchCount = matches.length;
  const samplePaths = matches.slice(0, 10).map((r) => r.projectPath);

  if (matchCount === 0 || dryRun) {
    return {
      dryRun,
      matched: matchCount,
      purged: 0,
      remaining: totalCount,
      sample: samplePaths,
      totalCount,
    };
  }

  const idsToDelete = matches.map((r) => r.projectId);
  await db.delete(regTable).where(inArray(regTable.projectId, idsToDelete));

  const remaining = totalCount - matchCount;

  // Audit log (best-effort)
  try {
    await db.insert(auditTable).values({
      id: randomUUID(),
      action: 'projects.clean',
      domain: 'nexus',
      operation: 'projects.clean',
      success: 1,
      detailsJson: JSON.stringify({
        pattern: patternRaw ?? null,
        presets: { includeTemp, includeTests, matchUnhealthy, matchNeverIndexed },
        count: matchCount,
        sample: samplePaths,
      }),
    });
  } catch {
    // Audit failure is non-fatal
  }

  return {
    dryRun: false,
    matched: matchCount,
    purged: matchCount,
    remaining,
    sample: samplePaths,
    totalCount,
  };
}
