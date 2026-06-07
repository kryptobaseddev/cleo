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
 *   - `ivtrFanOut`         — an IVTR cantbook run started for tasks on the
 *                            ready frontier (T11805 — `executePlaybook`)
 *   - `complete`           — no non-terminal sagas remain
 *
 * @task T11494 — E2-CLEO-GO
 * @saga T11492 — SG-AUTOPILOT
 * @task T11805 — IVTR seam: inject the `executePlaybook(ivtr.cantbook)` runner
 */

import { getProjectRoot, go } from '@cleocode/core';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';
import { buildGoIvtrRunner } from './go-ivtr-runner.js';

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

    // Resolve the active session id for IVTR run provenance
    // (`playbook_runs.session_id`). Best-effort: env first (the spawned-agent
    // path), then the persisted active session.
    const { getCurrentSessionId, getActiveSession } = await import('@cleocode/core/internal');
    let sessionId = getCurrentSessionId(projectRoot) ?? undefined;
    if (sessionId === undefined) {
      try {
        const active = await getActiveSession(projectRoot);
        if (active) sessionId = active.id;
      } catch {
        // No active session — session_id stays undefined.
      }
    }

    const params: Parameters<typeof go.cleoGo>[0] = {
      headless: args.headless === true,
      projectRoot,
      ivtrRunner: buildGoIvtrRunner(),
    };
    if (typeof args.saga === 'string' && args.saga.length > 0) params.sagaId = args.saga;
    if (sessionId !== undefined) params.sessionId = sessionId;

    const result = await go.cleoGo(params);
    cliOutput(result.success ? result.data : result, { command: 'go', operation: 'go.run' });
  },
});
