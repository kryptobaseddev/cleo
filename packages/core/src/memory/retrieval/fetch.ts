/**
 * BRAIN Fetch — Layer 3 retrieval: batch-fetch full entry details by IDs.
 *
 * @task T5133
 * @epic T5149
 */

import type {
  FetchBrainEntriesParams,
  FetchBrainEntriesResult,
  FetchedBrainEntry,
} from '@cleocode/contracts';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { getCurrentSessionId } from './get-current-session-id.js';
import { incrementCitationCounts } from './increment-citation-counts.js';
import { logRetrieval } from './log-retrieval.js';
import { parseIdPrefix } from './timeline.js';

/**
 * Batch-fetch full details by IDs.
 * Groups IDs by prefix to query the correct tables via BrainDataAccessor.
 *
 * @param projectRoot - Project root directory
 * @param params - Fetch parameters with IDs
 * @returns Full entry data for each found ID, plus not-found list
 */
export async function fetchBrainEntries(
  projectRoot: string,
  params: FetchBrainEntriesParams,
): Promise<FetchBrainEntriesResult> {
  const { ids } = params;

  if (!ids || ids.length === 0) {
    return { results: [], notFound: [], tokensEstimated: 0 };
  }

  const accessor = await getBrainAccessor(projectRoot);

  // Group IDs by type prefix
  const decisionIds: string[] = [];
  const patternIds: string[] = [];
  const learningIds: string[] = [];
  const observationIds: string[] = [];
  const unknownIds: string[] = [];

  for (const id of ids) {
    const type = parseIdPrefix(id);
    switch (type) {
      case 'decision':
        decisionIds.push(id);
        break;
      case 'pattern':
        patternIds.push(id);
        break;
      case 'learning':
        learningIds.push(id);
        break;
      case 'observation':
        observationIds.push(id);
        break;
      default:
        unknownIds.push(id);
    }
  }

  const results: FetchedBrainEntry[] = [];
  const notFound: string[] = [...unknownIds];

  // Fetch decisions
  for (const id of decisionIds) {
    const row = await accessor.getDecision(id);
    if (row) {
      results.push({ id, type: 'decision', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Fetch patterns
  for (const id of patternIds) {
    const row = await accessor.getPattern(id);
    if (row) {
      results.push({ id, type: 'pattern', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Fetch learnings
  for (const id of learningIds) {
    const row = await accessor.getLearning(id);
    if (row) {
      results.push({ id, type: 'learning', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Fetch observations
  for (const id of observationIds) {
    const row = await accessor.getObservation(id);
    if (row) {
      results.push({ id, type: 'observation', data: row });
    } else {
      notFound.push(id);
    }
  }

  // Citation tracking + retrieval logging (non-blocking)
  if (results.length > 0) {
    const fetchedIds = results.map((r) => r.id);
    setImmediate(() => {
      incrementCitationCounts(projectRoot, fetchedIds).catch(() => {});
      getCurrentSessionId(projectRoot)
        .then((sessionId) => {
          return logRetrieval(
            projectRoot,
            fetchedIds.join(','),
            fetchedIds,
            'fetch',
            results.length * 500,
            sessionId,
          );
        })
        .catch(() => {});
    });
  }

  return {
    results,
    notFound,
    tokensEstimated: results.length * 500,
  };
}
