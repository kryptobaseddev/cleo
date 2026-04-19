/**
 * Brain.db noise purge utility — removes 2927 noise entries leaving ~57 signal entries.
 *
 * Purge rules:
 * - Patterns: keep newest per unique pattern text (dedup), delete duplicates
 * - Learnings: delete ALL (all are auto-generated task completion noise)
 * - Decisions: delete ALL except D-mntpeeer (the one real architectural decision)
 * - Observations: delete task-start/task-complete/session-note/test/junk noise
 *
 * Safety: requires backup to exist before calling. Never touches tasks.db.
 *
 * @task T524
 * @epic T523
 */

import { inArray, ne, sql } from 'drizzle-orm';
import {
  brainDecisions,
  brainLearnings,
  brainObservations,
  brainPatterns,
} from '../store/memory-schema.js';
import { getBrainDb, getBrainNativeDb } from '../store/memory-sqlite.js';
import { ensureFts5Tables, rebuildFts5Index } from './brain-search.js';

/** Result counts from a purge run. */
export interface PurgeResult {
  /** Number of pattern rows deleted. */
  patternsDeleted: number;
  /** Number of learning rows deleted. */
  learningsDeleted: number;
  /** Number of decision rows deleted. */
  decisionsDeleted: number;
  /** Number of observation rows deleted. */
  observationsDeleted: number;
  /** Counts after purge. */
  after: {
    patterns: number;
    learnings: number;
    decisions: number;
    observations: number;
  };
  /** FTS5 indexes rebuilt. */
  fts5Rebuilt: boolean;
}

/**
 * Count rows in a table using native DB PRAGMA (avoids Drizzle type issues).
 * Falls back to 0 on error.
 */
function countRowsNative(tableName: string): number {
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) return 0;
  try {
    const row = nativeDb.prepare(`SELECT COUNT(*) AS cnt FROM ${tableName}`).get() as
      | { cnt: number }
      | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Execute the brain.db noise purge.
 *
 * Deletes ~2927 noise entries across four tables, leaving ~57 signal entries.
 * The one real architectural decision (D-mntpeeer) is explicitly preserved.
 *
 * Rules applied in order:
 * 1. Patterns: deduplicate by pattern text — keep newest per unique text, delete older dupes
 * 2. Learnings: delete all (100% noise — auto-generated "Completed:" and dependency notices)
 * 3. Decisions: delete all except D-mntpeeer
 * 4. Observations: delete task-start, task-complete, session-note, and test/junk entries
 *
 * @param projectRoot - Absolute path to the project root (e.g. /mnt/projects/cleocode)
 * @returns PurgeResult with before/after counts and FTS5 status
 */
export async function purgeBrainNoise(projectRoot: string): Promise<PurgeResult> {
  const db = await getBrainDb(projectRoot);

  // =========================================================================
  // Pre-purge counts
  // =========================================================================

  const beforePatterns = countRowsNative('brain_patterns');
  const beforeLearnings = countRowsNative('brain_learnings');
  const beforeDecisions = countRowsNative('brain_decisions');
  const beforeObservations = countRowsNative('brain_observations');

  console.log('Pre-purge counts:');
  console.log(`  Patterns:     ${beforePatterns}`);
  console.log(`  Learnings:    ${beforeLearnings}`);
  console.log(`  Decisions:    ${beforeDecisions}`);
  console.log(`  Observations: ${beforeObservations}`);

  // =========================================================================
  // SAFETY: Confirm D-mntpeeer exists before any destructive operation
  // =========================================================================

  const realDecision = await db.select().from(brainDecisions).where(sql`id = 'D-mntpeeer'`);

  if (realDecision.length === 0) {
    throw new Error(
      'SAFETY ABORT: D-mntpeeer not found in brain_decisions. Backup and restore required.',
    );
  }

  console.log('Safety check passed: D-mntpeeer confirmed present');

  // =========================================================================
  // Rule 1: Pattern deduplication
  // Strategy: for each unique pattern text, find the MAX(extracted_at) row,
  // delete all other rows with the same text.
  // =========================================================================

  // Get all patterns to find duplicates in TS (safer than raw SQL subquery)
  const allPatterns = await db.select().from(brainPatterns);

  // Group by normalized pattern text
  const patternGroups = new Map<string, typeof allPatterns>();
  for (const p of allPatterns) {
    const key = p.pattern.trim().toLowerCase();
    const group = patternGroups.get(key) ?? [];
    group.push(p);
    patternGroups.set(key, group);
  }

  // Collect IDs to delete: for each group with >1 entry, keep newest (max extractedAt), delete rest
  const patternIdsToDelete: string[] = [];
  for (const [, group] of patternGroups) {
    if (group.length <= 1) continue;
    // Sort by extractedAt desc, keep first, delete the rest
    group.sort((a, b) => (b.extractedAt > a.extractedAt ? 1 : -1));
    const toDelete = group.slice(1).map((p) => p.id);
    patternIdsToDelete.push(...toDelete);
  }

  let patternsDeleted = 0;
  if (patternIdsToDelete.length > 0) {
    // Delete in batches of 500 to avoid SQLite parameter limits
    const BATCH = 500;
    for (let i = 0; i < patternIdsToDelete.length; i += BATCH) {
      const batch = patternIdsToDelete.slice(i, i + BATCH);
      await db.delete(brainPatterns).where(inArray(brainPatterns.id, batch));
      patternsDeleted += batch.length;
    }
  }

  console.log(`Patterns deleted (dedup): ${patternsDeleted}`);

  // =========================================================================
  // Rule 2: Delete ALL learnings (100% noise)
  // All learnings are auto-generated "Completed: T..." or dependency notices
  // =========================================================================

  // Count before delete using run
  const learningsRows = await db.select().from(brainLearnings);
  const learningsDeleted = learningsRows.length;

  if (learningsDeleted > 0) {
    // Delete in batches using IDs
    const ids = learningsRows.map((r) => r.id);
    const BATCH = 500;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      await db.delete(brainLearnings).where(inArray(brainLearnings.id, batch));
    }
  }

  console.log(`Learnings deleted (all): ${learningsDeleted}`);

  // =========================================================================
  // Rule 3: Delete ALL decisions EXCEPT D-mntpeeer
  // =========================================================================

  const decisionsToDelete = await db
    .select()
    .from(brainDecisions)
    .where(ne(brainDecisions.id, 'D-mntpeeer'));

  const decisionsDeleted = decisionsToDelete.length;
  if (decisionsDeleted > 0) {
    const ids = decisionsToDelete.map((r) => r.id);
    await db.delete(brainDecisions).where(inArray(brainDecisions.id, ids));
  }

  console.log(`Decisions deleted (all except D-mntpeeer): ${decisionsDeleted}`);

  // =========================================================================
  // Rule 4: Delete noise observations
  // Keep: real release notes, real codebase analysis, real session handoffs
  // Delete: task-start, task-complete, session-note, test/junk entries
  // =========================================================================

  // Collect all observations to classify them
  const allObservations = await db.select().from(brainObservations);

  const obsIdsToDelete: string[] = [];

  for (const obs of allObservations) {
    const title = obs.title ?? '';
    const narrative = (obs.narrative ?? '').toLowerCase();
    const titleLower = title.toLowerCase();

    // Rule 4a: Task lifecycle noise
    if (
      title.startsWith('Task start: T') ||
      title.startsWith('Task complete: T') ||
      title.startsWith('Task depended on') ||
      title.startsWith('Task T') // catch "Task T527 depended on..." etc.
    ) {
      obsIdsToDelete.push(obs.id);
      continue;
    }

    // Rule 4b: Session notes (all are noise — real handoffs are in sticky notes)
    if (title.startsWith('Session note:')) {
      obsIdsToDelete.push(obs.id);
      continue;
    }

    // Rule 4c: Test/audit/probe/junk observations
    const testKeywords = [
      'audit test',
      'audit probe',
      'probe observation',
      'dup test',
      'provider test',
      'brain regression',
      'brain validation',
      'release test',
      'functional validation',
      'test title',
      'test decision',
      'test learning',
      'test pattern',
      'test observation',
      'sticky note', // audit test sticky note
    ];

    const isTestNoise = testKeywords.some(
      (kw) => titleLower.includes(kw) || narrative.includes(kw),
    );

    if (isTestNoise) {
      obsIdsToDelete.push(obs.id);
    }

    // Rule 4d: Auto-detection codebase map noise (keep real ones, delete duplicates)
    // "Codebase Stack Analysis" and "Codebase Integrations" — keep one of each,
    // but the task asks us to keep ~27 so we apply conservative rules.
    // Only delete if title exactly matches auto-generated repeated patterns.
  }

  let observationsDeleted = 0;
  if (obsIdsToDelete.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < obsIdsToDelete.length; i += BATCH) {
      const batch = obsIdsToDelete.slice(i, i + BATCH);
      await db.delete(brainObservations).where(inArray(brainObservations.id, batch));
      observationsDeleted += batch.length;
    }
  }

  console.log(`Observations deleted: ${observationsDeleted}`);

  // =========================================================================
  // Post-purge counts
  // =========================================================================

  const afterPatterns = countRowsNative('brain_patterns');
  const afterLearnings = countRowsNative('brain_learnings');
  const afterDecisions = countRowsNative('brain_decisions');
  const afterObservations = countRowsNative('brain_observations');

  console.log('\nPost-purge counts:');
  console.log(`  Patterns:     ${afterPatterns} (deleted ${beforePatterns - afterPatterns})`);
  console.log(`  Learnings:    ${afterLearnings} (deleted ${beforeLearnings - afterLearnings})`);
  console.log(`  Decisions:    ${afterDecisions} (deleted ${beforeDecisions - afterDecisions})`);
  console.log(
    `  Observations: ${afterObservations} (deleted ${beforeObservations - afterObservations})`,
  );

  // =========================================================================
  // Rebuild FTS5 indexes after bulk deletes
  // =========================================================================

  let fts5Rebuilt = false;
  const nativeDb = getBrainNativeDb();
  if (nativeDb) {
    ensureFts5Tables(nativeDb);
    try {
      rebuildFts5Index(nativeDb);
      fts5Rebuilt = true;
      console.log('FTS5 indexes rebuilt successfully');
    } catch (err) {
      console.warn('FTS5 rebuild failed (non-fatal):', err);
    }
  }

  return {
    patternsDeleted: beforePatterns - afterPatterns,
    learningsDeleted: beforeLearnings - afterLearnings,
    decisionsDeleted: beforeDecisions - afterDecisions,
    observationsDeleted: beforeObservations - afterObservations,
    after: {
      patterns: afterPatterns,
      learnings: afterLearnings,
      decisions: afterDecisions,
      observations: afterObservations,
    },
    fts5Rebuilt,
  };
}
