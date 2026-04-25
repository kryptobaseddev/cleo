/**
 * Release Domain Handler (Dispatch Layer)
 *
 * Handles `cleo release <operation>` dispatch for the two RELEASE-03/RELEASE-07
 * acceptance criteria that were not implemented in the original T820 epic:
 *
 * QUERY operations:
 *   release.gate       — check all IVTR loops in a release epic are `released`
 *   release.ivtr-suggest — query whether all sibling tasks in an epic are
 *                         released and emit a `cleo release ship` suggestion
 *
 * MUTATE operations (delegated to release-engine for state changes):
 *   release.gate       — same semantics as query but may be triggered as a
 *                        pre-ship check from automated pipelines; no DB writes
 *                        are made, so the operation is safe in both gateways
 *
 * All other release operations (prepare, changelog, commit, tag, push, ship,
 * rollback) are handled by the CLI command layer directly and are NOT routed
 * through this dispatch handler. This handler strictly covers the IVTR
 * integration surface introduced by RELEASE-03 and RELEASE-07.
 *
 * @task T820 RELEASE-03
 * @task T820 RELEASE-07
 * @task T1416
 */

import { getLogger, getProjectRoot } from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, wrapResult } from './_base.js';
import { releaseGateCheck, releaseIvtrAutoSuggest } from '../lib/engine.js';

const log = getLogger('domain:release');

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
        // ------------------------------------------------------------------
        // release.gate — IVTR gate check (RELEASE-03)
        // ------------------------------------------------------------------
        case 'gate': {
          const epicId = params?.['epicId'] as string | undefined;
          if (!epicId) {
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }

          const force = params?.['force'] === true;
          const projectRoot = getProjectRoot();
          const result = await releaseGateCheck(epicId, force, projectRoot);
          return wrapResult(result, 'query', 'release', operation, startTime);
        }

        // ------------------------------------------------------------------
        // release.ivtr-suggest — IVTR auto-suggest (RELEASE-07)
        // ------------------------------------------------------------------
        case 'ivtr-suggest': {
          const taskId = params?.['taskId'] as string | undefined;
          if (!taskId) {
            return errorResult(
              'query',
              'release',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const projectRoot = getProjectRoot();
          const result = await releaseIvtrAutoSuggest(taskId, projectRoot);
          return wrapResult(result, 'query', 'release', operation, startTime);
        }

        default:
          return errorResult(
            'query',
            'release',
            operation,
            'E_INVALID_OPERATION',
            `Unknown release query operation: ${operation}`,
            startTime,
          );
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
   * Note: `release.gate` does not write any state. It is exposed here to
   * allow automated pipelines to call it via the `mutate` gateway (e.g.
   * as a pre-step inside a playbook action block) without needing to
   * change the gateway.
   *
   * Supported operations:
   * - `gate`         — same IVTR gate check as query.gate (no DB writes)
   * - `ivtr-suggest` — same auto-suggest as query.ivtr-suggest (no DB writes)
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // ------------------------------------------------------------------
        // release.gate — IVTR gate check (RELEASE-03)
        // Pre-ship guard: blocks release.ship when tasks are not IVTR released.
        // ------------------------------------------------------------------
        case 'gate': {
          const epicId = params?.['epicId'] as string | undefined;
          if (!epicId) {
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }

          const force = params?.['force'] === true;
          const projectRoot = getProjectRoot();
          const result = await releaseGateCheck(epicId, force, projectRoot);
          return wrapResult(result, 'mutate', 'release', operation, startTime);
        }

        // ------------------------------------------------------------------
        // release.ivtr-suggest — IVTR auto-suggest (RELEASE-07)
        // Triggered after ivtr.release succeeds; checks if all siblings are done.
        // ------------------------------------------------------------------
        case 'ivtr-suggest': {
          const taskId = params?.['taskId'] as string | undefined;
          if (!taskId) {
            return errorResult(
              'mutate',
              'release',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }

          const projectRoot = getProjectRoot();
          const result = await releaseIvtrAutoSuggest(taskId, projectRoot);
          return wrapResult(result, 'mutate', 'release', operation, startTime);
        }

        default:
          return errorResult(
            'mutate',
            'release',
            operation,
            'E_INVALID_OPERATION',
            `Unknown release mutate operation: ${operation}`,
            startTime,
          );
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
