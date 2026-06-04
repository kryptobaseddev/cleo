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
 * digests + FK integrity + enum drift legacy↔consolidated. The data-continuity
 * gate is **row-count parity + zero migration-INTRODUCED FK orphans** (hash/enum
 * drift are the expected normalisation diagnostics, and pre-existing SOURCE FK
 * orphans are tolerated as zero-loss — see {@link isDataContinuityOk}). If a
 * genuine deficit/introduced-orphan is detected the hook **aborts the cutover**:
 * it rolls the half-migrated consolidated tables back to EMPTY (`DELETE FROM`
 * every user table — see {@link rollbackConsolidatedToEmpty}) so the legacy DBs
 * remain the source of truth, no half-migrated `cleo.db` is exposed, and there
 * are no silent `INSERT OR IGNORE` row drops. The file is never unlinked; the
 * chokepoint re-opens a fresh handle afterwards (the migrate engine closes the
 * handles it opened, so the rollback re-opens the scope before truncating it).
 *
 * ## Retry correctness — journal invalidation on abort (T11572)
 *
 * `runExodusMigrate` is resumable: it journals each table `done` and SKIPS
 * already-`done` tables on a re-run. On abort we truncate the consolidated rows
 * back to empty, so a stale `done` journal would make the next open re-trigger
 * (target empty), copy NOTHING (journal says done), re-verify the still-empty
 * target, and re-abort — a permanent loop. The abort path therefore also calls
 * `clearExodusJournal(plan.stagingDir)` so a post-abort retry RE-COPIES from
 * scratch.
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

import { existsSync } from 'node:fs';
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
 * Roll a half-migrated consolidated `cleo.db` back to EMPTY on the given native
 * handle — without deleting the file.
 *
 * Called on a parity-failure abort. As of T11782 (FIX D) the handle passed here
 * is a DEDICATED, NON-cached connection opened by {@link rollbackBothScopes}, NOT
 * the cached caller handle. This is critical: a scope-wide `DELETE FROM` on the
 * CALLER's connection would roll back any concurrent task INSERT (`tasks.add`)
 * issued on that same connection during the migrate window. Truncating on an
 * isolated connection limits the blast radius to the migration's own writes —
 * the caller's concurrent INSERT on its own connection survives. We `DELETE FROM`
 * every user table inside a single transaction with foreign keys OFF, restoring
 * the post-migration *empty* schema, so the legacy DBs remain the source of
 * truth — exactly the AC2 "no half-migrated cleo.db" contract. The file is never
 * unlinked; the caller's (separate) cached handle stays valid and sees the
 * committed empty state on its next read (WAL).
 *
 * The schema (tables, indexes, drizzle journal) is preserved; only data rows are
 * removed. Idempotent and best-effort: a failure to clear one table is logged
 * but does not throw (the next open's emptiness check still sees a populated
 * base table and could re-attempt, which is acceptable — it will re-abort).
 *
 * @param nativeDb - The dedicated consolidated connection to truncate.
 * @param scope    - Scope label for logging.
 */
function rollbackConsolidatedToEmpty(nativeDb: DatabaseSync, scope: DualScope): void {
  let userTables: string[] = [];
  try {
    userTables = (
      nativeDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
  } catch (err) {
    log.error({ err, scope }, 'exodus-on-open: failed to enumerate tables for rollback');
    return;
  }

  try {
    nativeDb.exec('PRAGMA foreign_keys = OFF');
    nativeDb.exec('BEGIN');
    for (const table of userTables) {
      try {
        nativeDb.exec(`DELETE FROM "${table}"`);
      } catch (err) {
        log.warn({ err, table, scope }, 'exodus-on-open: failed to clear table during rollback');
      }
    }
    nativeDb.exec('COMMIT');
  } catch (err) {
    try {
      nativeDb.exec('ROLLBACK');
    } catch {
      // ignore — nothing to roll back
    }
    log.error({ err, scope }, 'exodus-on-open: rollback transaction failed');
  } finally {
    try {
      nativeDb.exec('PRAGMA foreign_keys = ON');
    } catch {
      // ignore
    }
  }
}

/**
 * Roll BOTH consolidated scopes back to empty after a failed auto-migration.
 *
 * ## Connection isolation (T11782 · FIX D)
 *
 * The rollback opens each scope on a DEDICATED, NON-cached connection (a second
 * SQLite handle to the same file — WAL allows it) and truncates THAT, NEVER the
 * cached caller handle. This is the load-bearing half of the write-reliability
 * fix: a scope-wide `DELETE FROM`/`BEGIN…COMMIT` on the CALLER's shared
 * connection would sweep away any concurrent task INSERT (`tasks.add`) issued on
 * that same connection during the migrate window. Truncating on an isolated
 * connection means the abort can only ever clear the migration's own writes; a
 * caller's concurrent INSERT on its own connection is physically outside this
 * rollback's transaction and survives.
 *
 * `runExodusMigrate` already closed its dedicated migrate connections by the
 * time we get here, so the rows it wrote are still on disk; we re-open a fresh
 * dedicated connection per scope and truncate. `_exodusInProgress` is still
 * `true`, so these opens do not recurse into the hook (dedicated opens never arm
 * exodus-on-open anyway).
 *
 * @param scope         - The scope being opened (logging context only; both
 *   scopes are cleared because `runExodusMigrate` populates both).
 * @param projectDbPath - Absolute path to the consolidated project `cleo.db`.
 * @param globalDbPath  - Absolute path to the consolidated global `cleo.db`.
 */
async function rollbackBothScopes(
  scope: DualScope,
  projectDbPath: string,
  globalDbPath: string,
): Promise<void> {
  const { openDualScopeDbAtPath } = await import('../dual-scope-db.js');
  for (const s of ['project', 'global'] as const) {
    const path = s === 'project' ? projectDbPath : globalDbPath;
    let handle: { db: unknown; close(): void } | null = null;
    try {
      handle =
        s === 'project'
          ? await openDualScopeDbAtPath('project', path, undefined, { dedicated: true })
          : await openDualScopeDbAtPath('global', path, undefined, { dedicated: true });
      const native = (handle.db as { $client?: DatabaseSync }).$client;
      if (native) {
        rollbackConsolidatedToEmpty(native, s);
      }
    } catch (err) {
      log.warn(
        { err, scope: s, openingScope: scope },
        'exodus-on-open: could not roll back scope (best-effort)',
      );
    } finally {
      // Close the dedicated rollback connection so it does not leak a descriptor.
      try {
        handle?.close();
      } catch {
        // ignore double-close
      }
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
 *   1. every data-bearing base table copied with NO ROW DEFICIT
 *      (`targetCount >= sourceCount` — you cannot LOSE a row you have MORE of),
 *      AND
 *   2. NO referential orphans the migration INTRODUCED on the consolidated
 *      target (`introducedForeignKeyViolations` empty).
 *
 * ## A row SURPLUS is NOT data loss (T11577)
 *
 * Data loss means rows are MISSING: `targetCount < sourceCount` (a DEFICIT).
 * A SURPLUS (`targetCount > sourceCount`) cannot be loss — every source row is
 * still present, plus extra. The canonical benign surplus is the migration's
 * OWN audit trail: `runExodusMigrate` opens the nexus registry, whose
 * `writeNexusAudit` (`nexus/registry.ts`) appends rows to `nexus_audit_log`
 * DURING the migrating open, so the consolidated `nexus_audit_log` legitimately
 * has a few MORE rows than the legacy source (e.g. 161923 → 161926). Gating on
 * exact `countMatch` (`source === target`) wrongly aborts the cutover on that
 * append. The gate therefore fails ONLY on a genuine DEFICIT; a surplus is
 * tolerated and logged as a WARN (with the table + delta) so it stays visible
 * and a double-copy on a non-append table could still be spotted by an operator.
 * Deficits are NEVER tolerated — that is the real data-loss class.
 *
 * ## Pre-existing source orphans are tolerated (T11572)
 *
 * A legacy source DB can already contain referential orphans (e.g. a
 * `tasks_task_relations` row pointing at a task that was deleted long before the
 * migration). Those rows copy through faithfully — that is ZERO loss, not a
 * migration defect — so they appear on BOTH sides and `verifyMigration`
 * classifies them as `preExistingForeignKeyViolations`. Gating on the *total*
 * orphan set (`foreignKeyViolations`) would permanently abort every real cutover
 * over a defect the data already had. The gate therefore fails ONLY on
 * `introducedForeignKeyViolations` — orphans present on the target that the
 * source did not have (i.e. the migration dropped a parent row). Pre-existing
 * orphans are logged as a WARN for a data-hygiene follow-up.
 *
 * Hash mismatch + source enum-drift are surfaced as WARN diagnostics (a true
 * content corruption would normally also show up as an introduced FK orphan or a
 * count deficit), but they do NOT, on their own, indicate data loss.
 *
 * @param result - The {@link VerifyMigrationResult} from `verifyMigration`.
 * @returns `true` when NO base table has a row DEFICIT (`targetCount <
 *   sourceCount`) and the migration introduced no new FK orphans — i.e. the
 *   cutover is safe. A surplus (`targetCount > sourceCount`) is tolerated.
 *
 * @task T11577 (deficit-only gate — tolerate benign migration-time surplus)
 */
export function isDataContinuityOk(result: VerifyMigrationResult): boolean {
  // A DEFICIT (target has FEWER rows than source) is the genuine data-loss
  // class — abort. A SURPLUS (target has MORE, e.g. nexus_audit_log gaining the
  // migration's own audit writes) is NOT loss; tolerate it but log a WARN so the
  // table + delta stay visible (a surplus on a non-append table could hint at a
  // double-copy worth an operator's attention).
  const deficits = result.tables.filter((t) => t.targetCount < t.sourceCount);
  const surpluses = result.tables.filter((t) => t.targetCount > t.sourceCount);
  if (surpluses.length > 0) {
    log.warn(
      {
        surpluses: surpluses.map((t) => ({
          table: t.targetTable,
          scope: t.scope,
          source: t.sourceCount,
          target: t.targetCount,
          delta: t.targetCount - t.sourceCount,
        })),
      },
      `exodus-on-open: ${surpluses.length} table(s) have MORE rows in target than source ` +
        `(row surplus — NOT data loss, tolerated; e.g. migration-time nexus_audit_log writes). ` +
        `Verify none is an unexpected double-copy on a non-append table.`,
    );
  }
  return deficits.length === 0 && result.introducedForeignKeyViolations.length === 0;
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
 * On a parity-failure abort the migration's writes are rolled back IN PLACE on
 * the caller's live handle (see {@link rollbackConsolidatedToEmpty}) — the
 * handle is never closed and the file is never deleted, so the chokepoint caller
 * (`getBrainDb`/`ensureConduitDb`/…) keeps a valid, empty `cleo.db` and the
 * legacy DBs remain the source of truth.
 *
 * @param scope       - The scope being opened (`'project'` | `'global'`).
 * @param dbPath      - Absolute path to the consolidated `cleo.db` for `scope`.
 * @param nativeDb    - The freshly-opened native handle (post-migration). This is
 *                      the SAME cached handle `runExodusMigrate` writes through,
 *                      so the rollback truncates it in place rather than deleting.
 * @param cwd         - Working directory used to resolve the project root.
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
  const { buildExodusPlan, runExodusMigrate, verifyMigration, clearExodusJournal } = await import(
    './index.js'
  );

  const plan = buildExodusPlan(cwd);

  // Trigger ONLY on sources that belong to the SCOPE being opened. A
  // project-scope open must not fire because a GLOBAL legacy DB (e.g.
  // signaldock.db) happens to exist — that would (a) wrongly migrate global
  // data on a project read and (b) collide with the legacy signaldock→conduit
  // migration, which legitimately opens an empty project `cleo.db` while a
  // global signaldock.db is present. The migration engine still consolidates
  // BOTH scopes once triggered; this gate only decides WHEN to fire.
  const scopeSources = plan.sources.filter((s) => s.targetScope === scope);
  if (!scopeSources.some((s) => existsSync(s.path))) {
    return {
      outcome: 'skipped',
      reason: `no legacy ${scope}-scope source DBs present (fresh install or cross-scope-only)`,
    };
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
          // Migration itself failed mid-copy — abort the cutover cleanly by
          // rolling the consolidated tables back to empty on a DEDICATED
          // connection (T11782 FIX D — caller's concurrent writes survive; legacy
          // DBs remain the source of truth).
          await rollbackBothScopes(scope, plan.projectDbPath, plan.globalDbPath);
          // T11572: invalidate the journal so the NEXT open re-copies instead of
          // resuming a half-done journal against the now-empty target (abort loop).
          clearExodusJournal(migrateResult.stagingDir);
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
          // DATA LOSS (count deficit or FK orphan) → abort. Roll the half-migrated
          // consolidated tables back to EMPTY on a DEDICATED connection (T11782
          // FIX D) so legacy remains the source of truth AND any concurrent caller
          // INSERT on its own connection survives. Never expose a lossy
          // consolidated DB; never close the caller's handle.
          await rollbackBothScopes(scope, plan.projectDbPath, plan.globalDbPath);
          // T11572: invalidate the journal so a retry re-copies (see above).
          clearExodusJournal(plan.stagingDir);
          // T11577: report only genuine DEFICITS (target < source) — a surplus
          // is tolerated by isDataContinuityOk() and must not appear as a cause.
          const deficits = verifyResult.tables
            .filter((t) => t.targetCount < t.sourceCount)
            .map((t) => `${t.targetTable}(${t.sourceCount}→${t.targetCount})`);
          const reason =
            `parity verification failed — cutover aborted, legacy DBs kept as source. ` +
            `count deficits: [${deficits.join(', ')}]; ` +
            `INTRODUCED fk orphans: ${verifyResult.introducedForeignKeyViolations.length} ` +
            `(pre-existing source orphans tolerated: ${verifyResult.preExistingForeignKeyViolations.length}). ` +
            `${verifyResult.error ?? ''}`.trim();
          log.error(
            {
              scope,
              countDeficits: deficits,
              introducedFkViolations: verifyResult.introducedForeignKeyViolations.length,
              preExistingFkViolations: verifyResult.preExistingForeignKeyViolations.length,
            },
            'exodus-on-open: data-continuity FAILED — consolidated cleo.db rolled back to empty, legacy kept',
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
