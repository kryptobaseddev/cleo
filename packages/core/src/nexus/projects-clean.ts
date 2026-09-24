/**
 * NEXUS project registry bulk-clean.
 *
 * Purges project_registry rows matching configurable path/status criteria.
 * Supports dry-run mode and returns a summary result.
 *
 * T12324: every run classifies the whole registry (missing path, temp path,
 * test path), and an applied run removes the matched rows together with their
 * `nexus_project_id_aliases` rows and a `nexus_audit_log` receipt in ONE
 * transaction on the GLOBAL registry store — the store `--vacuum` compacts.
 *
 * @task T1473
 * @task T12324
 */

import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type {
  NexusProjectsCleanReason,
  NexusProjectsCleanReceipt,
  NexusProjectsCleanRemoval,
  NexusProjectsCleanResult,
  NexusRegistryClassification,
} from '@cleocode/contracts';
import { inArray, sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getCleoHome } from '../paths.js';
import { isEphemeralPath } from './registry-hygiene.js';

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
  /** Match paths containing a .temp/ segment or under the OS temp directory (T12324). */
  includeTemp?: boolean;
  /** Match paths containing tmp/test(s)/__tests__/fixture(s)/scratch/sandbox segments. */
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
  /** After delete, VACUUM the GLOBAL registry store to reclaim space (T9117 · T12324). */
  vacuum?: boolean;
  /**
   * When matchPolluted is set and dryRun is false, write an audit JSONL to
   * ~/.local/state/cleo/nexus-cleanup-<ts>.jsonl before deletion (T9149).
   */
  auditLog?: boolean;
}

/** Result envelope for {@link cleanProjects} (contract: `NexusProjectsCleanResult`). */
export type CleanProjectsResult = NexusProjectsCleanResult;

const TEMP_RE = /(^|\/)\.temp(\/|$)/;
// T12324: `__tests__` and plural `tests`/`fixtures` are fixture homes too.
const TESTS_RE = /(^|\/)(tmp|tests?|__tests__|fixtures?|scratch|sandbox)(\/|$)/;

function portablePathForMatch(p: string): string {
  return p.replace(/\\/g, '/');
}

function pathSegmentCount(p: string): number {
  return portablePathForMatch(p).split('/').filter(Boolean).length;
}

/** Registry row fields the clean pass reads. */
interface RegistryRow {
  projectId: string;
  projectPath: string;
  healthStatus: string;
  lastIndexed: string | null;
}

/** Report whether a registry path is temp-like (`.temp/` segment or OS temp root). */
function isTempPath(projectPath: string): boolean {
  return TEMP_RE.test(portablePathForMatch(projectPath)) || isEphemeralPath(projectPath);
}

/** Report whether a registry path carries a test-fixture segment. */
function isTestPath(projectPath: string): boolean {
  return TESTS_RE.test(portablePathForMatch(projectPath));
}

/** Total bytes of the store's pages, read before and after VACUUM. */
function storeBytes(db: NodeSQLiteDatabase): number {
  const pages = db.get<{ page_count: number }>(sql`PRAGMA page_count`).page_count;
  const size = db.get<{ page_size: number }>(sql`PRAGMA page_size`).page_size;
  return pages * size;
}

/**
 * Bulk-purge project registry rows matching configurable criteria.
 *
 * At least one of `pattern`, `includeTemp`, `includeTests`, `matchUnhealthy`,
 * `matchNeverIndexed`, `matchOrphaned` or `matchPolluted` must be set —
 * otherwise throws {@link NoCriteriaError}. If `pattern` is set but invalid,
 * throws {@link InvalidPatternError}. When `dryRun` is true, performs only a
 * preview scan with no deletions; the classification is reported either way.
 *
 * An applied run opens the GLOBAL registry store directly and, in one
 * transaction, deletes the matched rows, every alias pointing at them, any
 * pre-existing orphan alias, and writes the audit receipt.
 *
 * @param opts - Clean options.
 * @returns Clean result with match count, classification, and receipt.
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

  const { getNexusRegistryDb, getNexusRegistryDbPath } = await import('../store/nexus-sqlite.js');
  const {
    projectRegistry: regTable,
    projectIdAliases: aliasTable,
    nexusAuditLog: auditTable,
  } = await import('../store/schema/nexus-schema.js');
  // T12324: the registry lives in the GLOBAL store. Opening it directly (not
  // through the project handle's ATTACH) makes `VACUUM` compact the store the
  // rows were deleted from.
  const cleoHome = getCleoHome();
  const storePath = getNexusRegistryDbPath(cleoHome);
  const db = await getNexusRegistryDb(cleoHome);

  const allRows: RegistryRow[] = db
    .select({
      projectId: regTable.projectId,
      projectPath: regTable.projectPath,
      healthStatus: regTable.healthStatus,
      lastIndexed: regTable.lastIndexed,
    })
    .from(regTable)
    .all();

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

  const registryIds = new Set(allRows.map((row) => row.projectId));
  const aliasRows = db
    .select({ legacyId: aliasTable.legacyId, canonicalId: aliasTable.canonicalId })
    .from(aliasTable)
    .all();
  const classification: NexusRegistryClassification = {
    total: allRows.length,
    missingPath: 0,
    tempPath: 0,
    testPath: 0,
    stale: 0,
    retained: 0,
    aliases: aliasRows.length,
    orphanAliases: aliasRows.filter((alias) => !registryIds.has(alias.canonicalId)).length,
  };

  const matchedByReason: Partial<Record<NexusProjectsCleanReason, number>> = {};
  const removals: NexusProjectsCleanRemoval[] = [];
  for (const row of allRows) {
    const missing = !existsSync(row.projectPath);
    const temp = isTempPath(row.projectPath);
    const test = isTestPath(row.projectPath);
    if (missing) classification.missingPath++;
    if (temp) classification.tempPath++;
    if (test) classification.testPath++;
    if (missing || temp || test) classification.stale++;

    const reasons: NexusProjectsCleanReason[] = [];
    const normalizedProjectPath = portablePathForMatch(row.projectPath);
    if (patternRegex?.test(row.projectPath) || patternRegex?.test(normalizedProjectPath))
      reasons.push('pattern');
    if (opts.includeTemp && temp) reasons.push('temp-path');
    if (opts.includeTests && test) reasons.push('test-path');
    if (opts.matchUnhealthy && row.healthStatus === 'unhealthy') reasons.push('unhealthy');
    if (opts.matchNeverIndexed && row.lastIndexed === null) reasons.push('never-indexed');
    if (opts.matchOrphaned && missing) reasons.push('missing-path');
    if (pollutedIds.has(row.projectId)) reasons.push('path-divergent-duplicate');
    if (reasons.length === 0) continue;
    for (const reason of reasons) matchedByReason[reason] = (matchedByReason[reason] ?? 0) + 1;
    removals.push({ projectId: row.projectId, projectPath: row.projectPath, reasons });
  }
  classification.retained = classification.total - classification.stale;

  const totalCount = allRows.length;
  const matched = removals.length;
  const sample = removals.slice(0, 10).map((r) => path.resolve(r.projectPath));

  if (opts.dryRun || matched === 0) {
    return {
      dryRun: opts.dryRun,
      matched,
      purged: 0,
      remaining: totalCount,
      sample,
      totalCount,
      classification,
      matchedByReason,
    };
  }

  // Write audit JSONL before deletion (T9149 matchPolluted mode)
  if (opts.matchPolluted && opts.auditLog && removals.length > 0) {
    try {
      const { appendFile: appendFn, mkdir: mkdirFn } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const auditDir = path.join(homedir(), '.local', 'state', 'cleo');
      await mkdirFn(auditDir, { recursive: true });
      const auditPath = path.join(auditDir, `nexus-cleanup-${ts}.jsonl`);
      const records = removals
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

  // Rows, their aliases, pre-existing orphan aliases, and the audit receipt
  // commit together or not at all. Chunked to keep SQL parameter counts safe
  // (default SQLite limit is 999 bound variables per statement).
  const CHUNK = 400;
  const idsToDelete = removals.map((r) => r.projectId);
  const auditId = randomUUID();
  const { aliasesRemoved, orphanAliasesRemoved } = db.transaction(
    (tx) => {
      let purgedAliases = 0;
      for (let i = 0; i < idsToDelete.length; i += CHUNK) {
        const slice = idsToDelete.slice(i, i + CHUNK);
        tx.delete(regTable).where(inArray(regTable.projectId, slice)).run();
        purgedAliases += Number(
          tx.delete(aliasTable).where(inArray(aliasTable.canonicalId, slice)).run().changes,
        );
      }
      const orphans = Number(
        tx.run(
          sql`DELETE FROM ${aliasTable} WHERE ${aliasTable.canonicalId} NOT IN (SELECT ${regTable.projectId} FROM ${regTable})`,
        ).changes,
      );
      tx.insert(auditTable)
        .values({
          id: auditId,
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
            aliasesRemoved: purgedAliases,
            orphanAliasesRemoved: orphans,
            sample,
            removed: removals,
          }),
        })
        .run();
      return { aliasesRemoved: purgedAliases, orphanAliasesRemoved: orphans };
    },
    { behavior: 'immediate' },
  );

  const remaining = totalCount - matched;

  // Optional filesystem cleanup — runs only after the row has been purged so a
  // partial failure leaves no DB→disk drift (worst case: dir lingers, can be
  // re-cleaned with --orphans).
  let fsRemoved: number | undefined;
  let fsFailed: number | undefined;
  if (opts.removeFs) {
    fsRemoved = 0;
    fsFailed = 0;
    for (const row of removals) {
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

  // Optional VACUUM of the GLOBAL registry store after large purges. The WAL
  // is checkpointed so the file on disk actually shrinks.
  let vacuum: NexusProjectsCleanReceipt['vacuum'];
  let vacuumBytesFreed: number | undefined;
  if (opts.vacuum) {
    try {
      const beforeBytes = storeBytes(db);
      db.run(sql`VACUUM`);
      db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
      const afterBytes = storeBytes(db);
      vacuum = { beforeBytes, afterBytes };
      vacuumBytesFreed = Math.max(0, beforeBytes - afterBytes);
    } catch {
      vacuumBytesFreed = 0;
    }
  }

  const receipt: NexusProjectsCleanReceipt = {
    auditId,
    storePath,
    removed: removals,
    aliasesRemoved,
    orphanAliasesRemoved,
    ...(vacuum !== undefined ? { vacuum } : {}),
  };

  return {
    dryRun: false,
    matched,
    purged: matched,
    remaining,
    sample,
    totalCount,
    classification,
    matchedByReason,
    receipt,
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
