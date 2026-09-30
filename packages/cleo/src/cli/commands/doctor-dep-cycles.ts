/**
 * `cleo doctor dep-cycles` — dependency cycles already stored, with a repair plan.
 *
 * New cycles are refused by the `tasks_task_dependencies_cycle_guard_*`
 * triggers; this reports the ones written before the guard existed. Always
 * read-only: it lists the edges to remove, never removes them.
 *
 * @task T12886
 */

import { getProjectRoot } from '@cleocode/core';
import { scanDependencyCycles } from '@cleocode/core/doctor/dependency-cycles.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor dep-cycles` subcommand.
 *
 * Exits 2 while a cycle remains, so it can gate a cleanup step.
 *
 * @task T12886
 */
export const doctorDepCyclesCommand = defineCommand({
  meta: {
    name: 'dep-cycles',
    description:
      'Report task dependency cycles already stored (edges written before the T12886 cycle ' +
      'guard) with a repair plan: the edges whose removal breaks every cycle, each with its ' +
      '`cleo update <id> --remove-depends <dep>` command. Read-only; never removes an edge.',
  },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run() {
    const report = await scanDependencyCycles(getProjectRoot());
    cliOutput(report, { command: 'doctor', operation: 'doctor.dep-cycles.run' });
    if (report.cycleCount > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 2;
    }
  },
});
