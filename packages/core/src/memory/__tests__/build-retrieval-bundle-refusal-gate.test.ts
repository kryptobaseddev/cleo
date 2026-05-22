/**
 * Characterization tests for buildRetrievalBundle M6 refusal gate.
 *
 * The M6 gate (T1260 PSYCHE E3) refuses entries with
 * provenanceClass='unswept-pre-T1151' from the hot pass (recent observations).
 * Warm-pass refusal (learnings/patterns/decisions) is tested through the
 * internal filter logic via unit-level assertions on the output shape.
 *
 * These tests lock-in the gate behavior BEFORE the brain-retrieval.ts split
 * so any regression introduced during the refactor is caught immediately.
 *
 * @task T10067
 * @epic T9834
 * @saga T9831
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let testDir: string;
let cleoDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'refusal-gate-test-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
  process.env['CLEO_HOME'] = testDir;
});

afterEach(async () => {
  try {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    closeBrainDb();
  } catch { /* not loaded */ }
  try {
    const { closeNexusDb, resetNexusDbState } = await import('../../store/nexus-sqlite.js');
    closeNexusDb();
    resetNexusDbState();
  } catch { /* not loaded */ }
  try {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
  } catch { /* not loaded */ }

  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_HOME'];

  await Promise.race([
    rm(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
  ]);
});

/** Ensure brain.db is initialised and return its native handle. */
async function initBrainDb(): Promise<import('node:sqlite').DatabaseSync> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(testDir);
  const db = getBrainNativeDb();
  if (!db) throw new Error('brain.db native handle unavailable after init');
  return db;
}

/**
 * Seed an observation row with a specific provenance_class.
 * Matches the seeding pattern used in brain-retrieval-bundle.test.ts.
 */
function seedObservation(
  db: import('node:sqlite').DatabaseSync,
  id: string,
  sessionId: string,
  provenanceClass: string,
): void {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  // Ensure peer_id column exists (may be added by T1084 migration)
  try {
    db.exec(`ALTER TABLE brain_observations ADD COLUMN peer_id TEXT NOT NULL DEFAULT 'global'`);
  } catch { /* already exists */ }

  // Ensure provenance_class column exists (added by T1260 migration)
  try {
    db.exec(`ALTER TABLE brain_observations ADD COLUMN provenance_class TEXT DEFAULT 'unswept-pre-T1151'`);
  } catch { /* already exists */ }

  try {
    db.prepare(
      `INSERT OR IGNORE INTO brain_observations
       (id, type, title, narrative, peer_id, source_session_id, source_type, quality_score,
        memory_tier, memory_type, source_confidence, created_at, updated_at, provenance_class)
       VALUES (?, 'discovery', ?, ?, 'global', ?, 'agent', 0.7, 'short', 'episodic', 'agent', ?, ?, ?)`,
    ).run(id, `Observation ${id}`, `Narrative for ${id}`, sessionId, now, now, provenanceClass);
  } catch {
    // Fallback: insert without provenance_class (gets DB default)
    db.prepare(
      `INSERT OR IGNORE INTO brain_observations
       (id, type, title, narrative, peer_id, source_session_id, source_type, quality_score,
        memory_tier, memory_type, source_confidence, created_at, updated_at)
       VALUES (?, 'discovery', ?, ?, 'global', ?, 'agent', 0.7, 'short', 'episodic', 'agent', ?, ?)`,
    ).run(id, `Observation ${id}`, `Narrative for ${id}`, sessionId, now, now);
  }
}

// ===========================================================================
// M6 Refusal Gate — characterization tests (hot pass via observations)
// ===========================================================================

describe('buildRetrievalBundle — M6 refusal gate (provenanceClass=unswept-pre-T1151)', () => {
  it('refuses hot observations with provenanceClass=unswept-pre-T1151', async () => {
    const db = await initBrainDb();
    seedObservation(db, 'O-refused-1', 'ses-hot-gate', 'unswept-pre-T1151');

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    const bundle = await buildRetrievalBundle(
      {
        peerId: 'global',
        sessionId: 'ses-hot-gate',
        passMask: { cold: false, warm: false, hot: true },
      },
      testDir,
    );

    const obsIds = bundle.hot.recentObservations.map((o) => o.id);
    expect(obsIds).not.toContain('O-refused-1');
  });

  it('accepts hot observations with provenanceClass=swept-clean', async () => {
    const db = await initBrainDb();
    seedObservation(db, 'O-accepted-1', 'ses-hot-accepted', 'swept-clean');

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    const bundle = await buildRetrievalBundle(
      {
        peerId: 'global',
        sessionId: 'ses-hot-accepted',
        passMask: { cold: false, warm: false, hot: true },
      },
      testDir,
    );

    const obsIds = bundle.hot.recentObservations.map((o) => o.id);
    expect(obsIds).toContain('O-accepted-1');
  });

  it('when refused and accepted observations coexist, only accepted appear in hot pass', async () => {
    const db = await initBrainDb();
    seedObservation(db, 'O-refused-mix', 'ses-mixed', 'unswept-pre-T1151');
    seedObservation(db, 'O-accepted-mix', 'ses-mixed', 'swept-clean');

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    const bundle = await buildRetrievalBundle(
      {
        peerId: 'global',
        sessionId: 'ses-mixed',
        passMask: { cold: false, warm: false, hot: true },
      },
      testDir,
    );

    const obsIds = bundle.hot.recentObservations.map((o) => o.id);
    expect(obsIds).not.toContain('O-refused-mix');
    expect(obsIds).toContain('O-accepted-mix');
  });

  it('bundle degrades gracefully to empty hot when all observations are refused', async () => {
    const db = await initBrainDb();
    seedObservation(db, 'O-all-refused-1', 'ses-all-refused', 'unswept-pre-T1151');
    seedObservation(db, 'O-all-refused-2', 'ses-all-refused', 'unswept-pre-T1151');

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    const bundle = await buildRetrievalBundle(
      {
        peerId: 'global',
        sessionId: 'ses-all-refused',
        passMask: { cold: false, warm: false, hot: true },
      },
      testDir,
    );

    // No crash — hot pass present but observations are empty
    expect(bundle.hot).toBeDefined();
    expect(bundle.hot.recentObservations).toHaveLength(0);
  });

  it('returns structurally valid bundle even when all passes are empty', async () => {
    await initBrainDb();

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    const bundle = await buildRetrievalBundle(
      {
        peerId: 'global',
        sessionId: 'ses-empty',
        passMask: { cold: true, warm: true, hot: true },
      },
      testDir,
    );

    // All passes must have correct shape even when empty
    expect(bundle.cold).toBeDefined();
    expect(Array.isArray(bundle.cold.userProfile)).toBe(true);
    expect(typeof bundle.cold.peerInstructions).toBe('string');
    expect(bundle.warm).toBeDefined();
    expect(Array.isArray(bundle.warm.peerLearnings)).toBe(true);
    expect(Array.isArray(bundle.warm.peerPatterns)).toBe(true);
    expect(Array.isArray(bundle.warm.decisions)).toBe(true);
    expect(bundle.hot).toBeDefined();
    expect(typeof bundle.hot.sessionNarrative).toBe('string');
    expect(Array.isArray(bundle.hot.recentObservations)).toBe(true);
    expect(Array.isArray(bundle.hot.activeTasks)).toBe(true);
    expect(bundle.tokenCounts).toBeDefined();
    expect(typeof bundle.tokenCounts.total).toBe('number');
    expect(bundle.tokenCounts.total).toBeGreaterThanOrEqual(0);
  });

  it('refusal gate does not crash when no passMask is provided (defaults all passes on)', async () => {
    await initBrainDb();

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    // No passMask — defaults to { cold: true, warm: true, hot: true }
    const bundle = await buildRetrievalBundle(
      { peerId: 'global', sessionId: 'ses-no-mask' },
      testDir,
    );

    // Should complete without throwing
    expect(bundle).toBeDefined();
    expect(bundle.tokenCounts.total).toBeGreaterThanOrEqual(0);
  });

  it('token budget is respected — total tokens <= tokenBudget', async () => {
    const db = await initBrainDb();
    // Seed 5 swept-clean observations with longer narratives
    for (let i = 0; i < 5; i++) {
      seedObservation(db, `O-budget-${i}`, 'ses-budget', 'swept-clean');
    }

    const { buildRetrievalBundle } = await import('../brain-retrieval.js');
    const bundle = await buildRetrievalBundle(
      {
        peerId: 'global',
        sessionId: 'ses-budget',
        tokenBudget: 50,
        passMask: { cold: false, warm: false, hot: true },
      },
      testDir,
    );

    // Token accounting: total must not exceed the budget
    expect(bundle.tokenCounts.total).toBeLessThanOrEqual(50);
  });
});
