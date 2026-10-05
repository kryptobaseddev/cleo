/**
 * `cleo doctor project-identity` — is this project's portable id consistent,
 * and if not, fix it.
 *
 * Without flags it is read-only and reports the state of `.cleo/project.json`,
 * its legacy `.cleo/project-id` mirror and the `project-info.json` cache, plus
 * registry-label drift, with the exact remedy. `--resolve` applies that
 * remedy: it is the ONLY command that migrates a legacy project to
 * `.cleo/project.json` (T12716) or re-keys a conflict to the tracked id
 * through the alias table. `--dry-run` prints the plan and writes nothing.
 *
 * @task T12353
 * @task T12716
 * @see ADR-094 — write-once portable project identity
 * @see ADR-096 — one committed `.cleo/project.json` (amends ADR-094)
 */

import {
  inspectProjectIdentity,
  inspectProjectNameDrift,
  resolveProjectIdentity,
} from '@cleocode/core/doctor/project-identity.js';
import { getProjectRoot } from '@cleocode/core/project-scope';
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
      'Check .cleo/project.json, its legacy .cleo/project-id mirror and the project-info.json cache ' +
      '(legacy / missing / conflict / invalid / untracked) plus registry-name drift, and print the ' +
      'exact remedy. --resolve applies it: it migrates a legacy project to .cleo/project.json (no id ' +
      'changes) and re-keys a conflict to the tracked id through the alias table, losing no registry ' +
      'rows; add --dry-run to see the plan first.',
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
      const nameDrift = await inspectProjectNameDrift(projectRoot);
      cliOutput(
        { ...report, nameDrift },
        { command: 'doctor', operation: 'doctor.project-identity.inspect' },
      );
      const drifted = nameDrift.state === 'drift' || nameDrift.state === 'taken';
      if (
        (report.state !== 'ok' || drifted) &&
        (process.exitCode === undefined || process.exitCode === 0)
      )
        process.exitCode = 1;
      return;
    }
    const result = await resolveProjectIdentity(projectRoot, { dryRun: !!args['dry-run'] });
    cliOutput(result, { command: 'doctor', operation: 'doctor.project-identity.resolve' });
    if (result.refused && result.before.state !== 'ok' && (process.exitCode ?? 0) === 0)
      process.exitCode = 1;
  },
});
