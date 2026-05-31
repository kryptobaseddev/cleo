/**
 * CLI `cleo go` — SG-AUTOPILOT single-step driver.
 *
 * Thin dispatch over {@link cleoGo} in `packages/core/src/go/driver.ts`.
 * All orchestration logic lives in core; this handler is PURE GLUE:
 *   1. Parse flags.
 *   2. Delegate to `go.cleoGo()`.
 *   3. Emit one LAFS envelope via `cliOutput`.
 *
 * Usage:
 *   cleo go [--saga <sagaId>] [--headless]
 *
 * Flags:
 *   --saga <id>   Scope autopilot to a specific Saga (default: auto-select
 *                 highest-priority non-terminal Saga from canonical order)
 *   --headless    Suppress interactive annotations; suitable for daemon use.
 *
 * Output (one LAFS envelope):
 *   { outcome: CleoGoAction, diagnostics: string[] }
 *
 * `outcome.action` is one of:
 *   - `needsDecomposition` — active epic has no children; decompose first
 *   - `lifecycleHop`       — pre-implementation stage; advance lifecycle
 *   - `ivtrFanOut`         — IVTR started for tasks on the ready frontier
 *   - `complete`           — no non-terminal sagas remain
 *
 * @task T11494 — E2-CLEO-GO
 * @saga T11492 — SG-AUTOPILOT
 */

import { getProjectRoot, go } from '@cleocode/core';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo go` root command — runs one turn of the SG-AUTOPILOT pipeline.
 *
 * @task T11494
 */
export const goCommand = defineCommand({
  meta: {
    name: 'go',
    description: 'SG-AUTOPILOT: run one turn of briefing→sagaNext→ready→stage-branch→ivtr loop',
  },
  args: {
    saga: {
      type: 'string',
      description: 'Optional saga task ID to scope the autopilot run (default: auto-select)',
      required: false,
    },
    headless: {
      type: 'boolean',
      description: 'Suppress interactive annotations; suitable for daemon / unattended use',
      required: false,
    },
  },
  async run({ args }) {
    const projectRoot = getProjectRoot();
    const result = await go.cleoGo({
      sagaId: typeof args.saga === 'string' && args.saga.length > 0 ? args.saga : undefined,
      headless: args.headless === true,
      projectRoot,
    });
    cliOutput(result.success ? result.data : result, { command: 'go', operation: 'go.run' });
  },
});
