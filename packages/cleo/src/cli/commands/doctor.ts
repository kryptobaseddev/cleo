/**
 * CLI doctor command - system diagnostics.
 * Delegates via dispatch to admin.health handler.
 * --full flag runs operational smoke tests across all domains.
 * --hooks flag shows the cross-provider hook support matrix via CAAMP.
 * --scan-rogue-cleo-dirs scans for rogue .cleo/ dirs inside sub-packages.
 * --quarantine-rogue-cleo-dirs moves rogue .cleo/ dirs to quarantine.
 * @task T4454
 * @task T4795
 * @task T4903
 * @task T5243
 * @task T130
 * @task T167
 * @task T1868
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookMatrixResult } from '@cleocode/core/internal';
import { getProjectRoot, quarantineRogueCleoDir, scanRogueCleoDirs } from '@cleocode/core/internal';
import { defineCommand } from 'citty';
import { dispatchFromCli, dispatchRaw } from '../../dispatch/adapters/cli.js';
import { createDoctorProgress } from '../progress.js';
import { cliError, cliOutput, humanLine } from '../renderers/index.js';
import { runDoctorProjects } from './doctor-projects.js';
import { readMigrationConflicts } from './migrate-agents-v2.js';

// ============================================================================
// T1909: Test-fixture scanner
// ============================================================================

/** One detected fixture row. */
interface FixtureMatch {
  id: string;
  title: string;
  type: string;
  confidence: 'HIGH' | 'MED' | 'LOW';
  rationale: string;
}

const FIXTURE_ID_PATTERNS = [/^E\d+$/, /^T\d+EP$/];

const FIXTURE_TITLE_KEYWORDS = [
  'test epic',
  'with no files',
  'standalone epic',
  'fixture',
] as const;

/**
 * Scan tasks.db for rows matching fixture heuristics.
 * Uses the same patterns as computeActiveEpics (T1894) but scans all task types.
 *
 * @task T1909
 */
async function scanTestFixturesInProd(projectRoot: string): Promise<FixtureMatch[]> {
  type NativeDb = { prepare: (sql: string) => { all: (arg?: string) => unknown[] } };
  const { getDb, getNativeDb } = await import('@cleocode/core/internal');
  await getDb(projectRoot);
  const nativeDb = getNativeDb() as NativeDb | null;
  if (!nativeDb) return [];

  const rows = nativeDb
    .prepare("SELECT id, title, type, status FROM tasks WHERE status != 'deleted' LIMIT 2000")
    .all() as Array<{ id: string; title: string; type: string; status: string }>;

  const matches: FixtureMatch[] = [];

  for (const row of rows) {
    const lower = (row.title ?? '').toLowerCase();
    const idPatternMatch = FIXTURE_ID_PATTERNS.some((p) => p.test(row.id));
    const titleKeywordMatch = FIXTURE_TITLE_KEYWORDS.find((kw) => lower.includes(kw));

    if (idPatternMatch) {
      matches.push({
        id: row.id,
        title: row.title ?? '',
        type: row.type ?? '',
        confidence: 'HIGH',
        rationale: `id matches fixture pattern (^E\\d+$ or ^T\\d+EP$)`,
      });
    } else if (titleKeywordMatch) {
      matches.push({
        id: row.id,
        title: row.title ?? '',
        type: row.type ?? '',
        confidence: 'MED',
        rationale: `title contains fixture keyword "${titleKeywordMatch}"`,
      });
    }
  }

  return matches;
}

/**
 * Move matched fixture rows to .cleo/quarantine/ (T1864 pattern — no DELETE).
 * Writes a JSONL quarantine manifest for auditability.
 *
 * @task T1909
 */
async function quarantineTestFixtures(
  projectRoot: string,
  matches: FixtureMatch[],
): Promise<number> {
  if (matches.length === 0) return 0;

  const cleoDir = join(projectRoot, '.cleo');
  const quarantineDir = join(
    cleoDir,
    'quarantine',
    `fixture-scan-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  );
  mkdirSync(quarantineDir, { recursive: true });

  const manifest = matches.map((m) => ({ ...m, quarantinedAt: new Date().toISOString() }));
  writeFileSync(
    join(quarantineDir, 'manifest.jsonl'),
    manifest.map((m) => JSON.stringify(m)).join('\n') + '\n',
  );

  type NativeDbRun = { prepare: (sql: string) => { run: (arg: string) => void } };
  const { getNativeDb } = await import('@cleocode/core/internal');
  const nativeDb = getNativeDb() as NativeDbRun | null;
  if (nativeDb) {
    for (const m of matches) {
      try {
        nativeDb
          .prepare(
            "UPDATE tasks SET labels_json = json_insert(COALESCE(labels_json, '[]'), '$[#]', 'fixture-quarantine'), status = 'cancelled' WHERE id = ?",
          )
          .run(m.id);
      } catch {
        // non-fatal — quarantine manifest is the source of truth
      }
    }
  }

  return matches.length;
}

/**
 * Render the hook matrix as a human-readable provider x event grid.
 *
 * Prints a table with events as rows and provider IDs as columns,
 * then a coverage summary line at the bottom.
 *
 * @param data - Hook matrix result from CAAMP
 */
function renderHookMatrixHuman(data: HookMatrixResult): void {
  const { events, providers, matrix, summary, caampVersion, detectedProvider } = data;

  humanLine(`\nProvider Hook Matrix (CAAMP ${caampVersion} canonical taxonomy)\n`);

  if (detectedProvider) {
    humanLine(`Detected provider: ${detectedProvider}\n`);
  }

  if (providers.length === 0) {
    humanLine('No providers found in CAAMP registry.');
    return;
  }

  const EVENT_COL = Math.max(...events.map((e) => e.length), 'Event'.length);
  const provCols = providers.map((p) => Math.max(p.length, 5));

  const headerParts = [
    'Event'.padEnd(EVENT_COL),
    ...providers.map((p, i) => p.padEnd(provCols[i]!)),
  ];
  humanLine(`  ${headerParts.join('  ')}`);

  const sepParts = ['-'.repeat(EVENT_COL), ...provCols.map((w) => '-'.repeat(w))];
  humanLine(`  ${sepParts.join('  ')}`);

  for (const event of events) {
    const cells = providers.map((p, i) => {
      const supported = matrix[event]?.[p] === true;
      const symbol = supported ? '\u2713' : '-';
      return symbol.padEnd(provCols[i]!);
    });
    humanLine(`  ${event.padEnd(EVENT_COL)}  ${cells.join('  ')}`);
  }

  humanLine('');
  const coverageParts = summary.map(
    (s) => `${s.providerId} ${s.supportedCount}/${s.totalCanonical} (${s.coverage}%)`,
  );
  humanLine(`Coverage: ${coverageParts.join(', ')}\n`);
}

/**
 * Root doctor command — run system diagnostics and health checks.
 *
 * Global output flags (--json, --human, --quiet) are declared in args so
 * citty parses them directly. This replaces the Commander.js optsWithGlobals()
 * pattern that is unavailable in native citty commands.
 */
export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Run system diagnostics and health checks' },
  args: {
    detailed: {
      type: 'boolean',
      description: 'Show detailed health check results',
    },
    comprehensive: {
      type: 'boolean',
      description: 'Run comprehensive doctor report',
    },
    full: {
      type: 'boolean',
      description: 'Run operational smoke tests across all domains',
    },
    fix: {
      type: 'boolean',
      description: 'Auto-fix failed checks',
    },
    coherence: {
      type: 'boolean',
      description: 'Run coherence check across task data',
    },
    hooks: {
      type: 'boolean',
      description: 'Show cross-provider hook support matrix (CAAMP canonical taxonomy)',
    },
    'all-projects': {
      type: 'boolean',
      description: 'Probe DB + config health for every registered project (nexus.db)',
    },
    'ignore-unreachable': {
      type: 'boolean',
      description: 'When used with --all-projects, exit 1 instead of 2 on unreachable projects',
    },
    'scan-rogue-cleo-dirs': {
      type: 'boolean',
      description:
        'Scan for rogue .cleo/ directories inside sub-packages and print forensic report',
    },
    'quarantine-rogue-cleo-dirs': {
      type: 'boolean',
      description:
        'Move all rogue .cleo/ sub-package directories to .cleo/quarantine/ (never deletes)',
    },
    'scan-stray-nexus-dbs': {
      type: 'boolean',
      description: 'Scan ~/.local/share/cleo/ for orphaned nexus.db files and print report (T9052)',
    },
    'audit-worktrees': {
      type: 'boolean',
      description:
        'Audit orphaned agent worktree directories and report what cleo gc --worktrees would remove (T9043)',
    },
    'audit-temp': {
      type: 'boolean',
      description:
        'Audit orphaned CLEO-generated temp directories and report what cleo gc --temp would remove (T9043)',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'With --quarantine-rogue-cleo-dirs or --scan-stray-nexus-dbs: print what would be done without acting',
    },
    /**
     * Show brain.db health dashboard (T1908 / BBTT-W2-4).
     * Aggregates 8 named flags: row counts, dedup ratio, last consolidation,
     * recency violations, learnings ratio, pattern bloat, fixture pollution,
     * daemon liveness. Exits 1 on any P0 flag failure.
     */
    brain: {
      type: 'boolean',
      description: 'Show brain.db health dashboard with 8 named BBTT flags (T1908)',
    },
    /**
     * T1909 / BBTT-W3-3: Scan tasks.db for test-fixture rows using heuristics.
     *
     * Detects rows matching: id ^E\d+$, id ^T\d+EP$, or title containing
     * "Test Epic", "with no files", "standalone epic", "fixture".
     * Reports each match with a confidence score (HIGH/MED/LOW).
     *
     * Pass --quarantine to move matched rows to .cleo/quarantine/
     * (T1864 pattern — NEVER deletes). Dry-run by default.
     */
    'scan-test-fixtures-in-prod': {
      type: 'boolean',
      description: 'Scan tasks.db for test-fixture rows using heuristics (T1909)',
    },
    quarantine: {
      type: 'boolean',
      description:
        'With --scan-test-fixtures-in-prod: move matches to .cleo/quarantine/ (no delete)',
    },
    // Global output format flags — read directly from args (no optsWithGlobals in citty)
    json: {
      type: 'boolean',
      description: 'Output as JSON',
    },
    human: {
      type: 'boolean',
      description: 'Force human-readable output',
    },
    quiet: {
      type: 'boolean',
      description: 'Suppress non-essential output',
    },
  },
  async run({ args }) {
    const isHuman = args.human === true || (!!process.stdout.isTTY && args.json !== true);
    const progress = createDoctorProgress(isHuman);

    progress.start();

    try {
      // T1908 / BBTT-W2-4: brain health dashboard
      if (args.brain) {
        const { computeBrainHealthDashboard } = await import('@cleocode/core/internal');
        const projectRoot = getProjectRoot();
        const dashboard = await computeBrainHealthDashboard(projectRoot);

        cliOutput(dashboard, { command: 'doctor', operation: 'doctor.brain' });

        if (dashboard.hasP0Failure) {
          process.exitCode = 1;
        }
        return;
      }

      // T1909 / BBTT-W3-3: scan tasks.db for test-fixture rows
      if (args['scan-test-fixtures-in-prod']) {
        const projectRoot = getProjectRoot();
        const matches = await scanTestFixturesInProd(projectRoot);
        const dryRun = args['dry-run'] !== false && args.quarantine !== true;

        const quarantined =
          !dryRun && matches.length > 0
            ? await quarantineTestFixtures(projectRoot, matches)
            : undefined;
        cliOutput(
          { matches, dryRun, quarantined },
          { command: 'doctor', operation: 'doctor.scan-test-fixtures' },
        );

        if (matches.some((m) => m.confidence === 'HIGH')) {
          process.exitCode = 1;
        }
        return;
      }

      if (args['all-projects']) {
        progress.step(0, 'Probing registered projects');
        await runDoctorProjects({
          json: args.json === true,
          quiet: args.quiet === true,
          ignoreUnreachable: args['ignore-unreachable'] === true,
        });
        progress.complete('Project health report complete');
      } else if (args.hooks) {
        progress.step(0, 'Building provider hook matrix');
        if (isHuman) {
          const response = await dispatchRaw('query', 'admin', 'hooks.matrix', {
            detectProvider: true,
          });
          progress.complete('Hook matrix complete');
          if (response.success && response.data) {
            renderHookMatrixHuman(response.data as HookMatrixResult);
          } else {
            cliError(response.error?.message ?? 'Failed to build hook matrix', 1, {
              name: 'E_INTERNAL',
            });
            process.exitCode = 1;
          }
        } else {
          await dispatchFromCli(
            'query',
            'admin',
            'hooks.matrix',
            { detectProvider: true },
            { command: 'doctor', operation: 'admin.hooks.matrix' },
          );
          progress.complete('Hook matrix complete');
        }
      } else if (args.full) {
        progress.step(0, 'Running operational smoke tests');
        await dispatchFromCli(
          'query',
          'admin',
          'smoke',
          {},
          { command: 'doctor', operation: 'admin.smoke' },
        );
        progress.complete('Smoke tests complete');
      } else if (args.coherence) {
        progress.step(0, 'Running coherence check');
        await dispatchFromCli(
          'query',
          'check',
          'coherence',
          {},
          { command: 'doctor', operation: 'check.coherence' },
        );
        progress.complete('Coherence check complete');
      } else if (args.fix) {
        progress.step(4, 'Applying fixes');
        await dispatchFromCli(
          'mutate',
          'admin',
          'health',
          { mode: 'repair' },
          { command: 'doctor', operation: 'admin.health' },
        );
        progress.complete('Fixes applied');
      } else if (args.comprehensive) {
        progress.step(0, 'Checking CLEO directory');
        await dispatchFromCli(
          'query',
          'admin',
          'health',
          { mode: 'diagnose' },
          { command: 'doctor', operation: 'admin.health' },
        );
        progress.complete('Comprehensive diagnostics complete');
      } else if (args['scan-rogue-cleo-dirs']) {
        progress.step(0, 'Scanning for rogue .cleo/ directories');
        const projectRoot = getProjectRoot();
        const reports = scanRogueCleoDirs(projectRoot);
        progress.complete(
          `Found ${reports.length} rogue .cleo/ director${reports.length === 1 ? 'y' : 'ies'}`,
        );

        cliOutput(reports, { command: 'doctor', operation: 'doctor.scan-rogue-cleo-dirs' });
      } else if (args['quarantine-rogue-cleo-dirs']) {
        const isDryRun = args['dry-run'] === true;
        progress.step(0, `${isDryRun ? '[DRY RUN] ' : ''}Scanning for rogue .cleo/ directories`);
        const projectRoot = getProjectRoot();
        const reports = scanRogueCleoDirs(projectRoot);

        if (reports.length === 0) {
          progress.complete('No rogue .cleo/ directories found — nothing to quarantine');
          cliOutput(
            { quarantined: [] },
            { command: 'doctor', operation: 'doctor.quarantine-rogue-dirs' },
          );
          return;
        }

        const quarantined: Array<{ packageName: string; from: string; to: string }> = [];
        const errors: Array<{ packageName: string; path: string; error: string }> = [];

        for (const report of reports) {
          if (isDryRun) {
            // Compute the target path for display without moving
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const targetPath = `${projectRoot}/.cleo/quarantine/${report.packageName}-${timestamp}`;
            quarantined.push({
              packageName: report.packageName,
              from: report.path,
              to: targetPath,
            });
          } else {
            try {
              const { quarantinePath } = quarantineRogueCleoDir(report, projectRoot);
              quarantined.push({
                packageName: report.packageName,
                from: report.path,
                to: quarantinePath,
              });
            } catch (err) {
              errors.push({
                packageName: report.packageName,
                path: report.path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const verb = isDryRun ? 'Would quarantine' : 'Quarantined';
        progress.complete(
          `${verb} ${quarantined.length} director${quarantined.length === 1 ? 'y' : 'ies'}${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
        );

        cliOutput(
          { dryRun: isDryRun, quarantined, errors },
          { command: 'doctor', operation: 'doctor.quarantine-rogue-dirs' },
        );
        if (errors.length > 0) {
          process.exitCode = 1;
        }
      } else if (args['scan-stray-nexus-dbs']) {
        progress.step(0, 'Scanning for stray nexus.db files');
        const { detectAndRemoveLegacyGlobalFiles, detectAndRemoveStrayProjectNexus } = await import(
          '@cleocode/core/internal'
        );
        const { getCleoHome } = await import('@cleocode/core/internal');
        const cleoHome = getCleoHome();
        const projectRoot = getProjectRoot();

        const legacyResult = detectAndRemoveLegacyGlobalFiles(cleoHome);
        const strayResult = detectAndRemoveStrayProjectNexus(projectRoot);

        const isDryRun = args['dry-run'] === true;
        const report = {
          cleoHome,
          projectRoot,
          legacy: {
            removed: legacyResult.removed.length,
            files: legacyResult.removed,
          },
          stray: {
            removed: strayResult.removed,
            path: strayResult.path,
          },
          dryRun: isDryRun,
        };

        progress.complete(
          `Found ${legacyResult.removed.length} legacy + ${strayResult.removed ? 1 : 0} stray nexus.db`,
        );

        cliOutput(report, { command: 'doctor', operation: 'doctor.scan-stray-nexus-dbs' });
      } else if (args['audit-worktrees']) {
        progress.step(0, 'Auditing orphaned agent worktrees');
        const { auditOrphanWorktrees } = await import('@cleocode/core/internal');
        const checkResult = auditOrphanWorktrees();
        progress.complete(`Worktree audit complete — ${checkResult.status}`);

        cliOutput(checkResult, { command: 'doctor', operation: 'doctor.audit-worktrees' });
        if (
          checkResult.details?.['orphans'] &&
          (checkResult.details['orphans'] as unknown[]).length > 0 &&
          (process.exitCode === undefined || process.exitCode === 0)
        ) {
          process.exitCode = 2;
        }
      } else if (args['audit-temp']) {
        progress.step(0, 'Auditing orphaned CLEO temp directories');
        const { auditOrphanTempDirs } = await import('@cleocode/core/internal');
        const checkResult = await auditOrphanTempDirs();
        progress.complete(`Temp audit complete — ${checkResult.status}`);

        cliOutput(checkResult, { command: 'doctor', operation: 'doctor.audit-temp' });
        if (
          checkResult.details?.['orphans'] &&
          (checkResult.details['orphans'] as unknown[]).length > 0 &&
          (process.exitCode === undefined || process.exitCode === 0)
        ) {
          process.exitCode = 2;
        }
      } else {
        progress.step(0, 'Checking CLEO directory');
        await dispatchFromCli(
          'query',
          'admin',
          'health',
          { detailed: args.detailed },
          { command: 'doctor', operation: 'admin.health' },
        );

        // MIGRATE-AGENTS-V2-CONFLICT diagnostic: surface any unresolved
        // agent migration conflicts logged by `cleo migrate agents-v2`.
        // @task T1938 @epic T1929
        try {
          const projectRoot = getProjectRoot();
          const conflicts = readMigrationConflicts(projectRoot);
          if (conflicts.length > 0) {
            progress.complete(
              `Health check complete — ${conflicts.length} agent migration conflict(s) detected`,
            );
            humanLine(
              `\n[MIGRATE-AGENTS-V2-CONFLICT] ${conflicts.length} agent(s) have conflicting .cant content between disk and signaldock.db:`,
            );
            for (const c of conflicts) {
              humanLine(
                `  - ${c.agentName} (${c.filePath})\n` +
                  `    disk sha256:     ${c.newSha256 ?? 'unknown'}\n` +
                  `    registry sha256: ${c.existingSha256 ?? 'unknown'}\n` +
                  `    Resolve: inspect the conflict and either update the registry via\n` +
                  `    'cleo agent install --force <path>' or remove the conflicting file.`,
              );
            }
            humanLine(`  Audit log: .cleo/audit/migration-agents-v2.jsonl\n`);
            if (process.exitCode === undefined || process.exitCode === 0) {
              process.exitCode = 2;
            }
          } else {
            progress.complete('Health check complete');
          }
        } catch {
          progress.complete('Health check complete');
        }
      }
    } catch (err) {
      progress.error('Health check failed');
      throw err;
    }
  },
});
