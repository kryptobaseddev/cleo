/**
 * `cleo doctor acceptance-drift` — do the two acceptance stores agree?
 *
 * Acceptance criteria live in `tasks_tasks.acceptance_json` (what `cleo show`
 * reads) AND in `tasks_task_acceptance_criteria` (typed rows). Two
 * representations of one fact, with a projection mechanism between them and,
 * until this command, nothing asserting they agree (gh#1290).
 *
 * It deliberately does NOT read `tasks_acceptance_projection_state`, which is
 * the surface that exists to answer exactly this question and which reports
 * `status = fresh`, `dirty rows = 0` for a projection that has not run since
 * 2026-05-26. A freshness marker that is written rather than derived is a
 * claim, not a measurement. This command re-derives the answer every time.
 *
 * Read-only. It reports; it repairs nothing.
 *
 * @task T12157
 * @see ADR-092 — "a status surface that reports a state it does not measure"
 */

import { getProjectRoot } from '@cleocode/core';
import { scanAcceptanceDrift } from '@cleocode/core/doctor/acceptance-drift.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor acceptance-drift` subcommand.
 *
 * Exits non-zero only when drift exists among tasks created since the
 * acceptance convention settled (2026-06-01), so a store carrying historical
 * rows under the older convention is not permanently red. `--all` widens the
 * exit condition to every entry.
 *
 * @task T12157
 */
export const doctorAcceptanceDriftCommand = defineCommand({
  meta: {
    name: 'acceptance-drift',
    description:
      'Report tasks whose acceptance criteria disagree between the JSON column and the typed rows ' +
      'table, separating legacy-convention rows from current-era regressions. Read-only — repairs nothing.',
  },
  args: {
    all: {
      type: 'boolean',
      description: 'Exit non-zero for legacy-era entries too, not only current-era drift',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run(ctx) {
    const result = scanAcceptanceDrift(getProjectRoot());

    cliOutput(result, {
      command: 'doctor',
      operation: 'doctor.acceptance-drift.run',
    });

    const failing = ctx.args.all ? result.entries.length : result.currentEraDrift;
    if (failing > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
