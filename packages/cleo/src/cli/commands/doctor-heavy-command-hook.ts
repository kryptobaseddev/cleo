/**
 * `cleo doctor heavy-command-hook`: is CLEO's heavy-command hook in place for
 * every agent harness this project uses?
 *
 * The hook (`cleo hook heavy-command`, T12983) routes agent-run tests, builds
 * and typechecks through `cleo run`, the machine-wide resource budget. Without
 * it those commands run ungoverned: on 2026-10-03 that is what saturated the
 * machine (T13124). Read-only by default. `--fix` installs or refreshes the
 * hook (project-level config files only, never a user-global one) and reports
 * the state after the fix.
 *
 * @task T13124
 */

import { getProjectRoot } from '@cleocode/core/paths.js';
import {
  deliverHeavyCommandHooks,
  heavyHookPresent,
  inspectHeavyCommandHooks,
  isHeavyHookProblem,
  probeHeavyHookCliFor,
} from '@cleocode/core/resources/heavy-command-hook-delivery.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor heavy-command-hook` subcommand. Exits 1 while a provider in
 * use is left without a working hook, or the `cleo` on PATH predates the
 * installed hook, so it can gate a setup script.
 *
 * @task T13124
 */
export const doctorHeavyCommandHookCommand = defineCommand({
  meta: {
    name: 'heavy-command-hook',
    description:
      'Report, per agent harness in use, whether the heavy-command hook (routes agent-run tests and ' +
      'builds through cleo run) is installed, outdated, missing or blocked. --fix installs it.',
  },
  args: {
    fix: {
      type: 'boolean',
      description:
        'Install or refresh the hook in this project (project-level configs only, never user-global)',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const outcomes =
      args.fix === true ? (await deliverHeavyCommandHooks(projectRoot)).outcomes : [];
    const { mode, inspections } = await inspectHeavyCommandHooks(projectRoot);
    // An installed hook governs nothing when the `cleo` it calls predates it.
    const cli =
      mode !== 'off' && heavyHookPresent(inspections)
        ? await probeHeavyHookCliFor(projectRoot)
        : null;
    const problems = inspections.filter(isHeavyHookProblem);
    const cliProblem = cli !== null && (cli.state === 'older' || cli.state === 'missing');
    cliOutput(
      {
        projectRoot,
        mode,
        inspections,
        cli,
        fixApplied: args.fix === true,
        outcomes,
        healthy: problems.length === 0 && !cliProblem,
      },
      { command: 'doctor', operation: 'doctor.heavy-command-hook.run' },
    );
    if ((problems.length > 0 || cliProblem) && (process.exitCode ?? 0) === 0) {
      process.exitCode = 1;
    }
  },
});
