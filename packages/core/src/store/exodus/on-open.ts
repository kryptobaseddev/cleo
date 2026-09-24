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
 * it removes only unchanged rows recorded in the migration's transaction-local
 * receipts. Unrelated rows remain. Changed resources refuse recovery; outcomes
 * identify each target and retain the journal and receipts for inspection.
 * The caller handle stays open. A source transaction is not reported done in
 * the staging journal until COMMIT; only fully successful recovery clears that
 * journal so a retry can re-copy the preserved legacy sources.
 *
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

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { VerifyMigrationResult } from '@cleocode/contracts';
import { getLogger } from '../../logger.js';
import type { DualScope, DualScopeDbHandle } from '../dual-scope-db.js';
import { withLock } from '../lock.js';
import { archiveMigratedSources, hasExodusCompleteMarker } from './archive.js';
import { rollbackExodusReceipts, sealExodusDatabase } from './recovery.js';
import type { ExodusPlan, ExodusRecoveryResult, ExodusScope, LegacyDbDescriptor } from './types.js';

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
 * Stores an explicit `cleo doctor superseded-store --reconcile` is working on
 * in this process, by resolved path (T12355). exodus-on-open must never fire
 * for such a store mid-reconcile: it would migrate and ARCHIVE the very legacy
 * files the reconcile already planned to read ("unable to open database
 * …/.cleo/tasks.db", found by the v2026.9.17 Stage A gate with
 * CLEO_DISABLE_EXODUS_ON_OPEN unset). Scoped to the store and the reconcile's
 * lifetime — never the env var, never other stores.
 */
const _reconcileInProgress = new Map<string, number>();

/**
 * Run `fn` with exodus-on-open suppressed for the store at `dbPath`.
 *
 * Whichever runs first, the two converge: if on-open already migrated (and
 * archived) the legacy files, the reconcile finds no legacy source and reports
 * nothing to do; if the reconcile ran first, the store is populated and on-open
 * skips it. Both place every row in the table the runtime reads.
 *
 * @param dbPath - The project `cleo.db` being reconciled.
 * @param fn - The reconcile.
 * @returns `fn`'s result.
 * @task T12355
 */
export async function withExodusOnOpenSuppressed<T>(
  dbPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(dbPath);
  _reconcileInProgress.set(key, (_reconcileInProgress.get(key) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    const left = (_reconcileInProgress.get(key) ?? 1) - 1;
    if (left <= 0) _reconcileInProgress.delete(key);
    else _reconcileInProgress.set(key, left);
  }
}

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

/** Count persisted rows; only an absent table is empty, never a failed read. */
function safeRowCount(nativeDb: DatabaseSync, table: string): number {
  if (
    !nativeDb
      .prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name=?")
      .get(table)
  )
    return 0;
  const count = nativeDb.prepare(`SELECT COUNT(*) AS n FROM main."${table}"`).get()?.n;
  if (typeof count !== 'number' || !Number.isSafeInteger(count))
    throw new Error(`Cannot assess migration population: ${table}`);
  return count;
}

/**
 * Return `true` if the consolidated `cleo.db` for `scope` is empty — i.e. the
 * canonical base table for that scope has zero rows.
 */
function consolidatedIsEmpty(nativeDb: DatabaseSync, scope: DualScope): boolean {
  return safeRowCount(nativeDb, baseTableForScope(scope)) === 0;
}

/** Stranding warnings already emitted this process, keyed by target path. */
const _strandedWarned = new Set<string>();

/** Log a stranded-data warning once per target per process (every open would repeat it). */
function warnStrandedOnce(dbPath: string, reason: string): void {
  if (_strandedWarned.has(dbPath)) return;
  _strandedWarned.add(dbPath);
  log.warn({ dbPath }, `exodus-on-open: STRANDED LEGACY DATA — ${reason}`);
}

/** The supported remedy for a stranded scope. */
function remedyFor(scope: DualScope): string {
  return scope === 'project'
    ? 'Run `cleo doctor superseded-store --reconcile --dry-run`, then `--reconcile`, to copy it in.'
    : 'Run `cleo doctor exodus-health` and `cleo exodus migrate` to consolidate it.';
}

/**
 * Names of this scope's legacy sources that still hold copyable rows. Only
 * called once the consolidated store is known to be empty.
 */
async function strandedLegacySources(scope: DualScope, cwd: string | undefined): Promise<string[]> {
  const { buildExodusPlan, legacySourcesHoldRows } = await import('./index.js');
  return buildExodusPlan(cwd)
    .sources.filter((s) => s.targetScope === scope && existsSync(s.path))
    .filter((s) => legacySourcesHoldRows([s]))
    .map((s) => s.name);
}

/** Recover only the inserted resources recorded by this staging operation. */
async function rollbackBothScopes(plan: ExodusPlan): Promise<ExodusRecoveryResult> {
  const { getDualScopeNativeDb, openDualScopeDbAtPath } = await import('../dual-scope-db.js');
  const scopes: ExodusRecoveryResult['scopes'] = [];
  for (const scope of ['project', 'global'] as const) {
    const dbPath = scope === 'project' ? plan.projectDbPath : plan.globalDbPath;
    let handle: DualScopeDbHandle | null = null;
    try {
      handle =
        scope === 'project'
          ? await openDualScopeDbAtPath('project', dbPath, undefined, { dedicated: true })
          : await openDualScopeDbAtPath('global', dbPath, undefined, { dedicated: true });
      const native = getDualScopeNativeDb(handle);
      const rowsReverted = rollbackExodusReceipts(native, plan.stagingDir);
      scopes.push({ scope, dbPath, status: 'rolled_back', rowsReverted });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      scopes.push({ scope, dbPath, status: 'failed', rowsReverted: 0, error: message });
      log.error(
        { scope, dbPath, error },
        'exodus-on-open: guarded recovery incomplete; retained journal and receipts',
      );
    } finally {
      handle?.close();
    }
  }
  return {
    operationId: plan.stagingDir,
    complete: scopes.every((entry) => entry.status === 'rolled_back'),
    scopes,
  };
}

/** Seal only scopes whose sources were verified, without disturbing other cutovers. */
async function sealTargets(
  plan: ExodusPlan,
  consumed: readonly LegacyDbDescriptor[],
): Promise<Partial<Record<ExodusScope, string>>> {
  const { getDualScopeNativeDb, openDualScopeDbAtPath } = await import('../dual-scope-db.js');
  const identities: Partial<Record<ExodusScope, string>> = {};
  for (const scope of ['project', 'global'] as const) {
    if (!consumed.some((source) => source.targetScope === scope)) continue;
    const path = scope === 'project' ? plan.projectDbPath : plan.globalDbPath;
    const handle =
      scope === 'project'
        ? await openDualScopeDbAtPath('project', path, undefined, { dedicated: true })
        : await openDualScopeDbAtPath('global', path, undefined, { dedicated: true });
    try {
      identities[scope] = sealExodusDatabase(getDualScopeNativeDb(handle));
    } finally {
      handle.close();
    }
  }
  return identities;
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
  /** Per-target guarded recovery outcomes, including retained conflicts. */
  readonly recovery?: ExodusRecoveryResult;
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
 * On abort, dedicated target handles revert unchanged inserted rows proven by
 * receipts. Conflicts are reported and retained; the caller handle stays open.
 *
 * @param scope - The scope being opened.
 * @param dbPath - Explicit consolidated database target for this scope.
 * @param nativeDb - Fresh caller handle, never closed by recovery.
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
  try {
    return await runExodusOnOpen(scope, dbPath, nativeDb, cwd);
  } catch (error) {
    return {
      outcome: 'aborted',
      reason: `migration assessment failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Run the guarded assessment, copy and recovery behind the explicit abort boundary. */
async function runExodusOnOpen(
  scope: DualScope,
  dbPath: string,
  nativeDb: DatabaseSync,
  cwd: string | undefined,
): Promise<ExodusOnOpenResult> {
  // Re-entrancy: the nested opens from runExodusMigrate must never recurse.
  if (_exodusInProgress) {
    return { outcome: 'skipped', reason: 're-entrant open during active migration' };
  }
  if (_reconcileInProgress.has(resolve(dbPath))) {
    return {
      outcome: 'skipped',
      reason: 'an explicit superseded-store reconcile of this store is in progress',
    };
  }
  // Fast path (unlocked): if the consolidated DB already has data, nothing to do.
  // This makes the second-open case a cheap COUNT(*) with no lock acquisition.
  if (!consolidatedIsEmpty(nativeDb, scope)) {
    return { outcome: 'skipped', reason: 'consolidated cleo.db already populated' };
  }

  // Kill-switch (T12319): honoured, but never SILENTLY. Exported machine-wide
  // as an incident stopgap on 2026-06-04, it left ~21 projects running on an
  // empty cleo.db while their legacy stores held every task — and nothing said
  // so. Skip as asked, but when the skip strands real rows, say so loudly.
  if (isDisabledByEnv()) {
    const stranded = await strandedLegacySources(scope, cwd);
    if (stranded.length === 0) {
      return { outcome: 'skipped', reason: 'CLEO_DISABLE_EXODUS_ON_OPEN set' };
    }
    const reason =
      `CLEO_DISABLE_EXODUS_ON_OPEN set while the consolidated ${scope} cleo.db is EMPTY and ` +
      `legacy ${stranded.join(', ')} still hold rows — CLEO is running WITHOUT that data. ` +
      remedyFor(scope);
    warnStrandedOnce(dbPath, reason);
    return { outcome: 'skipped', reason };
  }

  // Completion-marker gate (T11777): once this scope's cutover is recorded, the
  // migration has already happened and the legacy sources have been archived.
  // Gate on the committed MARKER rather than (only) the source-file existsSync,
  // so a re-appearing or stranded legacy DB can NEVER re-arm exodus-on-open even
  // if the consolidated base table momentarily reads empty (DHQ-052 · T11662).
  //
  // T12319: the marker must never HIDE data, though. An empty consolidated
  // store beside legacy files that still hold rows contradicts the marker's own
  // claim, so this is an abort (writes refuse via `assertWriteDurable`), not a
  // skip — re-arming stays forbidden, and the operator gets the explicit remedy.
  if (hasExodusCompleteMarker(scope, cwd, dbPath, nativeDb)) {
    const stranded = await strandedLegacySources(scope, cwd);
    if (stranded.length > 0) {
      const reason =
        `exodus completion marker claims the ${scope} scope migrated, but its cleo.db is EMPTY ` +
        `while legacy ${stranded.join(', ')} still hold rows. ${remedyFor(scope)}`;
      warnStrandedOnce(dbPath, reason);
      return { outcome: 'aborted', reason };
    }
    return {
      outcome: 'skipped',
      reason: 'exodus completion marker present — scope already migrated (cutover sealed)',
    };
  }

  // Lazy-load the exodus engine via dynamic import to break the import cycle
  // (exodus/migrate.ts imports openDualScopeDb from dual-scope-db.ts).
  const { buildExodusPlan, runExodusMigrate, verifyMigration, clearExodusJournal } = await import(
    './index.js'
  );

  const plan = buildExodusPlan(cwd);
  const plannedTarget = scope === 'project' ? plan.projectDbPath : plan.globalDbPath;
  if (resolve(plannedTarget) !== resolve(dbPath)) {
    return {
      outcome: 'aborted',
      reason: `migration plan target ${plannedTarget} does not match opened database ${dbPath}; no migration applied`,
    };
  }

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
      const bareScratch = mkdtempSync(join(tmpdir(), 'cleo-exodus-bare-'));
      try {
        // 1. Run the migration engine (copies BOTH scopes; idempotent + journaled).
        // T12355: land every row where the RUNTIME reads it — the same targets
        // `cleo doctor superseded-store --reconcile` uses — creating the
        // runtime-bound tables first, since several exist only once the
        // tasks-domain lineage has run.
        const { buildRuntimeTargetResolver } = await import('./runtime-targets.js');
        const resolveTarget = await buildRuntimeTargetResolver();
        // The same unmigrated-bare-family source the reconcile reads, so the two
        // converge whichever runs first. Never archived: it is not a legacy file.
        const { unmigratedBareSources } = await import('./reconcile.js');
        const bare =
          scope === 'project'
            ? await unmigratedBareSources(
                dbPath,
                resolveTarget,
                plan.sources.find((s) => s.name === 'tasks' && existsSync(s.path))?.path,
                bareScratch,
              )
            : { first: [], last: [] };
        const migratePlan = { ...plan, sources: [...bare.first, ...plan.sources, ...bare.last] };
        const migrateResult = await runExodusMigrate(
          migratePlan,
          false,
          (msg) => log.debug({ scope }, `exodus-on-open: ${msg}`),
          { resolveTarget, ensureRuntimeTables: true },
        );

        if (!migrateResult.ok) {
          // Revert only migration-owned rows; retain conflicts and their evidence.
          const recovery = await rollbackBothScopes(plan);
          // T11572: invalidate the journal so the NEXT open re-copies instead of
          // resuming a half-done journal against the now-empty target (abort loop).
          if (recovery.complete) clearExodusJournal(migrateResult.stagingDir);
          const reason = `migration failed: ${migrateResult.error ?? 'unknown error'} — legacy DBs kept as source`;
          log.error({ scope, error: migrateResult.error }, `exodus-on-open: ${reason}`);
          return {
            outcome: 'aborted',
            reason: recovery.complete
              ? reason
              : `${reason}; recovery incomplete — journal and receipts retained`,
            recovery,
          };
        }

        // 2. PARITY GATE (AC2): verifyMigration (T11551) — row-count + content
        //    digest + FK integrity + enum-drift equivalence legacy↔consolidated.
        const verifyResult = verifyMigration(
          migratePlan.sources,
          plan.projectDbPath,
          plan.globalDbPath,
          (msg) => log.debug({ scope }, `exodus-on-open verify: ${msg}`),
          resolveTarget,
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
          // A parity failure invokes the same guarded, resource-scoped recovery.
          const recovery = await rollbackBothScopes(plan);
          // T11572: invalidate the journal so a retry re-copies (see above).
          if (recovery.complete) clearExodusJournal(plan.stagingDir);
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
            'exodus-on-open: data-continuity FAILED — guarded recovery attempted; legacy kept',
          );
          return {
            outcome: 'aborted',
            reason: recovery.complete
              ? reason
              : `${reason}; recovery incomplete — journal and receipts retained`,
            recovery,
          };
        }

        const rowsCopied = migrateResult.tables
          .filter((t) => !t.skipped)
          .reduce((n, t) => n + t.rowsCopied, 0);

        log.info(
          { scope, rowsCopied, tables: migrateResult.tables.length },
          'exodus-on-open: parity verified — legacy data migrated into consolidated cleo.db',
        );

        // T11777: parity passed — ARCHIVE the consumed legacy sources (+ sidecars)
        // into the per-scope `_archive/` dir and write a committed completion
        // marker. `runExodusMigrate` consolidates BOTH scopes once triggered, so
        // archive every source that was present at migration time (the validated,
        // consumed fleet). Reversible (move, never delete) + idempotent. A failure
        // here must NOT undo a verified migration — the cutover already succeeded —
        // so it is logged but does not flip the outcome to 'aborted'.
        try {
          const consumed = plan.sources.filter((s) => existsSync(s.path));
          const identities = await sealTargets(plan, consumed);
          const archiveResult = archiveMigratedSources(consumed, cwd, plan, identities);
          log.info(
            {
              scope,
              archived: archiveResult.sources.filter((s) => s.action === 'archived').length,
              markersWritten: archiveResult.markersWritten,
            },
            'exodus-on-open: archived legacy sources + sealed completion marker(s)',
          );
        } catch (err) {
          log.error(
            { err, scope },
            'exodus-on-open: post-migration archive/marker step failed (migration itself succeeded — legacy DBs left in place, will be re-checked by `cleo doctor exodus-residue`)',
          );
        }

        return {
          outcome: 'migrated',
          reason: `migrated ${rowsCopied} rows across ${migrateResult.tables.length} tables; parity verified`,
          rowsCopied,
        };
      } catch (error) {
        const recovery = await rollbackBothScopes(plan);
        if (recovery.complete) clearExodusJournal(plan.stagingDir);
        const message = error instanceof Error ? error.message : String(error);
        return {
          outcome: 'aborted',
          reason: `migration verification failed: ${message}; ${recovery.complete ? 'owned rows reverted' : 'recovery incomplete — journal and receipts retained'}`,
          recovery,
        };
      } finally {
        _exodusInProgress = false;
        rmSync(bareScratch, { recursive: true, force: true });
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
