/**
 * T1084/T1085/T1086 — Peer memory isolation tests (PSYCHE Wave 2).
 *
 * Tests that:
 * 1. brain_observations, brain_decisions, brain_patterns, brain_learnings
 *    all have peer_id and peer_scope columns with correct defaults.
 * 2. The search layer (searchBrain) correctly filters by peerId:
 *    - peer A writes observation → peer B cannot see it via peerId filter
 *    - both peers see global-pool entries (peer_id='global')
 *    - omitting peerId returns all entries (backward compat)
 *    - includeGlobal=false excludes global pool
 * 3. T1086: compound index idx_peer_scope is present on all four tables.
 *
 * @task T1084 T1085 T1086
 * @epic T1081
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ============================================================================
// T1084: Schema columns present with correct defaults
// ============================================================================

describe('T1084: peer_id + peer_scope columns on brain tables', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brain-peer-schema-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('brain_observations has peer_id and peer_scope columns with global/project defaults', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    nativeDb!
      .prepare(
        `INSERT INTO brain_observations
           (id, type, title, source_type)
         VALUES (?, 'discovery', 'test obs default', 'agent')`,
      )
      .run('obs-default-1');

    const row = nativeDb!
      .prepare('SELECT peer_id, peer_scope FROM brain_observations WHERE id = ?')
      .get('obs-default-1') as { peer_id: string; peer_scope: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.peer_id).toBe('global');
    expect(row?.peer_scope).toBe('project');
  });

  it('brain_decisions has peer_id and peer_scope with correct defaults', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    nativeDb!
      .prepare(
        `INSERT INTO brain_decisions
           (id, type, decision, rationale, confidence)
         VALUES (?, 'technical', 'use sqlite', 'fast and embedded', 'medium')`,
      )
      .run('dec-default-1');

    const row = nativeDb!
      .prepare('SELECT peer_id, peer_scope FROM brain_decisions WHERE id = ?')
      .get('dec-default-1') as { peer_id: string; peer_scope: string } | undefined;

    expect(row?.peer_id).toBe('global');
    expect(row?.peer_scope).toBe('project');
  });

  it('brain_patterns has peer_id and peer_scope with correct defaults', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    nativeDb!
      .prepare(
        `INSERT INTO brain_patterns
           (id, type, pattern, context)
         VALUES (?, 'workflow', 'always write tests', 'development context')`,
      )
      .run('pat-default-1');

    const row = nativeDb!
      .prepare('SELECT peer_id, peer_scope FROM brain_patterns WHERE id = ?')
      .get('pat-default-1') as { peer_id: string; peer_scope: string } | undefined;

    expect(row?.peer_id).toBe('global');
    expect(row?.peer_scope).toBe('project');
  });

  it('brain_learnings has peer_id and peer_scope with correct defaults', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    nativeDb!
      .prepare(
        `INSERT INTO brain_learnings
           (id, insight, source, confidence)
         VALUES (?, 'test insight here', 'test suite', 0.8)`,
      )
      .run('lrn-default-1');

    const row = nativeDb!
      .prepare('SELECT peer_id, peer_scope FROM brain_learnings WHERE id = ?')
      .get('lrn-default-1') as { peer_id: string; peer_scope: string } | undefined;

    expect(row?.peer_id).toBe('global');
    expect(row?.peer_scope).toBe('project');
  });

  it('explicit peer_id and peer_scope are stored and retrievable', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    nativeDb!
      .prepare(
        `INSERT INTO brain_observations
           (id, type, title, source_type, peer_id, peer_scope)
         VALUES (?, 'discovery', 'peer obs explicit', 'agent', 'cleo-prime', 'peer')`,
      )
      .run('obs-peer-explicit');

    const row = nativeDb!
      .prepare('SELECT peer_id, peer_scope FROM brain_observations WHERE id = ?')
      .get('obs-peer-explicit') as { peer_id: string; peer_scope: string } | undefined;

    expect(row?.peer_id).toBe('cleo-prime');
    expect(row?.peer_scope).toBe('peer');
  });

  it('idx_brain_observations_peer_scope compound index exists', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    const idx = nativeDb!
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_brain_observations_peer_scope'`,
      )
      .get() as { name: string } | undefined;

    expect(idx).toBeDefined();
    expect(idx?.name).toBe('idx_brain_observations_peer_scope');
  });

  it('idx_brain_decisions_peer_scope compound index exists', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb();

    const idx = nativeDb!
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_brain_decisions_peer_scope'`,
      )
      .get() as { name: string } | undefined;

    expect(idx).toBeDefined();
  });
});

// ============================================================================
// T1085: searchBrain peer isolation filter
// ============================================================================

describe('T1085: searchBrain peer_id isolation filter', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'brain-peer-search-'));
    cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    // Reset the module-level FTS5 initialization flag so the next test's
    // fresh DB gets a full FTS rebuild on first searchBrain call.
    const { resetFts5Cache } = await import('../../memory/brain-search.js');
    resetFts5Cache();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Insert a minimal brain_observation row for search testing.
   * Sets quality_score=0.8 to pass the QUALITY_SCORE_THRESHOLD filter.
   */
  function insertObs(
    nativeDb: import('node:sqlite').DatabaseSync,
    id: string,
    titleKey: string,
    peerId: string,
  ): void {
    nativeDb
      .prepare(
        `INSERT INTO brain_observations
           (id, type, title, source_type, peer_id, peer_scope, quality_score)
         VALUES (?, 'discovery', ?, 'agent', ?, 'project', 0.8)`,
      )
      .run(id, titleKey, peerId);
  }

  it('no peerId option returns all entries (backward compat regression test)', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb()!;

    insertObs(nativeDb, 'obs-global-bc', 'peerbc-xyzkey global entry', 'global');
    insertObs(nativeDb, 'obs-prime-bc', 'peerbc-xyzkey prime entry', 'cleo-prime');

    const { searchBrain } = await import('../../memory/brain-search.js');
    const result = await searchBrain(tempDir, 'peerbc-xyzkey');
    const ids = result.observations.map((o) => o.id);

    // Both entries visible when no peer filter
    expect(ids).toContain('obs-global-bc');
    expect(ids).toContain('obs-prime-bc');
  });

  it('peerId filter: peer sees own entries + global, not other peer', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb()!;

    const key = 'peerisolation-testkey-alpha';
    insertObs(nativeDb, 'obs-g-iso', `${key} global share`, 'global');
    insertObs(nativeDb, 'obs-prime-iso', `${key} prime private`, 'cleo-prime');
    insertObs(nativeDb, 'obs-sub-iso', `${key} subagent private`, 'cleo-subagent');

    const { searchBrain } = await import('../../memory/brain-search.js');

    // cleo-prime query: sees global + own, NOT subagent
    const primResult = await searchBrain(tempDir, key, {
      peerId: 'cleo-prime',
      includeGlobal: true,
    });
    const primeIds = primResult.observations.map((o) => o.id);
    expect(primeIds).toContain('obs-g-iso');
    expect(primeIds).toContain('obs-prime-iso');
    expect(primeIds).not.toContain('obs-sub-iso');

    // cleo-subagent query: sees global + own, NOT prime
    const subResult = await searchBrain(tempDir, key, {
      peerId: 'cleo-subagent',
      includeGlobal: true,
    });
    const subIds = subResult.observations.map((o) => o.id);
    expect(subIds).toContain('obs-g-iso');
    expect(subIds).toContain('obs-sub-iso');
    expect(subIds).not.toContain('obs-prime-iso');
  });

  it('includeGlobal=false returns only own peer entries, excludes global pool', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb()!;

    const key = 'peerisolation-strict-beta';
    insertObs(nativeDb, 'obs-g-strict', `${key} global`, 'global');
    insertObs(nativeDb, 'obs-prime-strict', `${key} prime`, 'cleo-prime');

    const { searchBrain } = await import('../../memory/brain-search.js');

    const result = await searchBrain(tempDir, key, {
      peerId: 'cleo-prime',
      includeGlobal: false,
    });
    const ids = result.observations.map((o) => o.id);
    expect(ids).toContain('obs-prime-strict');
    expect(ids).not.toContain('obs-g-strict');
  });

  it('unknown peer with no entries returns empty results (isolation confirmed)', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../memory-sqlite.js');
    closeBrainDb();
    await getBrainDb();
    const nativeDb = getBrainNativeDb()!;

    const key = 'peerisolation-unknown-gamma';
    // Only insert a prime entry — no global, no unknown-peer entry
    insertObs(nativeDb, 'obs-prime-unk', `${key} prime only`, 'cleo-prime');

    const { searchBrain } = await import('../../memory/brain-search.js');

    const result = await searchBrain(tempDir, key, {
      peerId: 'completely-unknown-peer',
      includeGlobal: false,
    });
    const ids = result.observations.map((o) => o.id);
    expect(ids).not.toContain('obs-prime-unk');
    expect(ids.length).toBe(0);
  });
});
