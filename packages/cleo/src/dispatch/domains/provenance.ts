/**
 * Provenance Domain Handler (Dispatch Layer)
 *
 * Handles `cleo provenance <operation>` dispatch operations:
 *
 * QUERY operations:
 *   verify    — Phase 2 of T9493 (T9529). READ-ONLY audit of the 11
 *               provenance tables for a release. Checks FK integrity,
 *               orphan rows, and ADR-051 evidence-atom staleness.
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
 * Future verbs:
 *   repair    — re-reconcile a single tag in place.
 *
 * @task T9528
 * @task T9529
 * @epic T9493
 * @adr  ADR-T9345 (IVTR-release-overhaul)
 * @spec .cleo/rcasd/T9345/research/SPEC-T9345-release-pipeline-v2.md §4.6, §8.3
 */

import {
  getLogger,
  getProjectRoot,
  provenanceBackfill,
  verifyProvenance,
} from '@cleocode/core/internal';
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
  // Query
  // -----------------------------------------------------------------------

  /**
   * Provenance query operations. Currently only `verify` is implemented.
   *
   * @param operation - The provenance query op name (`verify`).
   * @param params    - The dispatch params object: `version`, `all`, `limit`.
   */
  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        // ------------------------------------------------------------------
        // provenance.verify — T9529 / SPEC-T9345 §4.6
        // ------------------------------------------------------------------
        case 'verify': {
          const version = typeof params?.['version'] === 'string' ? params['version'] : undefined;
          const all = typeof params?.['all'] === 'boolean' ? params['all'] : false;
          const limit = typeof params?.['limit'] === 'number' ? params['limit'] : undefined;

          if (!version && !all) {
            return errorResult(
              'query',
              'provenance',
              operation,
              'E_INVALID_INPUT',
              'verify requires either <version> or --all',
              startTime,
            );
          }

          const result = await verifyProvenance({
            ...(version ? { version } : {}),
            all,
            ...(limit !== undefined ? { limit } : {}),
            projectRoot: getProjectRoot(),
          });
          return wrapResult(result, 'query', 'provenance', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'provenance', operation, startTime);
      }
    } catch (err) {
      log.error({ err, operation }, 'ProvenanceHandler query error');
      return handleErrorResult('query', 'provenance', operation, err, startTime);
    }
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
      query: ['verify'],
      mutate: ['backfill'],
    };
  }
}
