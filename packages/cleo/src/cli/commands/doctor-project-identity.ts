/**
 * `cleo doctor project-identity` — is this project's portable id consistent,
 * and if not, fix it.
 *
 * Without flags it is read-only and reports the state of `.cleo/project-id`
 * against `project-info.json`, with the exact remedy. `--resolve` applies that
 * remedy. For a conflict, it re-keys local state to the tracked id through the
 * alias table. `--dry-run` prints the plan and writes nothing.
 *
 * @task T12353
 * @see ADR-094 — write-once portable project identity
 */

import { getProjectRoot } from '@cleocode/core';
import {
  inspectProjectIdentity,
  resolveProjectIdentity,
} from '@cleocode/core/doctor/project-identity.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor project-identity` subcommand.
 *
 * Exits 1 when the report is not `ok` (read-only mode) or when `--resolve`
 * was refused, so it can gate a script.
 *
 * @task T12353
 */
export const doctorProjectIdentityCommand = defineCommand({
  meta: {
    name: 'project-identity',
    description:
      'Check .cleo/project-id against project-info.json (missing / conflict / invalid / untracked) ' +
      'and print the exact remedy. --resolve applies it (a conflict is re-keyed to the tracked id ' +
      'through the alias table, losing no registry rows); add --dry-run to see the plan first.',
  },
  args: {
    resolve: { type: 'boolean', description: 'Apply the remedy for the reported state' },
    'dry-run': { type: 'boolean', description: 'With --resolve: print the plan, write nothing' },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    if (!args.resolve) {
      const report = inspectProjectIdentity(projectRoot);
      cliOutput(report, { command: 'doctor', operation: 'doctor.project-identity.inspect' });
      if (report.state !== 'ok' && (process.exitCode === undefined || process.exitCode === 0))
        process.exitCode = 1;
      return;
    }
    const result = await resolveProjectIdentity(projectRoot, { dryRun: !!args['dry-run'] });
    cliOutput(result, { command: 'doctor', operation: 'doctor.project-identity.resolve' });
    if (result.refused && result.before.state !== 'ok' && (process.exitCode ?? 0) === 0)
      process.exitCode = 1;
  },
});
