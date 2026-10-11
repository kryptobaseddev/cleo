/**
 * `cleo doctor system`: machine and project health, ranked, with the exact
 * remedy for each finding, for the running agent to act on or relay to the
 * owner (ask tool when a finding `needsOwnerChoice`).
 *
 * Read-only by default. `--repair` adds the throwaway-container reaper plan
 * (dry run); `--repair --apply` removes only expired `cleo.ttl` containers and
 * anonymous dangling volumes (T13436). Core is imported lazily so `cleo doctor`
 * startup stays inside the gate 39 module budget.
 *
 * @task T13435
 * @task T13436
 */

import type { ContainerReapPlan } from '@cleocode/core/doctor/container-reaper.js';
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
    repair: {
      type: 'boolean',
      description:
        'Add the throwaway-container reaper plan: expired cleo.ttl containers + anonymous dangling volumes (dry run)',
    },
    apply: {
      type: 'boolean',
      description:
        'With --repair: remove exactly what the plan lists (never unlabelled containers or named volumes)',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
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
    let repair: ContainerReapPlan | null = null;
    if (args.repair === true) {
      const { applyContainerReap, collectContainerReapInput, planContainerReap } = await import(
        '@cleocode/core/doctor/container-reaper.js'
      );
      const plan = planContainerReap(await collectContainerReapInput());
      repair = args.apply === true ? await applyContainerReap(plan) : plan;
    }
    cliOutput(
      { ...report, ...(repair ? { repair } : {}) },
      { command: 'doctor', operation: 'doctor.system.run' },
    );
    if (repair?.applied.some((o) => !o.ok) && (process.exitCode ?? 0) === 0) process.exitCode = 1;
    if (report.summary.critical > 0 && (process.exitCode ?? 0) === 0) process.exitCode = 1;
  },
});
