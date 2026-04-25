/**
 * CLI reconcile command group — registry-driven post-release invariants gate.
 *
 * Per ADR-056 D5, this command runs every registered invariant against a
 * release tag and emits an aggregated report. The first customer is
 * `archive-reason-invariant` (T1411), which stamps verified tasks done +
 * `archive_reason='verified'` and creates follow-ups for unverified
 * references.
 *
 * Usage:
 *   cleo reconcile release --tag <tag> [--dry-run]
 *
 * Exit codes (per task spec):
 *   0  — all green (zero errors, zero unreconciled)
 *   1  — at least one invariant raised an error
 *   2  — one or more unreconciled tasks (operator follow-up required)
 *
 * The command bypasses the dispatch layer because the invariant gate
 * operates at the SDK boundary directly (no LAFS envelope wrapping is
 * needed and adding one would force the gate to live behind the dispatch
 * registry, complicating the post-tag git-hook installation path).
 *
 * @task T1411
 * @epic T1407
 * @adr ADR-056 D5
 */

import { release } from '@cleocode/core';
import { defineCommand, showUsage } from 'citty';

/**
 * cleo reconcile release — run the registered invariants for a tag.
 */
const releaseSubcommand = defineCommand({
  meta: {
    name: 'release',
    description: 'Run post-release invariants for a release tag',
  },
  args: {
    tag: {
      type: 'string',
      description: 'Release tag to reconcile (e.g. v2026.4.145)',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview mutations without writing to tasks.db or audit log',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Emit raw JSON instead of human-readable summary',
      default: false,
    },
  },
  async run({ args }) {
    const dryRun = args['dry-run'] === true;
    const report = await release.runInvariants(args.tag, {
      dryRun,
      cwd: process.cwd(),
    });

    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const lines: string[] = [];
      lines.push(`reconcile release ${report.tag}${dryRun ? ' (dry-run)' : ''}`);
      lines.push(
        `  total: processed=${report.processed} reconciled=${report.reconciled} unreconciled=${report.unreconciled} errors=${report.errors}`,
      );
      for (const r of report.results) {
        lines.push(`  [${r.severity}] ${r.id}: ${r.message}`);
      }
      process.stdout.write(`${lines.join('\n')}\n`);
    }

    if (report.errors > 0) {
      process.exit(1);
    }
    if (report.unreconciled > 0) {
      process.exit(2);
    }
  },
});

/**
 * Root reconcile command group.
 *
 * Currently exposes the `release` subcommand only; future invariants
 * (schema-vs-CHECK drift, drizzle-migration-vs-runtime divergence) will
 * register additional subcommands here as they are added to the registry.
 */
export const reconcileCommand = defineCommand({
  meta: {
    name: 'reconcile',
    description: 'Reconcile state against external sources (release tags, schema, etc.)',
  },
  subCommands: {
    release: releaseSubcommand,
  },
  async run({ cmd, rawArgs }) {
    const firstArg = rawArgs?.find((a) => !a.startsWith('-'));
    if (firstArg && cmd.subCommands && firstArg in cmd.subCommands) return;
    await showUsage(cmd);
  },
});
