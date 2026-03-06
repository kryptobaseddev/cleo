/**
 * BRAIN lifecycle operations — temporal decay and memory consolidation.
 *
 * Reduces confidence of stale learnings based on age, following an
 * exponential decay model: new_confidence = confidence * (decayRate ^ daysSinceUpdate).
 *
 * Consolidation groups old observations by keyword overlap and merges
 * clusters into summary observations, archiving the originals.
 *
 * @task T5394 T5395
 * @epic T5149
 */

import { createHash } from 'node:crypto';
import { getBrainDb, getBrainNativeDb } from '../../store/brain-sqlite.js';
import { getBrainAccessor } from '../../store/brain-accessor.js';

/** Result from applying temporal decay. */
export interface DecayResult {
  updated: number;
  tablesProcessed: string[];
}

/**
 * Apply temporal decay to brain_learnings confidence values.
 *
 * Entries older than `olderThanDays` have their confidence reduced
 * by an exponential decay factor based on the number of days since
 * their last update (or creation if never updated).
 *
 * Formula: new_confidence = confidence * (decayRate ^ daysSinceUpdate)
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param options - Decay configuration
 * @returns Count of updated rows and tables processed
 */
export async function applyTemporalDecay(
  projectRoot: string,
  options?: { decayRate?: number; olderThanDays?: number },
): Promise<DecayResult> {
  const decayRate = options?.decayRate ?? 0.995;
  const olderThanDays = options?.olderThanDays ?? 30;

  // Ensure brain.db is initialized
  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { updated: 0, tablesProcessed: [] };
  }

  // Calculate the cutoff date
  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  // Update learnings: reduce confidence based on age since last update (or creation).
  // SQLite's julianday function computes the difference in days.
  // We use COALESCE to prefer updated_at over created_at for the age calculation.
  const stmt = nativeDb.prepare(`
    UPDATE brain_learnings
    SET confidence = confidence * POWER(?, julianday('now') - julianday(COALESCE(updated_at, created_at))),
        updated_at = datetime('now')
    WHERE COALESCE(updated_at, created_at) < ?
      AND confidence > 0.01
  `);

  const result = stmt.run(decayRate, cutoffDate);
  const updated = typeof result.changes === 'number' ? result.changes : 0;

  return {
    updated,
    tablesProcessed: ['brain_learnings'],
  };
}

// ============================================================================
// Memory Consolidation (T5395)
// ============================================================================

/** Result from consolidating memories. */
export interface ConsolidationResult {
  grouped: number;
  merged: number;
  archived: number;
}

/** Stop words excluded from keyword extraction. */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both',
  'either', 'neither', 'each', 'every', 'all', 'any', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'only', 'own', 'same', 'than',
  'too', 'very', 'just', 'because', 'until', 'while', 'about', 'against',
  'this', 'that', 'these', 'those', 'it', 'its',
]);

/**
 * Extract significant keywords from text for grouping.
 * Filters stop words and short tokens, returns lowercase words.
 */
function extractKeywords(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/);
  const keywords = new Set<string>();
  for (const w of words) {
    if (w.length >= 4 && !STOP_WORDS.has(w)) {
      keywords.add(w);
    }
  }
  return keywords;
}

/**
 * Calculate keyword overlap ratio between two sets.
 * Returns the Jaccard similarity coefficient.
 */
function keywordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) {
    if (b.has(w)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Consolidate old observations by keyword similarity.
 *
 * Groups observations older than `olderThanDays` by FTS5 keyword overlap.
 * For groups with at least `minClusterSize` entries, creates one summary
 * observation and marks originals as archived (updated_at set, narrative
 * prefixed with [ARCHIVED]).
 *
 * @param projectRoot - Project root directory for brain.db resolution
 * @param options - Consolidation configuration
 * @returns Counts of grouped, merged, and archived observations
 */
export async function consolidateMemories(
  projectRoot: string,
  options?: { olderThanDays?: number; minClusterSize?: number },
): Promise<ConsolidationResult> {
  const olderThanDays = options?.olderThanDays ?? 90;
  const minClusterSize = options?.minClusterSize ?? 3;

  await getBrainDb(projectRoot);
  const nativeDb = getBrainNativeDb();

  if (!nativeDb) {
    return { grouped: 0, merged: 0, archived: 0 };
  }

  const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);

  // Fetch old observations that are not already archived
  const oldObservations = nativeDb.prepare(`
    SELECT id, type, title, narrative, project, created_at
    FROM brain_observations
    WHERE created_at < ?
      AND narrative NOT LIKE '[ARCHIVED]%'
    ORDER BY created_at DESC
  `).all(cutoffDate) as Array<{
    id: string;
    type: string;
    title: string;
    narrative: string | null;
    project: string | null;
    created_at: string;
  }>;

  if (oldObservations.length < minClusterSize) {
    return { grouped: 0, merged: 0, archived: 0 };
  }

  // Extract keywords for each observation
  const entries = oldObservations.map(obs => ({
    ...obs,
    keywords: extractKeywords(`${obs.title} ${obs.narrative ?? ''}`),
    clustered: false,
  }));

  // Greedy clustering: group by keyword overlap >= 0.3
  const clusters: Array<typeof entries> = [];
  const overlapThreshold = 0.3;

  for (let i = 0; i < entries.length; i++) {
    if (entries[i]!.clustered) continue;

    const cluster = [entries[i]!];
    entries[i]!.clustered = true;

    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j]!.clustered) continue;
      if (entries[i]!.type !== entries[j]!.type) continue;

      const overlap = keywordOverlap(entries[i]!.keywords, entries[j]!.keywords);
      if (overlap >= overlapThreshold) {
        cluster.push(entries[j]!);
        entries[j]!.clustered = true;
      }
    }

    if (cluster.length >= minClusterSize) {
      clusters.push(cluster);
    }
  }

  let grouped = 0;
  let merged = 0;
  let archived = 0;
  const accessor = await getBrainAccessor(projectRoot);
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  for (const cluster of clusters) {
    grouped += cluster.length;

    // Create summary observation from cluster
    const titles = cluster.map(c => c.title).join('; ');
    const summaryTitle = `Consolidated: ${cluster[0]!.type} observations (${cluster.length} entries)`;
    const summaryNarrative = `Merged from ${cluster.length} observations: ${titles.slice(0, 500)}`;
    const contentHash = createHash('sha256').update(summaryTitle + summaryNarrative).digest('hex').slice(0, 16);
    const id = `O-${Date.now().toString(36)}`;

    await accessor.addObservation({
      id,
      type: cluster[0]!.type as typeof import('../../store/brain-schema.js').BRAIN_OBSERVATION_TYPES[number],
      title: summaryTitle,
      narrative: summaryNarrative,
      contentHash,
      project: cluster[0]!.project ?? null,
      sourceType: 'agent',
      createdAt: now,
    });
    merged++;

    // Archive originals by prefixing narrative
    for (const obs of cluster) {
      nativeDb.prepare(`
        UPDATE brain_observations
        SET narrative = '[ARCHIVED] ' || COALESCE(narrative, ''),
            updated_at = ?
        WHERE id = ?
      `).run(now, obs.id);
      archived++;
    }
  }

  return { grouped, merged, archived };
}
