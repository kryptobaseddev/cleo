/**
 * Provenance Domain Handler (Dispatch Layer)
 *
 * Handles `cleo provenance <operation>` dispatch operations:
 *
 * MUTATE operations:
 *   backfill  — Phase 2 of T9493 (T9528). Walks historical git tags from
 *               `since` forward and populates the 11 provenance tables
 *               (commits, task_commits, commit_files, pull_requests,
 *               pr_commits, pr_tasks, releases, release_commits,
 *               release_changes, release_artifacts, brain_release_links) for
 *               every release in the range. UPSERT semantics, idempotent,
 *               restartable via checkpoint at
 *               `.cleo/release/backfill-state.json`.
 *
 * Future verbs (T9529+) will live here too:
 *   verify    — diff DB rows against re-parsed git log per release tag.
 *   repair    — re-reconcile a single tag in place.
 *
 * @task T9528
 * @epic T9493
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §8.3
 */

import { getLogger, getProjectRoot, provenanceBackfill } from '@cleocode/core/internal';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

const log = getLogger('domain:provenance');

/**
 * Dispatch domain handler for the provenance graph maintenance verbs.
 *
 * Registered under the `provenance` domain key in {@link createDomainHandlers}.
 * Currently exposes only the `backfill` mutation; future T9529+ verbs (verify,
 * repair) will land here too.
 *
 * @task T9528
 */
export class ProvenanceHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query — no query operations defined yet (verify lands in T9529)
  // -----------------------------------------------------------------------

  /**
   * Provenance query operations.
   *
   * No query ops are registered in T9528. Returns `E_UNSUPPORTED_OP` for any
   * incoming operation. The `verify` query op will land in T9529.
   */
  async query(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    return unsupportedOp('query', 'provenance', operation, startTime);
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  /**
   * Provenance mutate operations. Currently only `backfill` is implemented.
   *
   * @param operation - The provenance mutate op name (`backfill`).
   * @param params    - The dispatch params object: `since`, `forceOverwrite`,
   *                    `dryRun`, `resetCheckpoint`.
   */
  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // ------------------------------------------------------------------
        // provenance.backfill — T9528 / SPEC-T9345 §8.3
        // ------------------------------------------------------------------
        case 'backfill': {
          // `since` is required (empty string is valid — means "all tags").
          const since = typeof params?.['since'] === 'string' ? params['since'] : undefined;
          if (since === undefined) {
            return errorResult(
              'mutate',
              'provenance',
              operation,
              'E_INVALID_INPUT',
              'since is required (use --since "" to walk every reachable tag)',
              startTime,
            );
          }
          const forceOverwrite =
            typeof params?.['forceOverwrite'] === 'boolean' ? params['forceOverwrite'] : false;
          const dryRun = typeof params?.['dryRun'] === 'boolean' ? params['dryRun'] : false;
          const resetCheckpoint =
            typeof params?.['resetCheckpoint'] === 'boolean' ? params['resetCheckpoint'] : false;

          const result = await provenanceBackfill({
            since,
            projectRoot: getProjectRoot(),
            forceOverwrite,
            dryRun,
            resetCheckpoint,
          });
          return wrapResult(result, 'mutate', 'provenance', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'provenance', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'ProvenanceHandler mutate error');
      return handleErrorResult('mutate', 'provenance', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  /** Return declared operations for introspection and registry validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [],
      mutate: ['backfill'],
    };
  }
}
