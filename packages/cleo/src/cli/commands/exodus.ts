/**
 * `cleo exodus` — migrate legacy multi-DB fleet to the consolidated dual-scope
 * `cleo.db` (SG-DB-SUBSTRATE-V2 · D1″ lifecycle).
 *
 * ## Subcommands (AC3)
 *
 *   cleo exodus migrate   — export legacy DBs → import into consolidated cleo.db
 *   cleo exodus verify    — equivalence check: legacy sources vs consolidated target
 *   cleo exodus status    — show migration progress / staging state
 *
 * ## Source layout (AC2 — 6 legacy DBs)
 *
 * Project-tier (under `<project>/.cleo/`):
 *   - tasks.db · brain.db · conduit.db
 *
 * Global-tier (under `$XDG_DATA_HOME/cleo/`):
 *   - nexus.db · signaldock.db · skills.db
 *
 * ## Target
 *
 *   <project>/.cleo/cleo.db  — consolidated project-scope
 *   $XDG_DATA_HOME/cleo/cleo.db — consolidated global-scope
 *
 * @deprecated AC11 — this subcommand is intentionally transitional.
 *   Mark as deprecated cutover+1 major; removed cutover+2 major.
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 */

import { existsSync } from 'node:fs';
import { ExitCode } from '@cleocode/contracts';
import { resolveDualScopeDbPath } from '@cleocode/core/store/dual-scope-db.js';
import {
  archiveMigratedSources,
  buildExodusPlan,
  runExodusMigrate,
  runExodusStatus,
  runExodusVerify,
  sourcesPresent,
  verifyMigration,
} from '@cleocode/core/store/exodus/index.js';
import { isDataContinuityOk } from '@cleocode/core/store/exodus/on-open.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { isSubCommandDispatch } from '../lib/subcommand-guard.js';
import { cliError, cliOutput, humanInfo } from '../renderers/index.js';

// ---------------------------------------------------------------------------
// Human-readable helpers
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// migrate subcommand
// ---------------------------------------------------------------------------

/**
 * `cleo exodus migrate` — perform the full migration.
 *
 * Steps:
 *   1. Disk pre-flight (AC8): verify ≥3× source size available.
 *   2. Back up source DBs to `.cleo/exodus-staging-<iso>/` (AC5).
 *   3. Open consolidated `cleo.db` (project + global) via chokepoint (AC4).
 *   4. BEGIN … COMMIT per scope; partial failure rolls back (AC6).
 *   5. Per-table journal written atomically after each copy (AC5).
 *
 * @task T11248 (AC2, AC4, AC5, AC6, AC8, AC9)
 */
const migrateSubCommand = defineCommand({
  meta: {
    name: 'migrate',
    description: 'Migrate legacy multi-DB fleet into consolidated dual-scope cleo.db',
  },
  args: {
    'dry-run': {
      type: 'boolean',
      description: 'Preview migration plan without writing anything',
      default: false,
    },
    'force-cross-version': {
      type: 'boolean',
      description: 'Skip schema-version guard (AC9 — use with care)',
      default: false,
    },
  },
  async run({ args }) {
    const dryRun = args['dry-run'] === true;
    const forceCrossVersion = args['force-cross-version'] === true;

    const plan = buildExodusPlan(process.cwd());

    // Disk pre-flight summary
    humanInfo(`Exodus migration plan:`);
    humanInfo(
      `  Source DBs (${plan.sources.length} total, ${fmtBytes(plan.totalSourceBytes)} combined):`,
    );
    for (const s of plan.sources) {
      humanInfo(`    [${s.targetScope.padEnd(7)}] ${s.name.padEnd(20)} ${s.path}`);
    }
    humanInfo(`  Target project cleo.db: ${plan.projectDbPath}`);
    humanInfo(`  Target global  cleo.db: ${plan.globalDbPath}`);
    humanInfo(`  Available disk: ${fmtBytes(plan.availableBytes)}`);
    humanInfo(
      `  Required (1.2× largest ${fmtBytes(plan.largestSourceBytes)} + consolidated): ${fmtBytes(plan.requiredBytes)}`,
    );
    humanInfo(`  Disk pre-flight: ${plan.diskPreflight ? 'PASS' : 'FAIL'}`);

    if (plan.resumeFromStaging) {
      humanInfo(`  Resuming from existing staging: ${plan.stagingDir}`);
    }

    if (dryRun) {
      cliOutput(
        {
          kind: 'generic',
          dryRun: true,
          plan: {
            sources: plan.sources.map((s) => ({
              name: s.name,
              path: s.path,
              targetScope: s.targetScope,
            })),
            totalSourceBytes: plan.totalSourceBytes,
            largestSourceBytes: plan.largestSourceBytes,
            requiredBytes: plan.requiredBytes,
            availableBytes: plan.availableBytes,
            diskPreflight: plan.diskPreflight,
            stagingDir: plan.stagingDir,
            resumeFromStaging: plan.resumeFromStaging,
            projectDbPath: plan.projectDbPath,
            globalDbPath: plan.globalDbPath,
          },
        },
        { command: 'exodus migrate' },
      );
      return;
    }

    if (!sourcesPresent(plan.sources)) {
      cliError(
        'No legacy source DBs found. Nothing to migrate.',
        ExitCode.NOT_FOUND,
        { name: 'E_NO_SOURCES' },
        { operation: 'exodus.migrate' },
      );
      process.exitCode = ExitCode.NOT_FOUND;
      return;
    }

    if (!plan.diskPreflight) {
      const shortfall = Math.max(0, plan.requiredBytes - plan.availableBytes);
      cliError(
        `Insufficient disk space for exodus. Need ≥${fmtBytes(plan.requiredBytes)} ` +
          `(≈1.2× largest source ${fmtBytes(plan.largestSourceBytes)} + consolidated estimate ` +
          `${fmtBytes(plan.totalSourceBytes)}), have ${fmtBytes(plan.availableBytes)} — ` +
          `${fmtBytes(shortfall)} short. Free up space (e.g. \`cleo backup prune\`) or move .cleo/ to a larger volume.`,
        ExitCode.VALIDATION_ERROR,
        { name: 'E_DISK_PREFLIGHT_FAIL' },
        { operation: 'exodus.migrate' },
      );
      process.exitCode = ExitCode.VALIDATION_ERROR;
      return;
    }

    humanInfo('Starting migration…');
    const result = await runExodusMigrate(plan, forceCrossVersion, (msg) => humanInfo(`  ${msg}`));

    if (!result.ok) {
      cliError(
        result.error ?? 'Migration failed',
        ExitCode.GENERAL_ERROR,
        { name: 'E_EXODUS_MIGRATE_FAILED' },
        { operation: 'exodus.migrate' },
      );
      process.exitCode = ExitCode.GENERAL_ERROR;
      return;
    }

    const copied = result.tables.filter((t) => !t.skipped).reduce((n, t) => n + t.rowsCopied, 0);
    const skipped = result.tables.filter((t) => t.skipped).length;

    // T11777: ARCHIVE the consumed legacy sources + write a completion marker —
    // but ONLY after the SAME lossless validation the on-open path uses
    // (verifyMigration + isDataContinuityOk: row-count parity, no INTRODUCED FK
    // orphans). Never blind-move a source whose parity did not pass.
    const verifyResult = verifyMigration(
      plan.sources,
      plan.projectDbPath,
      plan.globalDbPath,
      (msg) => humanInfo(`  verify: ${msg}`),
    );
    let archived: string[] = [];
    if (isDataContinuityOk(verifyResult)) {
      const consumed = plan.sources.filter((s) => existsSync(s.path));
      const archiveResult = archiveMigratedSources(consumed, process.cwd());
      archived = archiveResult.sources.filter((s) => s.action === 'archived').map((s) => s.name);
      humanInfo(
        `  Archived ${archived.length} legacy source DB(s) → _archive/ and sealed completion marker(s): ${archiveResult.markersWritten.join(', ')}`,
      );
    } else {
      humanInfo(
        '  Parity validation did NOT pass — legacy sources LEFT IN PLACE (not archived). Run `cleo exodus verify` to inspect.',
      );
    }

    cliOutput(
      {
        kind: 'generic',
        ok: true,
        summary: {
          tablesProcessed: result.tables.length,
          rowsCopied: copied,
          tablesSkipped: skipped,
          stagingDir: result.stagingDir,
          backupCount: result.backupPaths.length,
          archivedSources: archived,
          archived: archived.length > 0,
        },
        tables: result.tables,
      },
      {
        command: 'exodus migrate',
        message: `Migration complete. ${result.tables.length} tables processed, ${copied} rows copied.`,
      },
    );
  },
});

// ---------------------------------------------------------------------------
// verify subcommand
// ---------------------------------------------------------------------------

/**
 * `cleo exodus verify` — equivalence check between source legacy DBs and the
 * consolidated target.
 *
 * Checks COUNT(*) parity and ordered canonical-JSON SHA-256 digest per table.
 *
 * @task T11248 (AC7)
 */
const verifySubCommand = defineCommand({
  meta: {
    name: 'verify',
    description: 'Verify row-level equivalence between legacy DBs and consolidated cleo.db',
  },
  args: {
    'show-passing': {
      type: 'boolean',
      description: 'Include passing tables in human output (default: failures only)',
      default: false,
    },
  },
  run({ args }) {
    const showPassing = args['show-passing'] === true;
    const plan = buildExodusPlan(process.cwd());
    const projectDbPath = resolveDualScopeDbPath('project', process.cwd());
    const globalDbPath = resolveDualScopeDbPath('global');

    humanInfo('Running equivalence verification…');
    const result = runExodusVerify(plan.sources, projectDbPath, globalDbPath, (msg) =>
      humanInfo(`  ${msg}`),
    );

    if (!result.ok && result.error) {
      cliError(
        result.error,
        ExitCode.GENERAL_ERROR,
        { name: 'E_EXODUS_VERIFY_FAILED' },
        { operation: 'exodus.verify' },
      );
      process.exitCode = ExitCode.GENERAL_ERROR;
      return;
    }

    const failures = result.tables.filter((t) => !t.countMatch || !t.hashMatch);
    const passing = result.tables.filter((t) => t.countMatch && t.hashMatch);

    if (failures.length > 0) {
      humanInfo(`\nFailed tables (${failures.length}):`);
      for (const t of failures) {
        humanInfo(
          `  FAIL [${t.scope}] ${t.tableName}: source=${t.sourceCount}, target=${t.targetCount}, hashMatch=${t.hashMatch}`,
        );
      }
    }

    if (showPassing && passing.length > 0) {
      humanInfo(`\nPassing tables (${passing.length}):`);
      for (const t of passing) {
        humanInfo(`  OK   [${t.scope}] ${t.tableName}: ${t.sourceCount} rows`);
      }
    }

    cliOutput(
      {
        kind: 'generic',
        ok: result.ok,
        summary: {
          totalTables: result.tables.length,
          passing: passing.length,
          failing: failures.length,
        },
        failures,
        ...(showPassing ? { passing } : {}),
      },
      {
        command: 'exodus verify',
        message: result.ok
          ? `All ${passing.length} tables verified — equivalence confirmed.`
          : `${failures.length} table(s) failed equivalence check.`,
      },
    );

    if (!result.ok) {
      process.exitCode = ExitCode.GENERAL_ERROR;
    }
  },
});

// ---------------------------------------------------------------------------
// status subcommand
// ---------------------------------------------------------------------------

/**
 * `cleo exodus status` — show current migration state (staging, source DBs,
 * target DBs).
 *
 * @task T11248 (AC3)
 */
/**
 * Shared status display logic — called both by the `status` subcommand and by
 * the top-level `exodus` fallback (no subcommand given).
 */
function showStatus(): void {
  const result = runExodusStatus(process.cwd());

  humanInfo('Exodus status:');
  humanInfo(`  Staging dir present: ${result.hasStaging ? (result.stagingDir ?? 'yes') : 'none'}`);
  humanInfo(`  Project cleo.db:     ${result.projectDbExists ? 'present' : 'not yet created'}`);
  humanInfo(`  Global  cleo.db:     ${result.globalDbExists ? 'present' : 'not yet created'}`);
  humanInfo('');
  humanInfo('  Source DBs:');
  for (const s of result.sources) {
    const size = s.exists ? `${(s.bytes / 1024).toFixed(1)} KB` : '-';
    humanInfo(`    ${s.exists ? '✓' : '✗'} ${s.name.padEnd(22)} ${size.padStart(10)}  ${s.path}`);
  }

  if (result.journal) {
    const done = result.journal.tables.filter((t) => t.status === 'done').length;
    const total = result.journal.tables.length;
    humanInfo('');
    humanInfo(`  Journal: ${done}/${total} tables done, started ${result.journal.startedAt}`);
  }

  cliOutput(result, { command: 'exodus status' });
}

const statusSubCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show exodus migration status (staging, source DBs, target DBs)',
  },
  run() {
    showStatus();
  },
});

// ---------------------------------------------------------------------------
// Top-level exodus command (AC3 — three verbs only)
// ---------------------------------------------------------------------------

/**
 * `cleo exodus` — root command with three subcommands.
 *
 * @deprecated Marked deprecated for cutover+1 major removal per AC11.
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 */
export const exodusCommand = defineCommand({
  meta: {
    name: 'exodus',
    description:
      '[TRANSITIONAL] Migrate legacy multi-DB fleet to consolidated dual-scope cleo.db (SG-DB-SUBSTRATE-V2)',
  },
  subCommands: {
    migrate: migrateSubCommand,
    verify: verifySubCommand,
    status: statusSubCommand,
  },
  async run({ cmd, rawArgs }) {
    if (isSubCommandDispatch(rawArgs, cmd.subCommands)) return;
    // Default: show status when called with no subcommand
    showStatus();
  },
});
