/**
 * BRAIN Timeline — Layer 2 retrieval: chronological context around an anchor entry.
 *
 * @task T5132
 * @epic T5149
 */

import type { TimelineBrainParams, TimelineBrainResult } from '@cleocode/contracts';
import { getBrainAccessor } from '../../store/memory-accessor.js';
import { typedAll } from '../../store/typed-query.js';
import type { BrainTimelineNeighborRow } from '../brain-row-types.js';

/**
 * Determine the entry type from its ID prefix.
 *
 * Conventions:
 * - D... -> decision (D001, D-xxx)
 * - P... -> pattern  (P001, P-xxx)
 * - L... -> learning (L001, L-xxx)
 * - O... or CM-... -> observation (O-xxx, CM-xxx)
 */
export function parseIdPrefix(
  id: string,
): 'decision' | 'pattern' | 'learning' | 'observation' | null {
  if (id.startsWith('D-') || /^D\d/.test(id)) return 'decision';
  if (id.startsWith('P-') || /^P\d/.test(id)) return 'pattern';
  if (id.startsWith('L-') || /^L\d/.test(id)) return 'learning';
  if (id.startsWith('O-') || id.startsWith('O') || id.startsWith('CM-')) return 'observation';
  return null;
}

/**
 * Get chronological context around an anchor entry.
 * Fetches the anchor's full data, then queries all 4 BRAIN tables
 * via UNION ALL to find chronological neighbors.
 *
 * @param projectRoot - Project root directory
 * @param params - Timeline parameters with anchor ID and depth
 * @returns Anchor entry data with surrounding chronological entries
 */
export async function timelineBrain(
  projectRoot: string,
  params: TimelineBrainParams,
): Promise<TimelineBrainResult> {
  const { anchor: anchorId, depthBefore = 3, depthAfter = 3 } = params;

  // Ensure DB is initialized
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { anchor: null, before: [], after: [] };
  }

  // Determine anchor type and fetch it via accessor
  const anchorType = parseIdPrefix(anchorId);
  if (!anchorType) {
    return { anchor: null, before: [], after: [] };
  }

  const accessor = await getBrainAccessor(projectRoot);
  let anchorData: unknown = null;
  let anchorDate: string | null = null;

  switch (anchorType) {
    case 'decision': {
      const row = await accessor.getDecision(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.createdAt;
      }
      break;
    }
    case 'pattern': {
      const row = await accessor.getPattern(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.extractedAt;
      }
      break;
    }
    case 'learning': {
      const row = await accessor.getLearning(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.createdAt;
      }
      break;
    }
    case 'observation': {
      const row = await accessor.getObservation(anchorId);
      if (row) {
        anchorData = row;
        anchorDate = row.createdAt;
      }
      break;
    }
  }

  if (!anchorData || !anchorDate) {
    return { anchor: null, before: [], after: [] };
  }

  // UNION ALL across all 4 tables to get chronological neighbors.
  // Excludes the anchor itself.
  const beforeRows = typedAll<BrainTimelineNeighborRow>(
    nativeDb.prepare(`
    SELECT id, 'decision' AS type, created_at AS date FROM brain_decisions WHERE created_at < ? AND id != ?
    UNION ALL
    SELECT id, 'pattern' AS type, extracted_at AS date FROM brain_patterns WHERE extracted_at < ? AND id != ?
    UNION ALL
    SELECT id, 'learning' AS type, created_at AS date FROM brain_learnings WHERE created_at < ? AND id != ?
    UNION ALL
    SELECT id, 'observation' AS type, created_at AS date FROM brain_observations WHERE created_at < ? AND id != ?
    ORDER BY date DESC
    LIMIT ?
  `),
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    depthBefore,
  );

  const afterRows = typedAll<BrainTimelineNeighborRow>(
    nativeDb.prepare(`
    SELECT id, 'decision' AS type, created_at AS date FROM brain_decisions WHERE created_at > ? AND id != ?
    UNION ALL
    SELECT id, 'pattern' AS type, extracted_at AS date FROM brain_patterns WHERE extracted_at > ? AND id != ?
    UNION ALL
    SELECT id, 'learning' AS type, created_at AS date FROM brain_learnings WHERE created_at > ? AND id != ?
    UNION ALL
    SELECT id, 'observation' AS type, created_at AS date FROM brain_observations WHERE created_at > ? AND id != ?
    ORDER BY date ASC
    LIMIT ?
  `),
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    anchorDate,
    anchorId,
    depthAfter,
  );

  return {
    anchor: { id: anchorId, type: anchorType, data: anchorData },
    before: beforeRows.map((r) => ({ id: r.id, type: r.type, date: r.date })),
    after: afterRows.map((r) => ({ id: r.id, type: r.type, date: r.date })),
  };
}
