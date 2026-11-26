/**
 * `cleo doctor gate-text` — text acceptance criteria that hold a typed gate's JSON.
 *
 * Criteria stored as gate JSON before T12292 made that input a refusal carry no
 * gate meaning and block `cleo decompose`. Dry run by default; `--apply`
 * converts each to its typed gate with the same checks as `cleo req add`.
 *
 * @task T14635
 */

import { scanGateTextAcceptance } from '@cleocode/core/doctor/gate-text.js';
import { getProjectRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor gate-text` subcommand.
 *
 * Exits non-zero while gate-JSON text criteria remain, so a dry run fails when
 * any exist and a successful `--apply` exits 0.
 *
 * @task T14635
 */
export const doctorGateTextCommand = defineCommand({
  meta: {
    name: 'gate-text',
    description:
      'List tasks whose stored text acceptance criteria are typed gate JSON (stored before ' +
      'T12292 refused it; such tasks cannot be decomposed). Dry run by default; --apply converts ' +
      'each criterion on an open task to its typed gate with the same checks as cleo req add.',
  },
  args: {
    apply: {
      type: 'boolean',
      description:
        'Convert each convertible criterion in place (one transaction per task); the old text ' +
        'is kept in the AC history. Terminal tasks are never rewritten.',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    const report = await scanGateTextAcceptance(getProjectRoot(), { apply: args.apply === true });
    cliOutput(report, { command: 'doctor', operation: 'doctor.gate-text.run' });
    if (report.remaining > 0 && (process.exitCode === undefined || process.exitCode === 0)) {
      process.exitCode = 1;
    }
  },
});
