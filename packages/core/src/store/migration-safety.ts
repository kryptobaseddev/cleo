/**
 * The migration safety harness (T13448, saga T13339 / epic T13340).
 *
 * Every store move in the CleoDocs re-architecture (the T13360 migration, the
 * T13361/T13362 legacy retirements) wraps its steps in this harness so a
 * migration can never destroy or corrupt an existing project's store without
 * a verified recovery path. Each registered step executes inside a fixed
 * bracket:
 *
 *   1. **Pre-step backup** — a `VACUUM INTO` snapshot of the whole project
 *      store via {@link planMigrationSnapshot} + {@link writeMigrationSnapshot}
 *      (the same primitives the twin-collapse repairs use, T12535). The
 *      snapshot is registered as a `migration` system backup
 *      (`.cleo/backups/sqlite/cleo.db.<backupId>` plus its `<backupId>.meta.json`
 *      sidecar), so `cleo backup list` shows it and the per-type rotation
 *      applies. The sidecar is the step's **backup receipt**; its timestamp
 *      feeds the destructive-step guard.
 *   2. **Run** — the step's `run(ctx)` executes against the live native
 *      handle.
 *   3. **Verify** — machine-readable checks: per-table row counts before/after
 *      (matching, or explained by the step's declared `expectedDelta`),
 *      content-hash spot checks (an order-independent multiset hash over the
 *      table's rows, sampled to `sampleSize` rowids when the table is larger),
 *      and `PRAGMA foreign_key_check` (must return zero rows).
 *   4. **Report** — a JSON-serializable {@link MigrationStepReport} per step;
 *      a failed verification **halts** the runner, names the failed step, and
 *      leaves the rollback path ready ({@link rollbackMigrationStep} consumes
 *      exactly the report's backup receipt and before-fingerprints).
 *
 * **Destructive guard** — a step declared `destructive: true` refuses to run
 * unless the harness options pass `force: true` AND the step's backup receipt
 * is younger than the step start (which the harness itself guarantees by
 * taking the snapshot first; a failed or skipped backup therefore refuses the
 * step by construction).
 *
 * **Rollback** — {@link rollbackMigrationStep} restores the step's snapshot
 * through {@link restoreStoreSnapshot} (the programmatic core of
 * `cleo restore backup`, T13240: verified copy, live-writer refusal, the
 * replaced store kept as a pinned `pre-restore-*` backup) and then re-proves
 * the restored store against the pre-step fingerprints (counts and content
 * hashes must match exactly).
 *
 * All store access here is read-only verification SQL plus the `VACUUM INTO`
 * snapshot primitive; steps own their own writes and route them through the
 * canonical accessors (gates 28/38).
 *
 * @module
 * @task T13448
 */

import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { getLogger } from '../logger.js';
import { readBackupSidecar } from './backup-sidecar.js';
import { resolveDualScopeDbPath } from './dual-scope-db.js';
import { openCleoDbSnapshot } from './open-cleo-db.js';
import { planMigrationSnapshot, writeMigrationSnapshot } from './pre-repair-snapshot.js';
import { restoreStoreSnapshot } from './restore-store.js';

/**
 * Context handed to a migration step's `run`.
 *
 * The `db` handle is the caller's live native handle (opened through the
 * store chokepoint by the caller); the harness never opens stores itself.
 */
export interface MigrationStepContext {
  /** Live native handle on the project store the migration operates on. */
  readonly db: DatabaseSync;
  /** Absolute path of the project root whose store is being migrated. */
  readonly projectRoot: string;
  /** Step-scoped log sink (defaults to the module logger). */
  readonly log: (message: string) => void;
}

/**
 * Per-step verification declaration.
 *
 * Everything is optional: the defaults verify EVERY user table with a zero
 * expected row-count delta, which is the strictest useful contract for a
 * carried-table migration.
 */
export interface MigrationStepVerificationSpec {
  /**
   * Tables to fingerprint before/after. Defaults to every user table
   * (`sqlite_*` internals excluded) present when the step starts. Tables the
   * step creates are reported as `addedTables`, not verified.
   */
  readonly tables?: readonly string[];
  /**
   * Expected row-count delta per table (`after === before + delta`). A table
   * with a non-zero declared delta is exempt from the content-hash spot
   * check (its sampled row set legitimately changes); declare its carried
   * subset in `tables` + `skipHash` when a hash check is still wanted.
   */
  readonly expectedDelta?: Readonly<Record<string, number>>;
  /**
   * Content-hash sample size: tables with more rows are spot-checked on
   * `sampleSize` evenly-spaced rowids (sorted order) instead of a full scan.
   * Defaults to {@link DEFAULT_VERIFICATION_SAMPLE_SIZE}.
   */
  readonly sampleSize?: number;
  /** Tables exempt from the content-hash spot check even with a zero delta. */
  readonly skipHash?: readonly string[];
}

/**
 * A single registered migration step. `name` must be unique within a run and
 * is what a halted runner reports.
 */
export interface MigrationStep {
  /** Unique kebab-case step name (surfaced in reports and the backup note). */
  readonly name: string;
  /** Human-readable description (goes into the backup note). */
  readonly description?: string;
  /**
   * Destructive steps (table drops, legacy retirement) refuse to run without
   * `force: true` in the harness options AND a backup receipt younger than
   * the step start.
   */
  readonly destructive?: boolean;
  /** Verification declaration; defaults verify all tables with zero delta. */
  readonly verify?: MigrationStepVerificationSpec;
  /** The migration body. Runs inside the backup → run → verify → report bracket. */
  readonly run: (ctx: MigrationStepContext) => void | Promise<void>;
}

/**
 * Order-independent content fingerprint of one table at one point in time.
 */
export interface TableFingerprint {
  /** Table name. */
  readonly table: string;
  /** Row count at capture time. */
  readonly count: number;
  /**
   * SHA-256 of the sorted multiset of per-row digests — identical for the
   * same row contents in any physical order (so a table REBUILD that carries
   * every row verbatim still matches).
   */
  readonly hash: string;
  /** `true` when the hash covers every row; `false` when it is a sample. */
  readonly full: boolean;
  /** Rowids hashed, when sampled (`full: false`); empty for full scans. */
  readonly sampledRowids: readonly (number | string)[];
}

/**
 * The backup receipt a step runs under: the migration snapshot registered as
 * a `migration` system backup, plus the sidecar timestamp the destructive
 * guard compares against the step start.
 */
export interface StepBackupReceipt {
  /** `<type>-YYYYMMDD-HHmmss[-n]` system-backup id (`cleo backup list`). */
  readonly backupId: string;
  /** Absolute path of the `VACUUM INTO` snapshot file. */
  readonly snapshotPath: string;
  /** ISO-8601 timestamp read back from the `<backupId>.meta.json` sidecar. */
  readonly timestamp: string;
}

/** Per-table before/after verification result for one step. */
export interface TableVerification {
  /** Table name. */
  readonly table: string;
  /** Pre-step fingerprint. */
  readonly before: TableFingerprint;
  /** Post-step fingerprint (`null` when the table was removed). */
  readonly after: TableFingerprint | null;
  /** The declared (or defaulted) expected row-count delta. */
  readonly expectedDelta: number;
  /** Whether the post count equals pre count + expected delta. */
  readonly countOk: boolean;
  /**
   * Whether the content hash is unchanged. `null` when skipped (non-zero
   * declared delta, or the table is in `skipHash`).
   */
  readonly hashOk: boolean | null;
}

/** Outcome of a single step. */
export type MigrationStepStatus = 'completed' | 'failed' | 'refused';

/**
 * Machine-readable per-step report (JSON-serializable). On a failed step this
 * object IS the rollback input: `backup` names the snapshot and
 * `tables[].before` the fingerprints {@link rollbackMigrationStep} re-proves.
 */
export interface MigrationStepReport {
  /** Step name. */
  readonly step: string;
  /** Whether the step declared itself destructive. */
  readonly destructive: boolean;
  /** `completed`, `failed` (verification or run error), or `refused`. */
  readonly status: MigrationStepStatus;
  /** ISO-8601 step start. */
  readonly startedAt: string;
  /** Wall time of the whole bracket (backup + run + verify). */
  readonly durationMs: number;
  /** The pre-step backup receipt (`null` only when the backup itself failed). */
  readonly backup: StepBackupReceipt | null;
  /** Per-table before/after verification. */
  readonly tables: readonly TableVerification[];
  /** Tables created by the step (not covered by before/after verification). */
  readonly addedTables: readonly string[];
  /** Tables dropped by the step. */
  readonly removedTables: readonly string[];
  /** Rows returned by `PRAGMA foreign_key_check` after the step (0 = clean). */
  readonly foreignKeyViolations: number;
  /** Human-readable failure reasons (empty when `completed`). */
  readonly failures: readonly string[];
  /** Error thrown by `run` (or by the pre-step backup), when that failed. */
  readonly runError: string | null;
}

/** Overall runner outcome. */
export type MigrationRunStatus = 'completed' | 'halted' | 'refused';

/** The runner's machine-readable report. */
export interface MigrationRunReport {
  /**
   * `completed` when every step verified; `halted` when a step failed
   * (verification, run error, or backup failure); `refused` when a
   * destructive step was refused. Halted/refused runs name the step.
   */
  readonly status: MigrationRunStatus;
  /** Reports for every step that was attempted (including the failed one). */
  readonly steps: readonly MigrationStepReport[];
  /** The step that halted/refused the run (`null` when completed). */
  readonly haltedStep: string | null;
  /** The first failure reason (`null` when completed). */
  readonly failure: string | null;
}

/** Options accepted by {@link runMigrationSteps}. */
export interface MigrationHarnessOptions {
  /** Live native handle on the project store (caller-opened, chokepoint). */
  readonly db: DatabaseSync;
  /** Absolute path of the project root being migrated. */
  readonly projectRoot: string;
  /**
   * Invocation directory (the worktree guard of the restore path, T12680).
   * Pass the real cwd; tests pass the fixture root.
   */
  readonly cwd: string;
  /**
   * Path of the store file behind `db` (locates the backup directory).
   * Defaults to the canonical project store path for `projectRoot`.
   */
  readonly dbPath?: string;
  /**
   * Required for destructive steps, together with a fresh backup receipt.
   * The CLI wrapper maps `--force` here.
   */
  readonly force?: boolean;
  /** Default content-hash sample size (per-step `sampleSize` wins). */
  readonly sampleSize?: number;
  /** Called with each step's report as it finishes (progress + persistence). */
  readonly onStepReport?: (report: MigrationStepReport) => void;
}

/** Default number of rows content-hash spot-checked per oversized table. */
export const DEFAULT_VERIFICATION_SAMPLE_SIZE = 200;

/**
 * Quote one SQLite identifier (table name) for interpolation.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Error message helper — `Error.message` when available, String otherwise.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Deterministic, unambiguous serialization of one node:sqlite value for
 * hashing: every value kind gets a tag (`N` null, `n` number, `i` bigint,
 * `s` length-prefixed string, `b` hex blob), so distinct value kinds can
 * never collide.
 */
function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return 'N';
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'bigint') return `i:${value.toString()}`;
  if (typeof value === 'string') return `s:${value.length}:${value}`;
  if (value instanceof Uint8Array) return `b:${value.length}:${Buffer.from(value).toString('hex')}`;
  return `x:${String(value)}`;
}

/**
 * SHA-256 digest of one result row: sorted column names plus tagged values,
 * so it is independent of the row's key order and of physical row order.
 */
function rowDigest(row: Record<string, unknown>): string {
  const hash = createHash('sha256');
  for (const key of Object.keys(row).sort()) {
    hash.update(encodeValue(key));
    hash.update('=');
    hash.update(encodeValue(row[key]));
    hash.update(';');
  }
  return hash.digest('hex');
}

/**
 * Combine per-row digests into one table hash: sort the digests and hash the
 * list, making the fingerprint an order-independent multiset hash (a carried
 * table survives a rowid-shuffling rebuild unchanged).
 */
function combineDigests(digests: readonly string[]): string {
  const hash = createHash('sha256');
  for (const digest of [...digests].sort()) {
    hash.update(digest);
    hash.update('\n');
  }
  return hash.digest('hex');
}

/**
 * Pick `n` evenly-spaced entries from an already-sorted list (indexes
 * `floor(i * len / n)`), de-duplicated. Deterministic: the same sorted input
 * yields the same sample every time.
 */
function evenlySpaced<T>(sorted: readonly T[], n: number): T[] {
  if (sorted.length <= n) return [...sorted];
  const out: T[] = [];
  for (let i = 0; i < n; i++) {
    const item = sorted[Math.floor((i * sorted.length) / n)];
    if (item !== undefined && (out.length === 0 || out[out.length - 1] !== item)) {
      out.push(item);
    }
  }
  return out;
}

/**
 * Capture an order-independent content fingerprint of one table.
 *
 * Tables with at most `sampleSize` rows (and `WITHOUT ROWID` tables, which
 * have no rowid to sample) are hashed in full; larger rowid tables are
 * spot-checked on `sampleSize` evenly-spaced rowids. Reads only.
 *
 * @param db - Live native handle.
 * @param table - Table name.
 * @param sampleSize - Full-scan cutoff / sample size (default 200).
 * @returns The fingerprint.
 * @task T13448
 */
export function fingerprintTable(
  db: DatabaseSync,
  table: string,
  sampleSize: number = DEFAULT_VERIFICATION_SAMPLE_SIZE,
): TableFingerprint {
  const quoted = quoteIdent(table);
  const count = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get() as { n: number }).n,
  );
  if (count === 0) {
    return { table, count: 0, hash: combineDigests([]), full: true, sampledRowids: [] };
  }
  let rowids: Array<number | string> | null = null;
  try {
    rowids = (
      db.prepare(`SELECT rowid AS r FROM ${quoted} ORDER BY rowid`).all() as Array<{
        r: number | string;
      }>
    ).map((row) => row.r);
  } catch {
    rowids = null; // WITHOUT ROWID table: no rowid to sample
  }
  let sample: Array<number | string> | null;
  let full: boolean;
  if (rowids === null) {
    sample = null;
    full = true;
  } else if (count <= sampleSize) {
    sample = rowids;
    full = true;
  } else {
    sample = evenlySpaced(rowids, sampleSize);
    full = false;
  }
  const digests: string[] = [];
  if (sample !== null) {
    const stmt = db.prepare(`SELECT * FROM ${quoted} WHERE rowid = ?`);
    for (const rowid of sample) {
      const row = stmt.get(rowid) as Record<string, unknown> | undefined;
      if (row !== undefined) digests.push(rowDigest(row));
    }
  } else {
    const rows = db.prepare(`SELECT * FROM ${quoted}`).all() as Array<Record<string, unknown>>;
    for (const row of rows) digests.push(rowDigest(row));
  }
  return { table, count, hash: combineDigests(digests), full, sampledRowids: sample ?? [] };
}

/**
 * Run `PRAGMA foreign_key_check` and return the violation count. Zero is the
 * only passing value; the pragma reports independently of the
 * `foreign_keys` switch, so a migration that toggles FK enforcement mid-step
 * is still checked. Read-only.
 *
 * @param db - Live native handle.
 * @returns Number of FK violations.
 * @task T13448
 */
export function countForeignKeyViolations(db: DatabaseSync): number {
  return db.prepare('PRAGMA foreign_key_check').all().length;
}

/**
 * List user tables (everything except `sqlite_*` internals) in name order.
 * Read-only.
 */
function listUserTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * Capture the pre- or post-step fingerprint set for the tables in scope.
 */
function captureFingerprints(
  db: DatabaseSync,
  tables: readonly string[] | undefined,
  sampleSize: number,
): TableFingerprint[] {
  const names = tables ?? listUserTables(db);
  return names.map((table) => fingerprintTable(db, table, sampleSize));
}

/**
 * Run migration steps inside the backup → migrate → verify → report bracket
 * (T13448). Never throws for verification failures, refusals, or step errors:
 * those are reported and halt the run (AC1, AC4). Throws only for invalid
 * invocation (no steps).
 *
 * @param steps - The registered steps, in execution order.
 * @param opts - The store handle, project, force flag and hooks.
 * @returns The machine-readable run report. On `halted`/`refused`, the last
 *   step report carries the backup receipt and before-fingerprints needed by
 *   {@link rollbackMigrationStep}.
 * @task T13448
 */
export async function runMigrationSteps(
  steps: readonly MigrationStep[],
  opts: MigrationHarnessOptions,
): Promise<MigrationRunReport> {
  if (steps.length === 0) {
    // @sync-invariant none:input-shape nothing was asked of the store
    throw new CleoError(ExitCode.INVALID_INPUT, 'runMigrationSteps: at least one step is required');
  }
  const dbPath = opts.dbPath ?? resolveDualScopeDbPath('project', opts.projectRoot);
  const sampleSize = opts.sampleSize ?? DEFAULT_VERIFICATION_SAMPLE_SIZE;
  const logger = getLogger('migration-safety');
  const reports: MigrationStepReport[] = [];

  for (const step of steps) {
    const startedAt = new Date();
    const stepStartMs = startedAt.getTime();
    const clockStart = Date.now();
    const spec = step.verify ?? {};
    const skipHash = new Set(spec.skipHash ?? []);
    const stepSampleSize = spec.sampleSize ?? sampleSize;
    const beforeTables = captureFingerprints(opts.db, spec.tables, stepSampleSize);
    const failures: string[] = [];
    let backup: StepBackupReceipt | null = null;
    let runError: string | null = null;
    let status: MigrationStepStatus = 'completed';
    const verifications: TableVerification[] = [];
    let addedTables: string[] = [];
    let removedTables: string[] = [];
    let fkViolations = 0;

    // 1. Pre-step VACUUM INTO backup, registered as a migration system
    //    backup whose sidecar is this step's receipt (T12535 machinery).
    try {
      const plan = planMigrationSnapshot(opts.db, dbPath);
      const snapshotPath = writeMigrationSnapshot(
        opts.db,
        plan,
        `migration step: ${step.name}${step.description ? ` — ${step.description}` : ''} (T13448)`,
      );
      const receipt = readBackupSidecar(snapshotPath, 'migration');
      backup = {
        backupId: plan.backupId,
        snapshotPath,
        timestamp: receipt?.timestamp ?? new Date().toISOString(),
      };
    } catch (err) {
      status = 'failed';
      runError = `pre-step backup failed: ${messageOf(err)}`;
    }

    // 2. Destructive guard: refuse without force AND a receipt younger than
    //    the step start (AC: owner directive 2026-10-10).
    if (status === 'completed' && step.destructive === true) {
      const receiptFresh = backup !== null && Date.parse(backup.timestamp) >= stepStartMs;
      if (opts.force !== true || !receiptFresh) {
        status = 'refused';
        failures.push(
          'destructive step refused: requires force AND a backup receipt younger than the step start',
        );
      }
    }

    // 3. Run the step.
    if (status === 'completed') {
      const log = (message: string): void => {
        logger.info({ step: step.name }, message);
      };
      try {
        await step.run({ db: opts.db, projectRoot: opts.projectRoot, log });
      } catch (err) {
        status = 'failed';
        runError = messageOf(err);
      }
    }

    // 4. Verify: counts (or declared deltas), content-hash spot checks, FK.
    if (status === 'completed') {
      fkViolations = countForeignKeyViolations(opts.db);
      const beforeNames = new Set(beforeTables.map((fp) => fp.table));
      const afterNames = new Set(listUserTables(opts.db));
      addedTables = [...afterNames].filter((name) => !beforeNames.has(name));
      removedTables = [...beforeNames].filter((name) => !afterNames.has(name));
      for (const before of beforeTables) {
        const expectedDelta = spec.expectedDelta?.[before.table] ?? 0;
        if (!afterNames.has(before.table)) {
          failures.push(`table ${before.table} was removed by the step`);
          verifications.push({
            table: before.table,
            before,
            after: null,
            expectedDelta,
            countOk: false,
            hashOk: null,
          });
          continue;
        }
        const after = fingerprintTable(opts.db, before.table, stepSampleSize);
        const countOk = after.count === before.count + expectedDelta;
        // A non-zero declared delta legitimately reshapes the table: the
        // count is the contract there, the hash check applies to carried
        // (zero-delta, not skip-listed) tables.
        const hashChecked = expectedDelta === 0 && !skipHash.has(before.table);
        const hashOk = hashChecked ? after.hash === before.hash : null;
        if (!countOk) {
          failures.push(
            `table ${before.table}: row count ${after.count} != ${before.count} + ${expectedDelta} (expected delta not explained)`,
          );
        }
        if (hashOk === false) {
          failures.push(
            `table ${before.table}: content hash changed (carried-table spot check failed)`,
          );
        }
        verifications.push({
          table: before.table,
          before,
          after,
          expectedDelta,
          countOk,
          hashOk,
        });
      }
      if (removedTables.length > 0) {
        failures.push(`tables removed by the step: ${removedTables.join(', ')}`);
      }
      if (fkViolations > 0) {
        failures.push(
          `PRAGMA foreign_key_check returned ${fkViolations} violation(s) after the step`,
        );
      }
      if (failures.length > 0) status = 'failed';
    }

    const report: MigrationStepReport = {
      step: step.name,
      destructive: step.destructive === true,
      status,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - clockStart,
      backup,
      tables: verifications,
      addedTables,
      removedTables,
      foreignKeyViolations: fkViolations,
      failures,
      runError,
    };
    reports.push(report);
    opts.onStepReport?.(report);
    if (status === 'completed') {
      logger.info(
        { step: step.name, backupId: backup?.backupId ?? null, tables: verifications.length },
        'migration step verified (T13448)',
      );
    } else {
      logger.warn(
        { step: step.name, status, failures, runError },
        'migration step failed; run halted, rollback path ready (T13448)',
      );
      return {
        status: status === 'refused' ? 'refused' : 'halted',
        steps: reports,
        haltedStep: step.name,
        failure: failures[0] ?? runError ?? 'step failed',
      };
    }
  }

  return { status: 'completed', steps: reports, haltedStep: null, failure: null };
}

/** Parameters of {@link rollbackMigrationStep}. */
export interface MigrationRollbackParams {
  /** Absolute path of the project root whose store is restored. */
  readonly projectRoot: string;
  /** Invocation directory (worktree guard; tests pass the fixture root). */
  readonly cwd: string;
  /** The halted/failed step's name (echoed into the report). */
  readonly step: string;
  /** The step's backup receipt (`stepReport.backup`). */
  readonly backup: StepBackupReceipt;
  /** The step's pre-step fingerprints (`stepReport.tables.map(t => t.before)`). */
  readonly before: readonly TableFingerprint[];
  /** From a git worktree: allow overwriting the owning project's live store. */
  readonly confirmOwnerStore?: boolean;
  /** Sample size used for re-fingerprinting (must match the run's). */
  readonly sampleSize?: number;
}

/** Per-table rollback verification result. */
export interface RollbackTableResult {
  /** Table name. */
  readonly table: string;
  /** The pre-step fingerprint the restore must reproduce. */
  readonly expected: TableFingerprint;
  /** The fingerprint of the restored store (`null` when unreadable). */
  readonly actual: TableFingerprint | null;
  /** Whether the restored row count matches the pre-step count. */
  readonly countOk: boolean;
  /** Whether the restored content hash matches the pre-step hash. */
  readonly hashOk: boolean;
}

/**
 * Rollback report: what was restored and whether the restored store provably
 * matches the pre-step snapshot (counts and content hashes).
 */
export interface MigrationRollbackReport {
  /** The step that was rolled back. */
  readonly step: string;
  /** Whether {@link restoreStoreSnapshot} placed the snapshot. */
  readonly restored: boolean;
  /** `true` when restored AND every table re-matches its pre-step fingerprint. */
  readonly verified: boolean;
  /** The `cleo restore backup --id …` undo of THIS restore (T13240), when kept. */
  readonly undo: string | null;
  /** The pinned `pre-restore-*` backup id of the replaced (migrated) store. */
  readonly keptBackupId: string | null;
  /** Per-table verification against the pre-step fingerprints. */
  readonly tables: readonly RollbackTableResult[];
  /** Human-readable failures (empty when `verified`). */
  readonly failures: readonly string[];
}

/**
 * Roll back one migration step: restore its pre-step snapshot through the
 * programmatic core of `cleo restore backup` ({@link restoreStoreSnapshot} —
 * verified copy, quiescence/live-writer refusal, the replaced store kept as
 * a pinned `pre-restore-*` backup), then re-prove the restored store against
 * the step's pre-step fingerprints. This is the tested rollback path of AC3.
 *
 * Note: the restore closes every in-process handle on the store (T13240
 * quiescence) — discard any native handle captured before calling this and
 * re-open through the chokepoint afterwards.
 *
 * @param params - The step, its backup receipt and its before-fingerprints.
 * @returns The rollback report; `verified` is the assertion surface.
 * @task T13448
 */
export async function rollbackMigrationStep(
  params: MigrationRollbackParams,
): Promise<MigrationRollbackReport> {
  const sampleSize = params.sampleSize ?? DEFAULT_VERIFICATION_SAMPLE_SIZE;
  const result = await restoreStoreSnapshot({
    projectRoot: params.projectRoot,
    cwd: params.cwd,
    snapshot: params.backup.snapshotPath,
    ...(params.confirmOwnerStore !== undefined
      ? { confirmOwnerStore: params.confirmOwnerStore }
      : {}),
  });

  const failures: string[] = [];
  const tables: RollbackTableResult[] = [];
  if (!result.restored) {
    failures.push('restoreStoreSnapshot did not place the snapshot');
  }
  const restored = openCleoDbSnapshot(result.target, { readOnly: true });
  try {
    for (const expected of params.before) {
      let actual: TableFingerprint | null = null;
      try {
        actual = fingerprintTable(restored.db, expected.table, sampleSize);
      } catch {
        actual = null; // table absent from the restored store
      }
      const countOk = actual !== null && actual.count === expected.count;
      const hashOk = actual !== null && actual.hash === expected.hash;
      if (!countOk) {
        failures.push(
          `rollback verify: ${expected.table} row count ${actual?.count ?? 'unreadable'} != pre-step ${expected.count}`,
        );
      }
      if (!hashOk) {
        failures.push(
          `rollback verify: ${expected.table} content hash differs from the pre-step snapshot`,
        );
      }
      tables.push({ table: expected.table, expected, actual, countOk, hashOk });
    }
  } finally {
    restored.close();
  }

  return {
    step: params.step,
    restored: result.restored,
    verified: failures.length === 0,
    undo: result.undo,
    keptBackupId: result.kept?.backupId ?? null,
    tables,
    failures,
  };
}
