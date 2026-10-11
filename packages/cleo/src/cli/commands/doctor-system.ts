/**
 * `cleo doctor system`: machine and project health, ranked, with the exact
 * remedy for each finding, for the running agent to act on or relay to the
 * owner (ask tool when a finding `needsOwnerChoice`).
 *
 * Read-only. Core is imported lazily so `cleo doctor` startup stays inside the
 * gate 39 module budget.
 *
 * @task T13435
 */

import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor system` subcommand. Exits 1 when any finding is critical, so it
 * can gate a setup script.
 *
 * @task T13435
 */
export const doctorSystemCommand = defineCommand({
  meta: {
    name: 'system',
    description:
      'Assess machine + project health (memory/swap, MCP fan-out, heavy jobs outside cleo run, ' +
      'containers, idle sessions, indexing). Read-only; ranked findings with exact remedies.',
  },
  args: {
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run() {
    const { assessSystemHealth, collectSystemSnapshot } = await import(
      '@cleocode/core/doctor/system-health.js'
    );
    const { getProjectRoot } = await import('@cleocode/core/paths.js');
    let projectRoot: string | null = null;
    try {
      projectRoot = getProjectRoot();
    } catch {
      projectRoot = null;
    }
    const report = assessSystemHealth(await collectSystemSnapshot({ projectRoot }));
    cliOutput(report, { command: 'doctor', operation: 'doctor.system.run' });
    if (report.summary.critical > 0 && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  },
});
