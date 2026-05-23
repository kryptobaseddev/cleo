/**
 * `cleo release ship-e2e-smoke` — one-shot walker that validates the
 * full release lifecycle.
 *
 * Thin CLI wrapper: every step of the smoke flow lives in
 * `packages/core/src/release/ship-e2e-smoke.ts` so the handler stays
 * inside the CLI Package-Boundary lint budget. This file only:
 *
 *   1. Parses CLI args
 *   2. Constructs the default real `SmokeEnvironment`
 *   3. Delegates to `runShipE2eSmoke`
 *   4. Emits the LAFS envelope via `cliOutput` / `cliError`
 *
 * @task T10103
 * @epic E-CLEO-RELEASE-VERBS
 * @saga T10099
 */

import type { ShipE2eSmokeParams } from '@cleocode/contracts';
import { createDefaultSmokeEnvironment, runShipE2eSmoke } from '@cleocode/core';
import { defineCommand } from '../../lib/define-cli-command.js';
import { cliError, cliOutput } from '../../renderers/index.js';

/** `cleo release ship-e2e-smoke <version> --epic <id> [--execute]` */
export const shipE2eSmokeCommand = defineCommand({
  meta: {
    name: 'ship-e2e-smoke',
    description:
      'One-shot end-to-end release smoke: plan → open → wait-for-PR → wait-for-tag → verify-npm-published. ' +
      'Dry-run by default; pass --execute to perform real mutations (T10103).',
  },
  args: {
    version: {
      type: 'positional',
      description: 'Candidate release version (e.g. v2026.6.0 or 2026.6.0)',
      required: true,
    },
    epic: {
      type: 'string',
      description: 'Epic task ID (forwarded to release plan)',
      required: true,
    },
    execute: {
      type: 'boolean',
      description: 'Actually perform mutations (default: dry-run preview only)',
    },
    'poll-interval-ms': {
      type: 'string',
      description: 'Polling interval for wait-* steps (default 5000)',
    },
    'total-timeout-ms': {
      type: 'string',
      description: 'Wall-clock budget across all polling waits (default 1800000 = 30 min)',
    },
  },
  async run({ args }) {
    const pollIntervalMs = args['poll-interval-ms']
      ? Number.parseInt(args['poll-interval-ms'] as string, 10)
      : undefined;
    const totalTimeoutMs = args['total-timeout-ms']
      ? Number.parseInt(args['total-timeout-ms'] as string, 10)
      : undefined;

    const params: ShipE2eSmokeParams = {
      version: args.version,
      epicId: args.epic,
      execute: args.execute === true,
      ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
      ...(totalTimeoutMs !== undefined ? { totalTimeoutMs } : {}),
    };

    const env = createDefaultSmokeEnvironment();
    const result = await runShipE2eSmoke(params, env);

    if (result.success) {
      cliOutput(result, { command: 'release', operation: 'release.ship-e2e-smoke' });
      return;
    }
    const failed = result.steps.find((s) => s.status === 'failed');
    cliError(
      `ship-e2e-smoke step "${failed?.name ?? 'unknown'}" failed: ${failed?.error ?? 'see envelope'}`,
      'E_SHIP_E2E_SMOKE_FAILED',
      { name: 'E_SHIP_E2E_SMOKE_FAILED', details: result },
      { operation: 'release.ship-e2e-smoke' },
    );
    process.exit(1);
  },
});
