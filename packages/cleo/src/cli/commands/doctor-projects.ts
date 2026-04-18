/**
 * CLI `cleo doctor-projects` — cross-project health check over every
 * registered project in `nexus.db`.
 *
 * Also reachable via `cleo doctor --all-projects` (the doctor.ts command
 * delegates to `runDoctorProjects` when that flag is set).
 *
 * Output modes (flags, mutually consistent with the CLEO protocol):
 *   --json              Full machine-readable {@link FullHealthReport}.
 *   --quiet             One-line summary (counts only).
 *   (default)           Human-readable table: hash | name | path | status | issues.
 *
 * Exit code contract:
 *   0   All projects healthy (or only 'unknown' entries).
 *   1   At least one project is 'degraded'.
 *   2   At least one project is 'unreachable', unless --ignore-unreachable.
 *
 * Never throws during the probe itself — the core module captures every
 * failure on the returned report. Any exit-code-worthy condition is surfaced
 * via `process.exitCode` set in {@link runDoctorProjects}.
 *
 * @task T-PROJECT-HEALTH
 */

import {
  checkAllRegisteredProjects,
  type FullHealthReport,
  type ProjectHealthReport,
  type ProjectHealthStatus,
} from '@cleocode/core/internal';
import { defineCommand } from 'citty';

/** Options understood by {@link runDoctorProjects}. */
export interface RunDoctorProjectsOptions {
  /** Emit JSON instead of a human table. */
  json?: boolean;
  /** Emit a one-line summary only. */
  quiet?: boolean;
  /** Treat 'unreachable' projects as non-fatal (exit 1 instead of 2). */
  ignoreUnreachable?: boolean;
  /** Concurrency cap forwarded to the core module. */
  parallelism?: number;
  /** Skip the write-back to `project_registry.health_status`. */
  noUpdateRegistry?: boolean;
  /** Skip the global-tier (nexus.db/signaldock.db) probe. */
  skipGlobal?: boolean;
}

/**
 * Format a single row of the human-readable table.
 *
 * Columns are truncated to keep the output readable at a 120-col terminal.
 *
 * @internal
 */
function formatRow(report: ProjectHealthReport, nameFallback: string): string {
  const hash = report.projectHash.padEnd(12).slice(0, 12);
  const name = nameFallback.padEnd(24).slice(0, 24);
  const path = report.projectPath.padEnd(40).slice(0, 40);
  const status = report.overall.padEnd(12).slice(0, 12);
  const issues = report.issues.join('; ').slice(0, 80);
  return `${hash}  ${name}  ${path}  ${status}  ${issues}`;
}

/** Pick the highest-severity exit code implied by the summary counts. */
function deriveExitCode(summary: FullHealthReport['summary'], ignoreUnreachable: boolean): number {
  if (summary.unreachable > 0 && !ignoreUnreachable) return 2;
  if (summary.degraded > 0) return 1;
  return 0;
}

/**
 * Render and print the report according to the requested output mode. Also
 * sets `process.exitCode` per the contract documented in the file header.
 *
 * Never throws — rendering failures are logged to stderr but do not mask the
 * underlying health report.
 */
export function printDoctorProjectsReport(
  report: FullHealthReport,
  opts: RunDoctorProjectsOptions,
  nameLookup: Map<string, string>,
): void {
  const { summary } = report;
  const exitCode = deriveExitCode(summary, opts.ignoreUnreachable === true);
  process.exitCode = exitCode;

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (opts.quiet === true) {
    process.stdout.write(
      `projects=${summary.totalProjects} ` +
        `healthy=${summary.healthy} ` +
        `degraded=${summary.degraded} ` +
        `unreachable=${summary.unreachable} ` +
        `unknown=${summary.unknown} ` +
        `global=${report.global.overall}\n`,
    );
    return;
  }

  // Default human table
  process.stdout.write('\nCLEO Cross-Project Health Report\n');
  process.stdout.write(`Generated: ${report.generatedAt}\n\n`);

  process.stdout.write(
    `Global: ${report.global.overall.toUpperCase()} (${report.global.cleoHome})\n`,
  );
  if (report.global.issues.length > 0) {
    for (const iss of report.global.issues) {
      process.stdout.write(`  - ${iss}\n`);
    }
  }
  process.stdout.write('\n');

  if (report.projects.length === 0) {
    process.stdout.write('No projects registered in nexus.db.\n');
    process.stdout.write('Register projects with: cleo nexus register <path>\n\n');
    return;
  }

  const header = `${'hash'.padEnd(12)}  ${'name'.padEnd(24)}  ${'path'.padEnd(40)}  ${'status'.padEnd(12)}  issues`;
  process.stdout.write(`${header}\n`);
  process.stdout.write(`${'-'.repeat(header.length)}\n`);
  for (const project of report.projects) {
    const name = nameLookup.get(project.projectHash) ?? '<unnamed>';
    process.stdout.write(`${formatRow(project, name)}\n`);
  }
  process.stdout.write('\n');
  process.stdout.write(
    `Summary: ${summary.totalProjects} project(s) — ` +
      `${summary.healthy} healthy, ${summary.degraded} degraded, ` +
      `${summary.unreachable} unreachable, ${summary.unknown} unknown\n\n`,
  );
}

/**
 * Run the full doctor-projects flow: enumerate registered projects, probe
 * each, optionally persist health back, and render output. Sets
 * `process.exitCode` per the documented contract.
 *
 * Callers: the standalone `doctor-projects` command below, the `--all-projects`
 * flag branch in `doctor.ts`, and the post-update hook in `self-update.ts`.
 *
 * @example
 * ```typescript
 * await runDoctorProjects({ json: true, parallelism: 4 });
 * ```
 */
export async function runDoctorProjects(
  opts: RunDoctorProjectsOptions = {},
): Promise<FullHealthReport> {
  const report = await checkAllRegisteredProjects({
    updateRegistry: opts.noUpdateRegistry !== true,
    parallelism: opts.parallelism,
    includeGlobal: opts.skipGlobal !== true,
  });

  // Build the name lookup from the registry for nicer table rendering.
  // Defensive: if nexusList throws, fall back to the '<unnamed>' placeholder.
  const nameLookup = new Map<string, string>();
  try {
    const { nexusList } = await import('@cleocode/core/internal');
    const rows = await nexusList();
    for (const row of rows) {
      nameLookup.set(row.hash, row.name);
    }
  } catch {
    // nexus.db not initialized — continue with an empty lookup.
  }

  printDoctorProjectsReport(report, opts, nameLookup);
  return report;
}

/**
 * Citty command `cleo doctor-projects`. Output/behavior mirrors the
 * `--all-projects` flag on `cleo doctor`.
 */
export const doctorProjectsCommand = defineCommand({
  meta: {
    name: 'doctor-projects',
    description: 'Probe every registered project (nexus.db) for DB + config health',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Emit machine-readable JSON report',
    },
    quiet: {
      type: 'boolean',
      description: 'Emit a one-line summary only',
    },
    'ignore-unreachable': {
      type: 'boolean',
      description: 'Exit 1 instead of 2 when a project is unreachable',
    },
    parallelism: {
      type: 'string',
      description: 'Probe concurrency cap (default: 8)',
    },
    'no-update-registry': {
      type: 'boolean',
      description: 'Do not write healthStatus back to nexus.db',
    },
    'skip-global': {
      type: 'boolean',
      description: 'Skip the global-tier (nexus.db, signaldock.db) probe',
    },
    human: {
      type: 'boolean',
      description: 'Force human-readable output',
    },
  },
  async run({ args }) {
    const parallelism = args.parallelism
      ? Number.parseInt(String(args.parallelism), 10)
      : undefined;
    await runDoctorProjects({
      json: args.json === true,
      quiet: args.quiet === true,
      ignoreUnreachable: args['ignore-unreachable'] === true,
      parallelism:
        typeof parallelism === 'number' && Number.isFinite(parallelism) ? parallelism : undefined,
      noUpdateRegistry: args['no-update-registry'] === true,
      skipGlobal: args['skip-global'] === true,
    });
  },
});

/**
 * Re-export of {@link ProjectHealthStatus} for consumers that build their own
 * renderers on top of this module.
 */
export type { FullHealthReport, ProjectHealthReport, ProjectHealthStatus };
