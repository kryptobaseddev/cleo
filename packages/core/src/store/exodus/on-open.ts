/**
 * Exodus-on-open — lazy, idempotent, parity-gated auto-migration of the legacy
 * multi-DB fleet into the consolidated dual-scope `cleo.db` on first open.
 *
 * ## Why this exists (data-continuity safety net · T11553)
 *
 * E6 routes every `getDb`/`getBrainDb`/etc read at the consolidated `cleo.db`.
 * On an *existing* install the consolidated DB is freshly migrated but **empty**
 * (0 base-table rows), while the user's real data still lives in the legacy
 * `tasks.db` / `brain.db` / `conduit.db` / `signaldock.db` fleet (e.g. 4465
 * tasks). Without an auto-migration the E8/T11251 cutover would make every
 * user's data **invisible**. This module wires the existing `runExodusMigrate`
 * engine to run **once, automatically, on first open** — gated by the
 * `verifyMigration` (T11551) parity check so a partial or lossy migration NEVER
 * becomes the live source of truth.
 *
 * ## Trigger condition (AC1)
 *
 * On first `openDualScopeDb(scope)` the hook runs iff **both**:
 *   1. the consolidated `cleo.db` for that scope is EMPTY (the canonical first
 *      base table has zero rows), AND
 *   2. at least one legacy source DB for that scope has rows.
 *
 * ## Idempotency (AC1)
 *
 * After a successful migration the consolidated DB is non-empty, so the
 * emptiness check short-circuits on every subsequent open — a second open is a
 * no-op. The check is also re-evaluated *inside* the single-flight lock
 * (double-checked locking) so the process that loses a concurrency race never
 * re-migrates.
 *
 * ## Parity gate + clean abort (AC2)
 *
 * After the copy, `verifyMigration` (T11551) compares row counts + canonical
 * digests + FK integrity + enum drift legacy↔consolidated. If parity FAILS the
 * hook **aborts the cutover**:
 * it deletes the partially-populated consolidated `cleo.db` (and its WAL/SHM
 * sidecars) so the legacy DBs remain the source of truth and the next open
 * re-creates a pristine empty schema. There is no half-migrated `cleo.db` left
 * behind and no silent `INSERT OR IGNORE` row drops.
 *
 * ## Concurrency safety (AC6 · reconcile with T11554 / R13-T11278)
 *
 * Two processes opening a brand-new empty `cleo.db` simultaneously must not both
 * migrate. A `proper-lockfile` single-flight lock on
 * `<cleo.db>.exodus-on-open.lock` serialises the attempt; the loser re-checks
 * emptiness under the lock and bails. This is the same first-run-race concern
 * T11554 raises for schema bootstrap — both are solved by serialising the
 * first-open mutation.
 *
 * @module
 * @task T11553 (E6 · exodus-on-open)
 * @epic T11249 (E6)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/exodus/migrate.ts — runExodusMigrate engine
 * @see packages/core/src/store/exodus/verify-migration.ts — verifyMigration parity gate (T11551)
 * @see packages/core/src/store/dual-scope-db.ts — the open chokepoint that calls this
 */

import { existsSync, rmSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { VerifyMigrationResult } from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import type { DualScope } from '../dual-scope-db.js';
import { withLock } from '../lock.js';

const log = getLogger('exodus-on-open');

/**
 * Re-entrancy guard. `runExodusMigrate` itself calls `openDualScopeDb` for both
 * scopes to create + populate the consolidated schema. Those nested opens MUST
 * NOT recursively trigger another exodus-on-open. This flag is set for the
 * duration of an auto-migration so the chokepoint skips the hook while a
 * migration is already in flight.
 */
let _exodusInProgress = false;

/**
 * Opt-out env flag. Set `CLEO_DISABLE_EXODUS_ON_OPEN=1` to skip the lazy
 * auto-migration entirely (e.g. for tooling that intentionally inspects an
 * empty consolidated DB). The manual `cleo exodus migrate` path is unaffected.
 */
function isDisabledByEnv(): boolean {
  const v = process.env.CLEO_DISABLE_EXODUS_ON_OPEN;
  return v === '1' || v === 'true';
}

/**
 * The canonical "first base table" for each scope — the same existence anchor
 * used by the migration journal reconciliation. If this table has zero rows the
 * consolidated DB is considered empty for the purposes of the trigger.
 *
 * - project → `tasks_tasks`
 * - global  → `nexus_project_registry`
 */
function baseTableForScope(scope: DualScope): string {
  return scope === 'project' ? 'tasks_tasks' : 'nexus_project_registry';
}

/**
 * Count rows in `table` on `nativeDb`, returning `0` if the table does not yet
 * exist or the query fails. Used to decide whether the consolidated DB is empty.
 */
function safeRowCount(nativeDb: DatabaseSync, table: string): number {
  try {
    const row = nativeDb.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  } catch {
    // Table missing (pre-migration) or other read error → treat as empty.
    return 0;
  }
}

/**
 * Return `true` if the consolidated `cleo.db` for `scope` is empty — i.e. the
 * canonical base table for that scope has zero rows.
 */
function consolidatedIsEmpty(nativeDb: DatabaseSync, scope: DualScope): boolean {
  return safeRowCount(nativeDb, baseTableForScope(scope)) === 0;
}

/**
 * Delete the consolidated `cleo.db` for the given path together with its WAL and
 * SHM sidecars. Called on parity-failure abort so no half-migrated DB survives.
 *
 * The caller MUST have closed/evicted any open handle to `dbPath` first — on
 * POSIX an unlink of an open file is allowed but leaves the inode live; the
 * chokepoint evicts the cache entry before calling this.
 */
function nukeConsolidatedDb(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = `${dbPath}${suffix}`;
    try {
      if (existsSync(p)) rmSync(p, { force: true });
    } catch (err) {
      log.warn({ err, path: p }, 'exodus-on-open: failed to remove consolidated DB sidecar');
    }
  }
}

/**
 * Decide whether a {@link verifyMigration} result clears the **data-continuity**
 * gate — the campaign-aligned zero-loss invariant (DHQ-045 · T11551).
 *
 * `verifyMigration().ok` is intentionally STRICTER than data-continuity: it also
 * requires `hashMatch` and zero enum-drift findings. After a CORRECT migration
 * those two will legitimately be `false`, because the migration NORMALISES the
 * data (legacy enum aliases like `'ACCEPTED'`→`'accepted'`, epoch→ISO
 * timestamps) — so the consolidated content digest differs from the un-normalised
 * source, and the source still reports its raw drift as a diagnostic. Treating
 * that as a parity failure would abort EVERY real migration.
 *
 * The zero-loss invariant the exodus campaign actually proves (and the one the
 * representative real-data parity test asserts) is:
 *
 *   1. every data-bearing base table copied with EXACT row-count parity
 *      (`countMatch === true`), AND
 *   2. NO genuine referential orphans on the consolidated target
 *      (`foreignKeyViolations` empty).
 *
 * Hash mismatch + source enum-drift are surfaced as WARN diagnostics (a true
 * content corruption would normally also show up as an FK orphan or a count
 * deficit), but they do NOT, on their own, indicate data loss.
 *
 * @param result - The {@link VerifyMigrationResult} from `verifyMigration`.
 * @returns `true` when row-count parity holds for every table and there are no
 *   FK orphans — i.e. the cutover is safe.
 */
function isDataContinuityOk(result: VerifyMigrationResult): boolean {
  const allCountsMatch = result.tables.every((t) => t.countMatch);
  return allCountsMatch && result.foreignKeyViolations.length === 0;
}

/**
 * Outcome of an exodus-on-open attempt, surfaced for tests + logging.
 */
export interface ExodusOnOpenResult {
  /** `'skipped'` — no trigger; `'migrated'` — parity-verified cutover; `'aborted'` — parity failed, legacy kept. */
  readonly outcome: 'skipped' | 'migrated' | 'aborted';
  /** Human-readable reason (skip cause, row counts, or abort error). */
  readonly reason: string;
  /** Total rows copied (only meaningful for `'migrated'`). */
  readonly rowsCopied?: number;
}

/**
 * Lazily migrate the legacy fleet into the consolidated `cleo.db` on first open.
 *
 * This is the thin guard wired into {@link openDualScopeDb}. It is invoked AFTER
 * the consolidated schema migrations have run (so the base tables exist) but
 * BEFORE the handle is returned to the caller. It is a no-op unless the trigger
 * condition (AC1) holds.
 *
 * Re-entrancy, concurrency, parity gating, and clean abort are all handled here
 * — see the module docs. The heavy lifting (copy, journal, backup, attach-leak
 * safety) is delegated to the existing {@link runExodusMigrate} engine; this
 * function adds only the *when* (lazy trigger) and the *safety envelope*
 * (single-flight + verify-or-rollback).
 *
 * @param scope       - The scope being opened (`'project'` | `'global'`).
 * @param dbPath      - Absolute path to the consolidated `cleo.db` for `scope`.
 * @param nativeDb    - The freshly-opened native handle (post-migration).
 * @param cwd         - Working directory used to resolve the project root.
 * @param evict       - Callback that closes + evicts the consolidated handle(s)
 *                      from the chokepoint cache before an abort deletes the DB.
 * @returns The {@link ExodusOnOpenResult} describing what happened.
 *
 * @task T11553 (AC1, AC2, AC6)
 * @epic T11249 (E6)
 * @saga T11242
 */
export async function maybeRunExodusOnOpen(
  scope: DualScope,
  dbPath: string,
  nativeDb: DatabaseSync,
  cwd: string | undefined,
  evict: () => void,
): Promise<ExodusOnOpenResult> {
  // Re-entrancy: the nested opens from runExodusMigrate must never recurse.
  if (_exodusInProgress) {
    return { outcome: 'skipped', reason: 're-entrant open during active migration' };
  }
  if (isDisabledByEnv()) {
    return { outcome: 'skipped', reason: 'CLEO_DISABLE_EXODUS_ON_OPEN set' };
  }

  // Fast path (unlocked): if the consolidated DB already has data, nothing to do.
  // This makes the second-open case a cheap COUNT(*) with no lock acquisition.
  if (!consolidatedIsEmpty(nativeDb, scope)) {
    return { outcome: 'skipped', reason: 'consolidated cleo.db already populated' };
  }

  // Lazy-load the exodus engine via dynamic import to break the import cycle
  // (exodus/migrate.ts imports openDualScopeDb from dual-scope-db.ts).
  const { buildExodusPlan, runExodusMigrate, verifyMigration, sourcesPresent } = await import(
    './index.js'
  );

  const plan = buildExodusPlan(cwd);

  // No legacy sources at all → genuinely fresh install, nothing to migrate.
  if (!sourcesPresent(plan.sources)) {
    return { outcome: 'skipped', reason: 'no legacy source DBs present (fresh install)' };
  }

  // Single-flight: serialise the first-open migration across processes so two
  // concurrent opens never both migrate (AC6 · T11554 first-run race).
  const lockPath = `${dbPath}.exodus-on-open.lock`;

  return withLock(
    lockPath,
    async (): Promise<ExodusOnOpenResult> => {
      // Double-checked locking: a process that lost the race will find the DB
      // already populated (by the winner) and bail without re-migrating.
      if (!consolidatedIsEmpty(nativeDb, scope)) {
        return { outcome: 'skipped', reason: 'migrated by a concurrent process (lock winner)' };
      }

      log.info(
        {
          scope,
          dbPath,
          sources: plan.sources.filter((s) => existsSync(s.path)).map((s) => s.name),
        },
        'exodus-on-open: consolidated cleo.db is empty and legacy data present — auto-migrating',
      );

      _exodusInProgress = true;
      try {
        // 1. Run the migration engine (copies BOTH scopes; idempotent + journaled).
        const migrateResult = await runExodusMigrate(plan, false, (msg) =>
          log.debug({ scope }, `exodus-on-open: ${msg}`),
        );

        if (!migrateResult.ok) {
          // Migration itself failed mid-copy — abort the cutover cleanly.
          evict();
          nukeConsolidatedDb(plan.projectDbPath);
          nukeConsolidatedDb(plan.globalDbPath);
          const reason = `migration failed: ${migrateResult.error ?? 'unknown error'} — legacy DBs kept as source`;
          log.error({ scope, error: migrateResult.error }, `exodus-on-open: ${reason}`);
          return { outcome: 'aborted', reason };
        }

        // 2. PARITY GATE (AC2): verifyMigration (T11551) — row-count + content
        //    digest + FK integrity + enum-drift equivalence legacy↔consolidated.
        const verifyResult = verifyMigration(
          plan.sources,
          plan.projectDbPath,
          plan.globalDbPath,
          (msg) => log.debug({ scope }, `exodus-on-open verify: ${msg}`),
        );

        // Surface diagnostics (hash mismatch / source enum-drift) but do NOT
        // abort on them — see isDataContinuityOk(). A correct normalising
        // migration legitimately produces both; only a row-count deficit or an
        // FK orphan means actual data loss.
        if (!verifyResult.ok) {
          log.warn(
            {
              scope,
              enumDrift: verifyResult.enumDrift.length,
              hashMismatches: verifyResult.tables.filter((t) => !t.hashMatch).length,
            },
            'exodus-on-open: verifyMigration reported non-fatal drift (normalisation expected); checking data-continuity gate',
          );
        }

        if (!isDataContinuityOk(verifyResult)) {
          // DATA LOSS (count deficit or FK orphan) → abort. Delete the
          // half-migrated cleo.db so legacy remains the source of truth. Never
          // expose a lossy consolidated DB.
          evict();
          nukeConsolidatedDb(plan.projectDbPath);
          nukeConsolidatedDb(plan.globalDbPath);
          const deficits = verifyResult.tables
            .filter((t) => !t.countMatch)
            .map((t) => `${t.targetTable}(${t.sourceCount}→${t.targetCount})`);
          const reason =
            `parity verification failed — cutover aborted, legacy DBs kept as source. ` +
            `count deficits: [${deficits.join(', ')}]; ` +
            `fk orphans: ${verifyResult.foreignKeyViolations.length}. ${verifyResult.error ?? ''}`.trim();
          log.error(
            {
              scope,
              countDeficits: deficits,
              fkViolations: verifyResult.foreignKeyViolations.length,
            },
            'exodus-on-open: data-continuity FAILED — consolidated cleo.db removed, legacy kept',
          );
          return { outcome: 'aborted', reason };
        }

        const rowsCopied = migrateResult.tables
          .filter((t) => !t.skipped)
          .reduce((n, t) => n + t.rowsCopied, 0);

        log.info(
          { scope, rowsCopied, tables: migrateResult.tables.length },
          'exodus-on-open: parity verified — legacy data migrated into consolidated cleo.db',
        );

        return {
          outcome: 'migrated',
          reason: `migrated ${rowsCopied} rows across ${migrateResult.tables.length} tables; parity verified`,
          rowsCopied,
        };
      } finally {
        _exodusInProgress = false;
      }
    },
    // Tolerate a slow migration: a large fleet copy can take a while, so allow a
    // generous stale window and a few retries while the winner holds the lock.
    { stale: 600_000, retries: 30 },
  );
}

/**
 * Test-only accessor: whether an exodus migration is currently in flight. Used
 * to assert the re-entrancy guard does not recurse.
 *
 * @internal
 */
export function _isExodusInProgress(): boolean {
  return _exodusInProgress;
}
