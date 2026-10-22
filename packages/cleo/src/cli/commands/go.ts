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
 *   - `goalHandoff`        — a goal/v1 contract drafted for the ready wave and
 *                            the exact next step for the goal runtime
 *                            (CLEO Goal), or how to install it (T13821)
 *   - `complete`           — no non-terminal sagas remain
 *
 * @task T11494 — E2-CLEO-GO
 * @saga T11492 — SG-AUTOPILOT
 * @task T13821 — repurposed: hand the ready wave to the goal runtime
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
    description:
      'SG-AUTOPILOT: pick the next ready wave, draft its goal/v1 contract and hand it to the goal runtime (CLEO Goal), or say how to install it',
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
    const params: Parameters<typeof go.cleoGo>[0] = {
      headless: args.headless === true,
      projectRoot: getProjectRoot(),
    };
    if (typeof args.saga === 'string' && args.saga.length > 0) params.sagaId = args.saga;

    const result = await go.cleoGo(params);
    cliOutput(result.success ? result.data : result, { command: 'go', operation: 'go.run' });
  },
});
