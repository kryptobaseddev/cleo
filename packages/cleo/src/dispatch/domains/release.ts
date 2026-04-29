/**
 * Release Domain Handler (Dispatch Layer)
 *
 * Handles `cleo release <operation>` dispatch for the two RELEASE-03/RELEASE-07
 * acceptance criteria that were not implemented in the original T820 epic:
 *
 * QUERY operations:
 *   gate           — check all IVTR loops in a release epic are `released`
 *   ivtr-suggest   — query whether all sibling tasks in an epic are
 *                    released and emit a `cleo release ship` suggestion
 *
 * MUTATE operations (same as query — no DB writes):
 *   gate           — same semantics as query.gate; safe in both gateways
 *   ivtr-suggest   — same semantics as query.ivtr-suggest; safe in both gateways
 *
 * All other release operations (prepare, changelog, commit, tag, push, ship,
 * rollback) are handled by the CLI command layer directly and are NOT routed
 * through this dispatch handler.
 *
 * Type-safe dispatch via OpsFromCore<typeof coreOps> per ADR-058.
 * Param extraction inferred by coreOps — zero `params?.x as Type` casts.
 * Engine result fields (fix, exitCode, details) preserved via wrapResult.
 *
 * @task T820 RELEASE-03
 * @task T820 RELEASE-07
 * @task T1416
 * @task T1543 — OpsFromCore migration per ADR-058
 */

import type { ReleaseGateCheckParams } from '@cleocode/contracts/operations/release';
import { getLogger, getProjectRoot } from '@cleocode/core/internal';
import type { OpsFromCore } from '../adapters/typed.js';
import { releaseGateCheck, releaseIvtrAutoSuggest } from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

const log = getLogger('domain:release');

// ---------------------------------------------------------------------------
// Local param types — ops not yet in @cleocode/contracts
// ---------------------------------------------------------------------------

/** Params for `release.ivtr-suggest` operation. */
interface ReleaseIvtrSuggestParams {
  /** Task ID that just reached the `released` phase. */
  taskId: string;
}

// ---------------------------------------------------------------------------
// Core op wrappers — single-param functions for OpsFromCore inference
//
// Engine functions use positional args (epicId, force, projectRoot). These
// thin wrappers normalise to single-object params so OpsFromCore can infer
// the full typed record (matching the pipeline.ts canonical pattern).
// Engine results include `fix`, `exitCode`, `details` — preserved by wrapResult.
// ---------------------------------------------------------------------------

/** @task T1543 */
async function releaseGateOp(params: ReleaseGateCheckParams) {
  return releaseGateCheck(params.epicId, params.force ?? false, getProjectRoot());
}

/** @task T1543 */
async function releaseIvtrSuggestOp(params: ReleaseIvtrSuggestParams) {
  return releaseIvtrAutoSuggest(params.taskId, getProjectRoot());
}

// ---------------------------------------------------------------------------
// Core op registry — OpsFromCore inference source
// ---------------------------------------------------------------------------

/**
 * Release operation registry for `OpsFromCore<typeof coreOps>` inference.
 *
 * @task T1543 — release dispatch OpsFromCore migration
 */
const coreOps = {
  gate: releaseGateOp,
  'ivtr-suggest': releaseIvtrSuggestOp,
} as const;

// ---------------------------------------------------------------------------
// Typed operation record (public — for testing and downstream inference)
// ---------------------------------------------------------------------------

/** Inferred typed operation record for the release domain (ADR-058 · T1543). */
export type ReleaseOps = OpsFromCore<typeof coreOps>;

// ---------------------------------------------------------------------------
// ReleaseHandler
// ---------------------------------------------------------------------------

/**
 * Dispatch domain handler for IVTR-integration release operations.
 *
 * Registered under the `release` domain key in the domain handler registry.
 * Implements the two acceptance criteria gaps from T820 that were identified
 * by the 2026-04-24 Council audit (T1216):
 *
 * - **RELEASE-03** (`release.gate`): Pre-ship IVTR state validation.
 * - **RELEASE-07** (`release.ivtr-suggest`): Auto-suggestion when IVTR loop
 *   reaches `released`.
 *
 * Uses coreOps wrapper functions for type-safe param access (no `as string`
 * casts). Delegates to `wrapResult` to preserve engine error fields
 * (`fix`, `exitCode`, `details`) that typed envelope would otherwise strip.
 *
 * @task T1543 — OpsFromCore migration per ADR-058
 */
export class ReleaseHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // query — read-only
  // -----------------------------------------------------------------------

  /**
   * Handle read-only release queries.
   *
   * Supported operations:
   * - `gate`         — check IVTR phase state for all tasks in a release epic
   * - `ivtr-suggest` — check if all epic tasks are released and suggest `release ship`
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // release.gate — IVTR gate check (RELEASE-03)
        case 'gate': {
          // Type-safe param extraction via coreOps inferred types (no `as string` cast)
          const typed = params as unknown as ReleaseGateCheckParams;
          if (!typed?.epicId)
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          return wrapResult(await coreOps.gate(typed), 'query', 'release', operation, startTime);
        }

        // release.ivtr-suggest — IVTR auto-suggest (RELEASE-07)
        case 'ivtr-suggest': {
          const typed = params as unknown as ReleaseIvtrSuggestParams;
          if (!typed?.taskId)
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          return wrapResult(
            await coreOps['ivtr-suggest'](typed),
            'query',
            'release',
            operation,
            startTime,
          );
        }

        default:
          return unsupportedOp('query', 'release', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'ReleaseHandler query error');
      return handleErrorResult('query', 'release', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // mutate — state-modifying
  // -----------------------------------------------------------------------

  /**
   * Handle state-modifying release mutations.
   *
   * Note: `release.gate` and `release.ivtr-suggest` do not write any state.
   * They are exposed in the `mutate` gateway to allow automated pipelines
   * (e.g. playbook action blocks) to call them without changing gateway.
   *
   * Supported operations:
   * - `gate`         — same IVTR gate check as query.gate (no DB writes)
   * - `ivtr-suggest` — same auto-suggest as query.ivtr-suggest (no DB writes)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // release.gate — IVTR gate check (RELEASE-03, no DB writes)
        case 'gate': {
          const typed = params as unknown as ReleaseGateCheckParams;
          if (!typed?.epicId)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          return wrapResult(await coreOps.gate(typed), 'mutate', 'release', operation, startTime);
        }

        // release.ivtr-suggest — IVTR auto-suggest (RELEASE-07, no DB writes)
        case 'ivtr-suggest': {
          const typed = params as unknown as ReleaseIvtrSuggestParams;
          if (!typed?.taskId)
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          return wrapResult(
            await coreOps['ivtr-suggest'](typed),
            'mutate',
            'release',
            operation,
            startTime,
          );
        }

        default:
          return unsupportedOp('mutate', 'release', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'ReleaseHandler mutate error');
      return handleErrorResult('mutate', 'release', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  /** Return declared operations for introspection and registry validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['gate', 'ivtr-suggest'],
      mutate: ['gate', 'ivtr-suggest'],
    };
  }
}
