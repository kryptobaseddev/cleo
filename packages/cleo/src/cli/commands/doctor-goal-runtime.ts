/**
 * `cleo doctor goal-runtime`: the CLEO Goal runtime (`cleo-goal`, alias
 * `ocg`) — installed or missing, its version, and its `status --json`.
 * `--check-updates` also asks npm for the latest `@cleocode/goal`; that is
 * the only network call, and a bare `cleo doctor` never makes it.
 *
 * @task T13819
 */

import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor goal-runtime` subcommand. Exits 1 on a warning (a foreign
 * `ocg`, an unreadable status, or an available update).
 *
 * @task T13819
 */
export const doctorGoalRuntimeCommand = defineCommand({
  meta: {
    name: 'goal-runtime',
    description:
      'Report the CLEO Goal runtime (cleo-goal): installed, version, status schema. --check-updates also asks npm for the latest version.',
  },
  args: {
    'check-updates': {
      type: 'boolean',
      description: 'Ask npm for the latest @cleocode/goal (network; off by default)',
    },
  },
  async run({ args }) {
    const { checkGoalRuntime } = await import('@cleocode/core/system/health.js');
    const check = await checkGoalRuntime(getProjectRoot(), {
      checkUpdates: args['check-updates'] === true,
    });
    cliOutput(check, { command: 'doctor', operation: 'doctor.goal-runtime.run' });
    if (check.status !== 'ok' && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  },
});
