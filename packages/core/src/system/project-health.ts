/**
 * Cross-project health checks for every project registered in `nexus.db`.
 *
 * This module iterates the global NEXUS `project_registry` table and, for each
 * registered project, probes ALL of its databases (tasks.db, brain.db,
 * conduit.db) plus its key JSON files (config.json, project-info.json). It
 * also probes the global-tier databases (nexus.db, signaldock.db).
 *
 * Results are aggregated into a {@link FullHealthReport} and optionally
 * written back to the `healthStatus` column so subsequent `cleo nexus list`
 * calls surface stale/degraded projects without re-running the full probe.
 *
 * Probe guarantees (STRICT):
 *   1. Public functions NEVER throw — every failure is captured as an `error`
 *      field on a {@link DbProbeResult} or {@link ProjectHealthReport}.
 *   2. All paths come from SSoT resolvers ({@link getPlatformPaths},
 *      {@link getCleoHome}, {@link getCleoDirAbsolute}). No `join(homedir(),
 *      '.cleo')` is constructed locally.
 *   3. Concurrency is bounded by a counter-based limiter (default 8) — no new
 *      third-party dependencies.
 *   4. The registry-update path short-circuits cleanly when `nexus.db` cannot
 *      be opened (fresh install, pre-migration), so this module is safe to
 *      run from `cleo self-update` BEFORE `runUpgrade()` repairs state.
 *
 * @task T-PROJECT-HEALTH
 */

import { access as fsAccess, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { getLogger } from '../logger.js';
import { getCleoDirAbsolute, getCleoHome } from '../paths.js';

// Cross-OS correct: createRequire for node:sqlite (Vitest/Vite cannot resolve
// the `node:` prefix as a bare ESM specifier). Matches the pattern used in
// packages/core/src/store/sqlite.ts.
const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
type DatabaseSyncModule = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean; timeout?: number },
  ) => DatabaseSync;
};
let _databaseSyncCtor: DatabaseSyncModule['DatabaseSync'] | null | undefined;
function getDatabaseSyncCtor(): DatabaseSyncModule['DatabaseSync'] | null {
  if (_databaseSyncCtor !== undefined) return _databaseSyncCtor;
  try {
    const mod = _require('node:sqlite') as DatabaseSyncModule;
    _databaseSyncCtor = mod.DatabaseSync;
  } catch {
    _databaseSyncCtor = null;
  }
  return _databaseSyncCtor;
}

// Re-exported names from packages/cleo/src/cli/paths.ts — redeclared locally
// to preserve the package-boundary contract (core MUST NOT import from cleo).
// These are the exact same string literals as `TASKS_DB_FILENAME` etc.
const TASKS_DB = 'tasks.db' as const;
const BRAIN_DB = 'brain.db' as const;
const CONDUIT_DB = 'conduit.db' as const;
const NEXUS_DB = 'nexus.db' as const;
const SIGNALDOCK_DB = 'signaldock.db' as const;
const CONFIG_JSON = 'config.json' as const;
const PROJECT_INFO_JSON = 'project-info.json' as const;

// ============================================================================
// Public types
// ============================================================================

/** Discrete health verdict stored on the `project_registry.health_status` column. */
export type ProjectHealthStatus = 'healthy' | 'degraded' | 'unreachable' | 'unknown';

/**
 * Programmatic probe result for a single SQLite database file.
 *
 * Captures filesystem presence, openability, PRAGMA-level integrity, and
 * WAL sidecar coherence. Every field is populated even on the error path so
 * callers can render actionable diagnostics without re-probing.
 */
export interface DbProbeResult {
  /** Absolute path to the probed database file. */
  path: string;
  /** True if the file exists on disk. */
  exists: boolean;
  /** True if the current process has read permission for the file. */
  readable: boolean;
  /** True if `node:sqlite` successfully opened the file. */
  sqliteOpenable: boolean;
  /** True iff `PRAGMA integrity_check` returned exactly the value `'ok'`. */
  integrityOk: boolean;
  /**
   * True if either (a) no WAL sidecar is present, or (b) a WAL sidecar is
   * present AND the DB opened successfully (meaning SQLite could merge it).
   * False if the sidecar exists but the DB could not be opened.
   */
  walSidecarClean: boolean;
  /** Value of `PRAGMA user_version` — undefined if the DB could not be opened. */
  schemaVersion?: number;
  /** Size of the DB file in bytes, or `-1` when `stat` fails. */
  sizeBytes: number;
  /** First error encountered during the probe (null when the probe succeeded). */
  error?: string;
}

/** Presence + parseability check for a JSON file (config.json, project-info.json). */
export interface JsonFileProbe {
  /** True if the file exists on disk. */
  exists: boolean;
  /** True if the file parsed as JSON without throwing. */
  parseable: boolean;
  /** First error encountered (missing file, IO error, parse error). */
  error?: string;
}

/**
 * Aggregated health report for a single registered project.
 *
 * Combines DB probes, JSON-file probes, and a top-level {@link overall}
 * verdict that mirrors the taxonomy stored in `project_registry.healthStatus`.
 */
export interface ProjectHealthReport {
  /** 12-char projectHash PK from `project_registry`. */
  projectHash: string;
  /** Absolute project root path as recorded in the registry. */
  projectPath: string;
  /** True iff the project directory is accessible AND `.cleo/` exists. */
  reachable: boolean;
  /** DB probes for the three project-tier SQLite files. */
  dbs: {
    tasks: DbProbeResult;
    brain: DbProbeResult;
    conduit: DbProbeResult;
  };
  /** Probes for the two canonical JSON config files. */
  files: {
    config: JsonFileProbe;
    projectInfo: JsonFileProbe;
  };
  /** Overall verdict — folded from all probes via {@link deriveOverallStatus}. */
  overall: ProjectHealthStatus;
  /** Human-readable summary strings suitable for a table column. */
  issues: string[];
  /** ISO 8601 timestamp when the probe completed. */
  checkedAt: string;
}

/** Aggregated health report for the two global-tier databases. */
export interface GlobalHealthReport {
  /** Absolute CLEO home directory (via {@link getCleoHome}). */
  cleoHome: string;
  /** Global-tier SQLite probes. */
  dbs: {
    nexus: DbProbeResult;
    signaldock: DbProbeResult;
  };
  /** Overall verdict across both global DBs. */
  overall: ProjectHealthStatus;
  /** Human-readable summary strings. */
  issues: string[];
  /** ISO 8601 timestamp when the probe completed. */
  checkedAt: string;
}

/** Top-level report combining global + all per-project reports. */
export interface FullHealthReport {
  /** Global-tier probe. */
  global: GlobalHealthReport;
  /** One report per registered project. */
  projects: ProjectHealthReport[];
  /** Numeric summary for quick rendering. */
  summary: {
    totalProjects: number;
    healthy: number;
    degraded: number;
    unreachable: number;
    unknown: number;
  };
  /** ISO 8601 timestamp when the full report was assembled. */
  generatedAt: string;
}

/** Options for {@link checkAllRegisteredProjects}. */
export interface CheckAllOptions {
  /**
   * When true, write each project's computed {@link ProjectHealthReport.overall}
   * back to `project_registry.health_status` and bump `last_seen`.
   * Defaults to true.
   */
  updateRegistry?: boolean;
  /** Concurrency cap for per-project probes. Defaults to 8. */
  parallelism?: number;
  /** When true (default), include the global-tier probe. */
  includeGlobal?: boolean;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Best-effort existence probe. Returns false for any access error (ENOENT,
 * EACCES, etc.) so callers can branch without wrapping in try/catch.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fsAccess(p);
    return true;
  } catch {
    return false;
  }
}

/** Read a file and attempt a JSON parse. Never throws. */
async function probeJsonFile(path: string): Promise<JsonFileProbe> {
  if (!(await pathExists(path))) {
    return { exists: false, parseable: false, error: 'File not found' };
  }
  try {
    const raw = await readFile(path, 'utf-8');
    JSON.parse(raw);
    return { exists: true, parseable: true };
  } catch (err) {
    return {
      exists: true,
      parseable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Counter-based concurrency limiter. No new dependencies. */
async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes: Promise<void>[] = [];
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  for (let i = 0; i < effectiveLimit; i++) {
    lanes.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          const item = items[idx] as T;
          results[idx] = await worker(item, idx);
        }
      })(),
    );
  }
  await Promise.all(lanes);
  return results;
}

/** Compute `overall` for a project report from its constituent probes. */
function deriveOverallStatus(
  reachable: boolean,
  cleoDirExists: boolean,
  dbs: ProjectHealthReport['dbs'],
  files: ProjectHealthReport['files'],
): ProjectHealthStatus {
  if (!reachable) return 'unreachable';
  // Project dir exists but no .cleo/ — user never ran `cleo init` in this dir.
  // Not a system-level failure, just unknown from CLEO's perspective.
  if (!cleoDirExists) return 'unknown';

  const dbProbes: DbProbeResult[] = [dbs.tasks, dbs.brain, dbs.conduit];
  const degradedDb = dbProbes.some(
    (d) => d.exists && (!d.integrityOk || !d.walSidecarClean || !d.sqliteOpenable),
  );
  const configBroken = files.config.exists && !files.config.parseable;
  const infoBroken = files.projectInfo.exists && !files.projectInfo.parseable;
  if (degradedDb || configBroken || infoBroken) return 'degraded';

  // A project with no DBs at all is unknown (effectively empty .cleo/ dir).
  // A healthy project must have at least tasks.db present and passing.
  if (!dbs.tasks.exists) return 'unknown';

  return 'healthy';
}

/** Build a human-readable issue list from a project report. */
function collectProjectIssues(report: Omit<ProjectHealthReport, 'issues' | 'overall'>): string[] {
  const issues: string[] = [];
  if (!report.reachable) {
    issues.push(`Project directory not reachable: ${report.projectPath}`);
    return issues;
  }
  for (const [label, probe] of [
    ['tasks.db', report.dbs.tasks] as const,
    ['brain.db', report.dbs.brain] as const,
    ['conduit.db', report.dbs.conduit] as const,
  ]) {
    if (probe.exists && !probe.sqliteOpenable) {
      issues.push(`${label}: cannot open (${probe.error ?? 'unknown error'})`);
    } else if (probe.exists && !probe.integrityOk) {
      issues.push(`${label}: integrity_check failed`);
    } else if (probe.exists && !probe.walSidecarClean) {
      issues.push(`${label}: WAL sidecar conflict`);
    }
  }
  if (report.files.config.exists && !report.files.config.parseable) {
    issues.push(`config.json: ${report.files.config.error ?? 'parse error'}`);
  }
  if (report.files.projectInfo.exists && !report.files.projectInfo.parseable) {
    issues.push(`project-info.json: ${report.files.projectInfo.error ?? 'parse error'}`);
  }
  return issues;
}

/** Build an issue list for the global-tier report. */
function collectGlobalIssues(dbs: GlobalHealthReport['dbs']): string[] {
  const issues: string[] = [];
  for (const [label, probe] of [
    ['nexus.db', dbs.nexus] as const,
    ['signaldock.db', dbs.signaldock] as const,
  ]) {
    if (!probe.exists) {
      // Global DBs may legitimately be absent on a fresh install — warn, don't error.
      issues.push(`${label}: not present (run: cleo init)`);
      continue;
    }
    if (!probe.sqliteOpenable) {
      issues.push(`${label}: cannot open (${probe.error ?? 'unknown error'})`);
    } else if (!probe.integrityOk) {
      issues.push(`${label}: integrity_check failed`);
    } else if (!probe.walSidecarClean) {
      issues.push(`${label}: WAL sidecar conflict`);
    }
  }
  return issues;
}

/** Compute the `overall` verdict for the global report. */
function deriveGlobalStatus(dbs: GlobalHealthReport['dbs']): ProjectHealthStatus {
  const probes: DbProbeResult[] = [dbs.nexus, dbs.signaldock];
  // Missing global DB is "unknown" (pre-init) not a failure.
  if (probes.every((p) => !p.exists)) return 'unknown';
  const degraded = probes.some(
    (p) => p.exists && (!p.integrityOk || !p.walSidecarClean || !p.sqliteOpenable),
  );
  return degraded ? 'degraded' : 'healthy';
}

// ============================================================================
// Public probe functions
// ============================================================================

/**
 * Probe a single SQLite database file. Never throws — failures surface as
 * `error` on the returned {@link DbProbeResult}.
 *
 * Performs, in order:
 *   1. `fs.access` — existence + read permission.
 *   2. `fs.stat` — size in bytes.
 *   3. WAL sidecar detection (`<path>-wal`).
 *   4. Open via `node:sqlite` in read-only mode.
 *   5. `PRAGMA integrity_check` — expects exactly the string `'ok'`.
 *   6. `PRAGMA user_version` — captured as `schemaVersion`.
 *
 * @param dbPath - Absolute path to the SQLite DB file.
 * @returns A fully populated {@link DbProbeResult}.
 *
 * @example
 * ```typescript
 * const probe = await probeDb('/my/project/.cleo/tasks.db');
 * if (!probe.integrityOk) console.error(probe.error);
 * ```
 */
export async function probeDb(dbPath: string): Promise<DbProbeResult> {
  const result: DbProbeResult = {
    path: dbPath,
    exists: false,
    readable: false,
    sqliteOpenable: false,
    integrityOk: false,
    walSidecarClean: true,
    sizeBytes: -1,
  };

  // 1. Existence + readability
  const exists = await pathExists(dbPath);
  result.exists = exists;
  if (!exists) {
    result.error = 'File not found';
    return result;
  }

  try {
    await fsAccess(dbPath);
    result.readable = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }

  // 2. Size
  try {
    const st = await stat(dbPath);
    result.sizeBytes = st.size;
  } catch {
    result.sizeBytes = -1;
  }

  // 3. WAL sidecar presence (rechecked after open below)
  const walPath = `${dbPath}-wal`;
  const walExists = await pathExists(walPath);

  // 4. Open via node:sqlite
  const DatabaseSyncCtor = getDatabaseSyncCtor();
  if (!DatabaseSyncCtor) {
    result.error = 'node:sqlite runtime not available';
    result.walSidecarClean = !walExists;
    return result;
  }

  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSyncCtor(dbPath, { readOnly: true, timeout: 5000 });
    result.sqliteOpenable = true;

    // 5. Integrity check
    try {
      const row = db.prepare('PRAGMA integrity_check').get() as
        | { integrity_check?: string }
        | undefined;
      result.integrityOk = row?.integrity_check === 'ok';
      if (!result.integrityOk) {
        result.error = `integrity_check returned '${row?.integrity_check ?? 'undefined'}'`;
      }
    } catch (err) {
      result.integrityOk = false;
      result.error = err instanceof Error ? err.message : String(err);
    }

    // 6. Schema version (best-effort)
    try {
      const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      if (typeof row?.user_version === 'number') {
        result.schemaVersion = row.user_version;
      }
    } catch {
      // user_version read failure is non-fatal
    }

    // WAL sidecar is considered clean when the DB opened successfully —
    // that means SQLite could process the WAL (checkpoint/merge) without
    // lock contention.
    result.walSidecarClean = true;
  } catch (err) {
    result.sqliteOpenable = false;
    result.error = err instanceof Error ? err.message : String(err);
    // DB could not be opened — if a WAL sidecar exists, flag it as dirty
    // since we cannot confirm SQLite was able to process it.
    result.walSidecarClean = !walExists;
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort — ignore close errors on failed opens.
    }
  }

  return result;
}

/**
 * Check the health of every database + config file for a single registered
 * project. Never throws — returns a populated report with `error` fields.
 *
 * @param projectPath - Absolute path to the project root (as stored in
 *   `project_registry.project_path`).
 * @param projectHash - 12-char project hash (as stored in
 *   `project_registry.project_hash`).
 * @returns Fully populated {@link ProjectHealthReport}.
 *
 * @example
 * ```typescript
 * const report = await checkProjectHealth('/my/project', 'abcdef012345');
 * if (report.overall !== 'healthy') console.log(report.issues);
 * ```
 */
export async function checkProjectHealth(
  projectPath: string,
  projectHash: string,
): Promise<ProjectHealthReport> {
  const checkedAt = new Date().toISOString();
  const reachable = await pathExists(projectPath);
  if (!reachable) {
    // Short-circuit: build a report that reflects an unreachable project.
    const stubProbe = (p: string): DbProbeResult => ({
      path: p,
      exists: false,
      readable: false,
      sqliteOpenable: false,
      integrityOk: false,
      walSidecarClean: true,
      sizeBytes: -1,
      error: 'Project directory not reachable',
    });
    const cleoDir = join(projectPath, '.cleo');
    const base: Omit<ProjectHealthReport, 'issues' | 'overall'> = {
      projectHash,
      projectPath,
      reachable: false,
      dbs: {
        tasks: stubProbe(join(cleoDir, TASKS_DB)),
        brain: stubProbe(join(cleoDir, BRAIN_DB)),
        conduit: stubProbe(join(cleoDir, CONDUIT_DB)),
      },
      files: {
        config: { exists: false, parseable: false, error: 'Project directory not reachable' },
        projectInfo: {
          exists: false,
          parseable: false,
          error: 'Project directory not reachable',
        },
      },
      checkedAt,
    };
    return {
      ...base,
      overall: deriveOverallStatus(false, false, base.dbs, base.files),
      issues: collectProjectIssues(base),
    };
  }

  // Reachable — use SSoT resolver for .cleo/ directory.
  const cleoDir = getCleoDirAbsolute(projectPath);
  const cleoDirExists = await pathExists(cleoDir);

  const [tasks, brain, conduit, configProbe, infoProbe] = await Promise.all([
    probeDb(join(cleoDir, TASKS_DB)),
    probeDb(join(cleoDir, BRAIN_DB)),
    probeDb(join(cleoDir, CONDUIT_DB)),
    probeJsonFile(join(cleoDir, CONFIG_JSON)),
    probeJsonFile(join(cleoDir, PROJECT_INFO_JSON)),
  ]);

  const base: Omit<ProjectHealthReport, 'issues' | 'overall'> = {
    projectHash,
    projectPath,
    reachable: true,
    dbs: { tasks, brain, conduit },
    files: { config: configProbe, projectInfo: infoProbe },
    checkedAt,
  };
  return {
    ...base,
    overall: deriveOverallStatus(true, cleoDirExists, base.dbs, base.files),
    issues: collectProjectIssues(base),
  };
}

/**
 * Check the two global-tier databases (nexus.db, signaldock.db) under
 * `getCleoHome()`. Never throws.
 *
 * Safe to call before `cleo init` — missing global DBs yield an `unknown`
 * verdict rather than a failure.
 *
 * @returns Populated {@link GlobalHealthReport}.
 */
export async function checkGlobalHealth(): Promise<GlobalHealthReport> {
  const cleoHome = getCleoHome();
  const [nexus, signaldock] = await Promise.all([
    probeDb(join(cleoHome, NEXUS_DB)),
    probeDb(join(cleoHome, SIGNALDOCK_DB)),
  ]);
  const dbs = { nexus, signaldock };
  return {
    cleoHome,
    dbs,
    overall: deriveGlobalStatus(dbs),
    issues: collectGlobalIssues(dbs),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Load every registered project from `nexus.db` and probe each one. Never
 * throws — if `nexus.db` is not initialized, returns a report with an empty
 * projects list.
 *
 * On success (and when `opts.updateRegistry` is true, the default), writes
 * the computed {@link ProjectHealthReport.overall} back to
 * `project_registry.health_status` and bumps `last_seen`.
 *
 * @param opts - See {@link CheckAllOptions}.
 * @returns Aggregated {@link FullHealthReport}.
 *
 * @example
 * ```typescript
 * const full = await checkAllRegisteredProjects({ parallelism: 4 });
 * console.log(`${full.summary.degraded} project(s) degraded`);
 * ```
 */
export async function checkAllRegisteredProjects(
  opts?: CheckAllOptions,
): Promise<FullHealthReport> {
  const log = getLogger('nexus');
  const updateRegistry = opts?.updateRegistry ?? true;
  const parallelism = Math.max(1, opts?.parallelism ?? 8);
  const includeGlobal = opts?.includeGlobal ?? true;
  const generatedAt = new Date().toISOString();

  // Global-tier probe first — safe even when nexus.db is missing.
  const global: GlobalHealthReport = includeGlobal
    ? await checkGlobalHealth()
    : {
        cleoHome: getCleoHome(),
        dbs: {
          nexus: {
            path: join(getCleoHome(), NEXUS_DB),
            exists: false,
            readable: false,
            sqliteOpenable: false,
            integrityOk: false,
            walSidecarClean: true,
            sizeBytes: -1,
            error: 'Skipped (includeGlobal=false)',
          },
          signaldock: {
            path: join(getCleoHome(), SIGNALDOCK_DB),
            exists: false,
            readable: false,
            sqliteOpenable: false,
            integrityOk: false,
            walSidecarClean: true,
            sizeBytes: -1,
            error: 'Skipped (includeGlobal=false)',
          },
        },
        overall: 'unknown',
        issues: ['Global probe skipped (includeGlobal=false)'],
        checkedAt: generatedAt,
      };

  // Load registered projects. nexusList is defensive (returns [] when nexus.db
  // has not been initialized) so we never crash a fresh install.
  let projects: ProjectHealthReport[] = [];
  try {
    const { nexusList } = await import('../nexus/registry.js');
    const rows = await nexusList();
    projects = await runWithConcurrency(rows, parallelism, (row) =>
      checkProjectHealth(row.path, row.hash),
    );
  } catch (err) {
    log.warn({ err }, 'project-health: failed to enumerate registered projects');
  }

  if (updateRegistry && projects.length > 0) {
    await writeHealthBack(projects, log);
  }

  const summary = {
    totalProjects: projects.length,
    healthy: projects.filter((p) => p.overall === 'healthy').length,
    degraded: projects.filter((p) => p.overall === 'degraded').length,
    unreachable: projects.filter((p) => p.overall === 'unreachable').length,
    unknown: projects.filter((p) => p.overall === 'unknown').length,
  };

  return { global, projects, summary, generatedAt };
}

// ============================================================================
// Registry write-back
// ============================================================================

/**
 * Persist each report's `overall` verdict to `project_registry.health_status`
 * and bump `last_seen`. Never throws — individual row failures are logged as
 * warnings so a single busted row cannot break the whole batch.
 *
 * @internal
 */
async function writeHealthBack(
  reports: readonly ProjectHealthReport[],
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  try {
    const [{ getNexusDb }, { projectRegistry }, { eq }] = await Promise.all([
      import('../store/nexus-sqlite.js'),
      import('../store/nexus-schema.js'),
      import('drizzle-orm'),
    ]);
    const db = await getNexusDb();
    const now = new Date().toISOString();
    for (const report of reports) {
      try {
        await db
          .update(projectRegistry)
          .set({
            healthStatus: report.overall,
            healthLastCheck: now,
            lastSeen: now,
          })
          .where(eq(projectRegistry.projectHash, report.projectHash));
      } catch (err) {
        log.warn(
          { err, projectHash: report.projectHash },
          'project-health: registry write-back failed for project',
        );
      }
    }
  } catch (err) {
    // nexus.db unavailable (fresh install / schema drift). Non-fatal.
    log.warn({ err }, 'project-health: could not open nexus.db for write-back');
  }
}

// ============================================================================
// Path helpers (kept private; callers use the SSoT resolvers directly)
// ============================================================================

/**
 * Resolve the parent directory of a DB path — used by higher-level callers
 * (e.g. the doctor CLI) to check free space. Local helper; not part of the
 * public contract.
 *
 * @internal
 */
export function _parentDirOf(dbPath: string): string {
  return dirname(dbPath);
}
