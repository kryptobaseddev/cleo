/**
 * Self-improvement Domain Handler (Dispatch Layer · T11889 · T11889-D).
 *
 * Handles `cleo selfimprove run` dispatch operations:
 *
 * MUTATE operations:
 *   run — boot ONE sandbox, replay a canned dogfood scenario, diff vs golden;
 *         on regression emit ONE leased `selfimprove_dhq` row + ONE DRAFT PR.
 *         DEFAULT OFF — without `execute` the loop runs DRY-RUN.
 *
 * This handler is a **thin delegate** (Gate-6 — no standalone helper logic
 * > 30 LOC lives here): the entire engine (boot → replay → diff → persist →
 * egress, plus the budget caps and circuit-breaker) lives in CORE
 * (`runSelfImprove`). The handler's ONLY responsibilities are (1) param
 * validation and (2) constructing the in-process `ReplayDispatch` port —
 * a thin closure over the cleo-resident `Dispatcher` — and injecting it into
 * the CORE engine (dependency inversion; `core` never imports the dispatcher,
 * P5 self-improvement spec §B.0.1).
 *
 * The `ReplayDispatch` closure is built LAZILY (inside `mutate`, after param
 * validation passes) so the cleo↔core dispatcher binding never executes for a
 * missing-param request — and the lazy `import('../adapters/cli.js')` avoids a
 * static import cycle (`cli.js` → `createDomainHandlers` → this handler).
 *
 * @epic T11889
 * @task T11914
 */

import { randomUUID } from 'node:crypto';
import type {
  ReplayDispatch,
  ReplayDispatchOp,
  RunSelfImproveOptions,
} from '@cleocode/core/internal';
import {
  buildProbePayload,
  getLogger,
  getProjectRoot,
  runSelfImprove,
} from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, unsupportedOp, wrapResult } from './_base.js';

const log = getLogger('domain:selfimprove');

/**
 * Dispatch domain handler for the self-improvement loop (`selfimprove.run`).
 *
 * Registered under the `selfimprove` domain key in the domain handler registry.
 * Pure delegate to the CORE `runSelfImprove` engine.
 *
 * @task T11914
 */
export class SelfimproveHandler implements DomainHandler {
  /**
   * Handle self-improvement query operations.
   *
   * Supported operations:
   * - `probe` — return the probe payload from {@link buildProbePayload} (T11988).
   *   Used by the `seeded-code-regression` scenario to expose a patchable code
   *   bug (the probe version off-by-one) for end-to-end fix-gen proof.
   */
  async query(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    switch (operation) {
      case 'probe':
        return wrapResult(
          { success: true, data: buildProbePayload() },
          'query',
          'selfimprove',
          operation,
          startTime,
        );
      default:
        return unsupportedOp('query', 'selfimprove', operation, startTime);
    }
  }

  /**
   * Handle self-improvement mutations.
   *
   * Supported operations:
   * - `run` — delegate to CORE `runSelfImprove`, supplying the in-process
   *   `ReplayDispatch` port. DEFAULT OFF: mutation/egress require `execute`.
   *
   * Param validation runs FIRST: a missing `scenario` returns `E_INVALID_INPUT`
   * before any engine call or dispatcher binding — so the registry-parity test
   * (which invokes `run` with empty params) exercises the case without booting
   * a sandbox.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    switch (operation) {
      case 'run': {
        const scenario = typeof params?.scenario === 'string' ? params.scenario : undefined;
        if (!scenario) {
          return errorResult(
            'mutate',
            'selfimprove',
            operation,
            'E_INVALID_INPUT',
            'scenario is required',
            startTime,
          );
        }

        const execute = params?.execute === true;
        const dryRun = params?.dryRun === true;
        const backend = normalizeBackend(params?.backend);

        // Build the in-process ReplayDispatch port — a thin closure over the
        // cleo-resident Dispatcher. Lazy import breaks the static cycle and
        // never runs for a missing-param request (handled above).
        const { getCliDispatcher } = await import('../adapters/cli.js');
        const dispatcher = getCliDispatcher();
        const dispatch: ReplayDispatch = (op: ReplayDispatchOp): Promise<DispatchResponse> =>
          dispatcher.dispatch({
            gateway: op.gateway,
            domain: op.domain,
            operation: op.operation,
            ...(op.params !== undefined ? { params: op.params } : {}),
            source: 'rpc',
            requestId: randomUUID(),
          });

        try {
          const opts: RunSelfImproveOptions = {
            scenario,
            dispatch,
            // `--dry-run` forces DRY-RUN even if `--execute` was also passed;
            // the loop is default-OFF so omitting `--execute` already means dry.
            execute: execute && !dryRun,
            cwd: getProjectRoot(),
            ...(backend !== undefined ? { backend } : {}),
          };
          const result = await runSelfImprove(opts);
          return wrapResult(
            { success: true, data: result },
            'mutate',
            'selfimprove',
            operation,
            startTime,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error({ scenario, err: message }, 'selfimprove.run failed');
          return errorResult('mutate', 'selfimprove', operation, 'E_INTERNAL', message, startTime);
        }
      }

      default:
        return unsupportedOp('mutate', 'selfimprove', operation, startTime);
    }
  }

  /** Return declared operations for introspection and registry validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['probe'],
      mutate: ['run'],
    };
  }
}

/**
 * Normalize the CLI `--backend` value to the CORE `ExecutionEnvBackend` union.
 *
 * Accepts the user-facing aliases (`guarded` ⇒ `in-process`) and the canonical
 * values; anything else falls through to `undefined` so the engine applies its
 * own default (`gondolin`, which itself degrades to the guarded env in CI).
 */
function normalizeBackend(value: unknown): RunSelfImproveOptions['backend'] {
  if (value === 'gondolin') return 'gondolin';
  if (value === 'in-process' || value === 'guarded') return 'in-process';
  return undefined;
}
