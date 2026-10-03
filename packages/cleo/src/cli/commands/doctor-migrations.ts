/**
 * `cleo doctor migrations` — the migration journal of each store, read-only
 * (T12796, journal spec §2.3a rule 2).
 *
 * Per scope (project, global): the journal's row count and head, and per
 * lineage sharing it, the applied and pending migration files and any drift
 * (a row named like a local migration with a different hash). Acceptance
 * runs read the live journal count through this report, never a literal. A
 * journal rebuilt on a store that already held its schema (a vault restore
 * before T13104) is reported as `rebuilt`, with its stamped row count.
 *
 * Exits non-zero when a journal shows drift. Writes nothing.
 *
 * @task T12796
 * @task T13104
 */

import { getProjectRoot } from '@cleocode/core';
import { inspectMigrations } from '@cleocode/core/doctor/migrations.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor migrations` subcommand.
 *
 * @task T12796
 */
export const doctorMigrationsCommand = defineCommand({
  meta: {
    name: 'migrations',
    description:
      'Report the migration journal of the project and global stores: row count, head, applied ' +
      'and pending files per lineage, hash drift, and a journal rebuilt on a store that already ' +
      'held its schema. Read-only.',
  },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run() {
    const report = inspectMigrations(getProjectRoot());
    cliOutput(report, { command: 'doctor', operation: 'doctor.migrations.run' });
    if (report.scopes.some((s) => s.drift.length > 0)) process.exitCode = 1;
  },
});
