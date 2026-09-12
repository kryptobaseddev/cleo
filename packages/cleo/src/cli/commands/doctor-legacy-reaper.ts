/**
 * `cleo doctor legacy-reaper` — detect the unsafe legacy MCP reaper (gh#1187).
 *
 * A hand-applied 2026-07-01 helper + systemd user timer selects victims by
 * `/proc/PID/comm === 'MainThread'`, which is a generic Node launcher comm
 * rather than an MCP signature. It terminated live Codex CLI sessions cleanly
 * enough to be misdiagnosed as a Codex crash. It was never package-owned, so no
 * upgrade has ever removed it.
 *
 * `cleo janitor run` is the supported replacement — it discriminates by
 * CLEO-owned scope/pgid, not by process comm.
 *
 * @task T12131
 */

import { scanLegacyReaper } from '@cleocode/core/doctor/legacy-reaper.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor legacy-reaper` subcommand.
 *
 * Exits non-zero only when the timer is ARMED — present-but-masked artifacts
 * are reported without failing, so a remediated host stays green in CI.
 *
 * @task T12131
 */
export const doctorLegacyReaperCommand = defineCommand({
  meta: {
    name: 'legacy-reaper',
    description:
      'Detect the legacy cleo-mcp-reaper user timer that kills processes by generic `MainThread` ' +
      'comm — it terminates live Codex CLI sessions. --fix disables and masks it.',
  },
  args: {
    fix: { type: 'boolean', description: 'Disable and mask any legacy unit that can still fire' },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  run({ args }) {
    const report = scanLegacyReaper({ fix: args.fix === true });

    cliOutput(report, { command: 'doctor', operation: 'doctor.legacy-reaper.run' });

    // Only an ARMED timer is a failure. Inert leftovers are informational —
    // failing on them would train operators to ignore this check.
    if (report.armed && !report.remediated) {
      if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
    }
  },
});
