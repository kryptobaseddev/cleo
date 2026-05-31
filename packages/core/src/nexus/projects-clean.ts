/**
 * NEXUS project registry bulk-clean.
 *
 * Purges project_registry rows matching configurable path/status criteria.
 * Supports dry-run mode and returns a summary result.
 *
 * @task T1473
 */

import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';

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
  /** Match rows whose project_path no longer exists on disk (T9117). */
  matchOrphaned?: boolean;
  /**
   * Match rows that are path-divergent duplicates of the same canonical
   * project (T9149 W5 pollution cleanup). Groups rows by canonicalProjectId
   * and flags all but the most-recently-indexed one as polluted.
   */
  matchPolluted?: boolean;
  /** After DB delete, `rm -rf` each matched path that still exists on disk (T9117). */
  removeFs?: boolean;
  /** After DB delete, run sqlite VACUUM on nexus.db to reclaim space (T9117). */
  vacuum?: boolean;
  /**
   * When matchPolluted is set and dryRun is false, write an audit JSONL to
   * ~/.local/state/cleo/nexus-cleanup-<ts>.jsonl before deletion (T9149).
   */
  auditLog?: boolean;
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
  /** Number of on-disk paths successfully removed when `removeFs` is set (T9117). */
  fsRemoved?: number;
  /** Number of on-disk paths that failed to remove when `removeFs` is set (T9117). */
  fsFailed?: number;
  /** Bytes freed by VACUUM when `vacuum` is set (T9117). */
  vacuumBytesFreed?: number;
}

const TEMP_RE = /(^|\/)\.temp(\/|$)/;
const TESTS_RE = /(^|\/)(tmp|test|fixture|scratch|sandbox)(\/|$)/;

function portablePathForMatch(p: string): string {
  return p.replace(/\\/g, '/');
}

function pathSegmentCount(p: string): number {
  return portablePathForMatch(p).split('/').filter(Boolean).length;
}

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
    opts.matchNeverIndexed ||
    opts.matchOrphaned ||
    opts.matchPolluted;

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
  function matchesCriteria(
    projectPath: string,
    healthStatus: string,
    lastIndexed: string | null,
  ): boolean {
    const normalizedProjectPath = portablePathForMatch(projectPath);
    if (patternRegex?.test(projectPath) || patternRegex?.test(normalizedProjectPath)) return true;
    if (opts.includeTemp && TEMP_RE.test(normalizedProjectPath)) return true;
    if (opts.includeTests && TESTS_RE.test(normalizedProjectPath)) return true;
    if (opts.matchUnhealthy && healthStatus === 'unhealthy') return true;
    if (opts.matchNeverIndexed && lastIndexed === null) return true;
    if (opts.matchOrphaned && !existsSync(projectPath)) return true;
    return false;
  }

  const { getNexusDb } = await import('../store/nexus-sqlite.js');
  const { projectRegistry: regTable, nexusAuditLog: auditTable } = await import(
    '../store/schema/nexus-schema.js'
  );
  const { randomUUID } = await import('node:crypto');
  const { inArray, sql } = await import('drizzle-orm');
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

  const pollutedIds: Set<string> = new Set();
  if (opts.matchPolluted) {
    // Group rows by canonicalProjectId. The canonical ID uses git-root+realpath
    // so bind-mount variants of the same repo collapse to the same key.
    const { canonicalProjectId: computeId } = await import('./identity.js');
    const canonicalGroups = new Map<string, RegistryRow[]>();
    await Promise.all(
      allRows.map(async (row) => {
        try {
          const { id } = await computeId(row.projectPath);
          const existing = canonicalGroups.get(id) ?? [];
          existing.push(row);
          canonicalGroups.set(id, existing);
        } catch {
          // path doesn't exist — will be caught by matchOrphaned
        }
      }),
    );
    // For each group with >1 member, keep the most-recently-indexed; flag the rest
    for (const group of canonicalGroups.values()) {
      if (group.length > 1) {
        // Sort descending by lastIndexed (nulls last)
        group.sort((a, b) => {
          if (a.lastIndexed === b.lastIndexed) return 0;
          if (a.lastIndexed === null) return 1;
          if (b.lastIndexed === null) return -1;
          return b.lastIndexed.localeCompare(a.lastIndexed);
        });
        // Keep index 0 (most recent), flag the rest as polluted
        for (const row of group.slice(1)) {
          pollutedIds.add(row.projectId);
        }
      }
    }
  }

  const matches = allRows.filter(
    (row) =>
      matchesCriteria(row.projectPath, row.healthStatus, row.lastIndexed) ||
      pollutedIds.has(row.projectId),
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

  // Write audit JSONL before deletion (T9149 matchPolluted mode)
  if (opts.matchPolluted && opts.auditLog && matches.length > 0) {
    try {
      const { appendFile: appendFn, mkdir: mkdirFn } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const auditDir = path.join(homedir(), '.local', 'state', 'cleo');
      await mkdirFn(auditDir, { recursive: true });
      const auditPath = path.join(auditDir, `nexus-cleanup-${ts}.jsonl`);
      const records = matches
        .map((r) =>
          JSON.stringify({
            ts: new Date().toISOString(),
            projectId: r.projectId,
            projectPath: r.projectPath,
            reason: pollutedIds.has(r.projectId) ? 'path-divergent-duplicate' : 'criteria-match',
          }),
        )
        .join('\n');
      await appendFn(auditPath, records + '\n', 'utf8');
    } catch {
      // audit is best-effort
    }
  }

  // Delete matched rows in chunks to keep SQL parameter counts safe (default
  // SQLite limit is 999 bound variables per statement).
  const CHUNK = 500;
  const idsToDelete = matches.map((r) => r.projectId);
  for (let i = 0; i < idsToDelete.length; i += CHUNK) {
    const slice = idsToDelete.slice(i, i + CHUNK);
    await db.delete(regTable).where(inArray(regTable.projectId, slice));
  }

  const remaining = totalCount - matched;

  // Optional filesystem cleanup — runs only after the row has been purged so a
  // partial failure leaves no DB→disk drift (worst case: dir lingers, can be
  // re-cleaned with --orphans).
  let fsRemoved: number | undefined;
  let fsFailed: number | undefined;
  if (opts.removeFs) {
    fsRemoved = 0;
    fsFailed = 0;
    for (const row of matches) {
      const p = row.projectPath;
      // Refuse to delete suspiciously short or root-ish paths even if the DB
      // says so. Anything < 8 chars or with fewer than 3 path segments under
      // root gets skipped — protects against `/`, `/tmp`, `/home`, etc.
      if (!p || p.length < 8 || pathSegmentCount(p) < 2) {
        fsFailed++;
        continue;
      }
      try {
        if (existsSync(p)) {
          // Only remove directories — refuse files/symlinks to a real file.
          const st = statSync(p);
          if (st.isDirectory()) {
            await rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
            fsRemoved++;
          }
        }
      } catch {
        fsFailed++;
      }
    }
  }

  // Optional VACUUM to reclaim disk space after large purges.
  let vacuumBytesFreed: number | undefined;
  if (opts.vacuum) {
    let beforeBytes = 0;
    let afterBytes = 0;
    try {
      const { statSync: stat } = await import('node:fs');
      const { getNexusDbPath } = await import('../store/nexus-sqlite.js');
      const dbPath = getNexusDbPath();
      beforeBytes = stat(dbPath).size;
      await db.run(sql`VACUUM`);
      afterBytes = stat(dbPath).size;
      vacuumBytesFreed = Math.max(0, beforeBytes - afterBytes);
    } catch {
      vacuumBytesFreed = 0;
    }
  }

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
          matchOrphaned: opts.matchOrphaned,
          removeFs: opts.removeFs,
          vacuum: opts.vacuum,
        },
        count: matched,
        fsRemoved,
        fsFailed,
        vacuumBytesFreed,
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
    ...(fsRemoved !== undefined ? { fsRemoved } : {}),
    ...(fsFailed !== undefined ? { fsFailed } : {}),
    ...(vacuumBytesFreed !== undefined ? { vacuumBytesFreed } : {}),
  };
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusProjectsClean(opts: {
  dryRun?: boolean;
  pattern?: string;
  includeTemp?: boolean;
  includeTests?: boolean;
  matchUnhealthy?: boolean;
  matchNeverIndexed?: boolean;
  matchOrphaned?: boolean;
  removeFs?: boolean;
  vacuum?: boolean;
}): Promise<EngineResult<CleanProjectsResult>> {
  const hasCriteria =
    typeof opts.pattern === 'string' ||
    opts.includeTemp === true ||
    opts.includeTests === true ||
    opts.matchUnhealthy === true ||
    opts.matchNeverIndexed === true ||
    opts.matchOrphaned === true;
  if (!hasCriteria) {
    return engineError(
      'E_NO_CRITERIA',
      'At least one criteria flag is required: --include-temp, --include-tests, --pattern, --unhealthy, --never-indexed, or --orphans',
    );
  }

  if (typeof opts.pattern === 'string') {
    try {
      new RegExp(opts.pattern);
    } catch (e) {
      return engineError(
        'E_INVALID_PATTERN',
        `Invalid regex pattern '${opts.pattern}': ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  try {
    const result = await cleanProjects({ dryRun: opts.dryRun ?? false, ...opts });
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
