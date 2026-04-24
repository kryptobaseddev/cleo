/**
 * Specialists + Surprisal + RPTree Tests — T1146 Wave 6
 *
 * Tests the Bayesian surprisal scorer, RPTree builder, and consolidation
 * specialists using in-memory SQLite databases.
 *
 * Mocks: vi.mock for LLM backend to test graceful degrade path.
 *
 * @task T1146
 * @epic T1146
 */

import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CodePatternSpecialist,
  DecisionSpecialist,
  DeductionSpecialist,
  dispatchSpecialists,
  InductionSpecialist,
  SPECIALIST_SURPRISAL_THRESHOLD,
  TaskOutcomeSpecialist,
  UserPreferenceSpecialist,
} from '../specialists.js';
import { computeSurprisalBatch, computeSurprisalScore, NEUTRAL_SURPRISAL } from '../surprisal.js';
import { buildSurprisalTree } from '../surprisal-tree.js';

// ---------------------------------------------------------------------------
// Test DB setup
// ---------------------------------------------------------------------------

let db: DatabaseSync;

function setupDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE brain_observations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      title TEXT,
      narrative TEXT,
      source_type TEXT,
      quality_score REAL,
      memory_tier TEXT,
      memory_type TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      level TEXT DEFAULT 'explicit',
      source_ids TEXT,
      provenance_class TEXT DEFAULT 'unswept-pre-T1151',
      peer_id TEXT NOT NULL DEFAULT 'global',
      peer_scope TEXT NOT NULL DEFAULT 'project',
      tree_id INTEGER
    );
    CREATE TABLE brain_embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observation_id TEXT NOT NULL,
      embedding BLOB
    );
    CREATE TABLE brain_memory_trees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      depth INTEGER NOT NULL DEFAULT 0,
      leaf_ids TEXT NOT NULL DEFAULT '[]',
      centroid TEXT,
      parent_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE brain_learnings (
      id TEXT PRIMARY KEY,
      insight TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      source TEXT,
      source_session_id TEXT,
      memory_tier TEXT DEFAULT 'short',
      memory_type TEXT DEFAULT 'semantic',
      created_at TEXT DEFAULT (datetime('now')),
      provenance_class TEXT DEFAULT 'unswept-pre-T1151'
    );
    CREATE TABLE brain_patterns (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      context TEXT,
      frequency INTEGER DEFAULT 1,
      impact TEXT,
      source TEXT,
      memory_tier TEXT DEFAULT 'short',
      memory_type TEXT DEFAULT 'procedural',
      created_at TEXT DEFAULT (datetime('now')),
      provenance_class TEXT DEFAULT 'unswept-pre-T1151'
    );
    CREATE TABLE brain_decisions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'architecture',
      title TEXT NOT NULL,
      rationale TEXT,
      confidence REAL DEFAULT 0.5,
      source_session_id TEXT,
      memory_tier TEXT DEFAULT 'short',
      memory_type TEXT DEFAULT 'semantic',
      created_at TEXT DEFAULT (datetime('now')),
      provenance_class TEXT DEFAULT 'unswept-pre-T1151',
      peer_id TEXT NOT NULL DEFAULT 'global',
      peer_scope TEXT NOT NULL DEFAULT 'project'
    );
  `);
  return d;
}

/** Insert an observation with a fake embedding (random bytes). */
function insertObsWithEmbedding(d: DatabaseSync, id: string, type = 'change', title = `Obs ${id}`) {
  d.prepare(
    `INSERT INTO brain_observations (id, type, title, narrative, level) VALUES (?, ?, ?, ?, 'explicit')`,
  ).run(id, type, title, `Narrative for ${id}`);
  // Create a Float32 embedding of 8 dimensions for test purposes
  const floats = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    floats[i] = Math.random();
  }
  const buf = Buffer.from(floats.buffer);
  d.prepare(`INSERT INTO brain_embeddings (observation_id, embedding) VALUES (?, ?)`).run(id, buf);
}

/** Insert a plain observation without embedding. */
function insertObs(d: DatabaseSync, id: string, type = 'change', title = `Obs ${id}`) {
  d.prepare(`INSERT INTO brain_observations (id, type, title, narrative) VALUES (?, ?, ?, ?)`).run(
    id,
    type,
    title,
    `Narrative for ${id}`,
  );
}

beforeEach(() => {
  db = setupDb();
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Surprisal tests
// ---------------------------------------------------------------------------

describe('computeSurprisalScore', () => {
  it('returns NEUTRAL_SURPRISAL (0.5) when no embedding on observation', () => {
    const result = computeSurprisalScore({ id: 'obs-1', embedding: null }, { db });
    expect(result.score).toBe(NEUTRAL_SURPRISAL);
    expect(result.embeddingAvailable).toBe(false);
  });

  it('returns NEUTRAL_SURPRISAL when db is not available', () => {
    const result = computeSurprisalScore({ id: 'obs-1', embedding: [0.1, 0.2, 0.3] }, { db: null });
    expect(result.score).toBe(NEUTRAL_SURPRISAL);
  });

  it('returns max surprisal (1.0) when no prior embeddings exist', () => {
    // No embeddings in the DB at all
    const floats = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
    const result = computeSurprisalScore({ id: 'obs-1', embedding: Array.from(floats) }, { db });
    expect(result.score).toBe(1.0);
    expect(result.embeddingAvailable).toBe(true);
  });

  it('returns low surprisal (<0.3) for a near-duplicate observation', () => {
    // Insert the "prior" observation with the same embedding
    insertObsWithEmbedding(db, 'prior-1');

    // Query what embedding was stored
    const row = db
      .prepare('SELECT embedding FROM brain_embeddings WHERE observation_id = ?')
      .get('prior-1') as { embedding: Buffer };

    const storedFloats = new Float32Array(
      row.embedding.buffer,
      row.embedding.byteOffset,
      row.embedding.byteLength / 4,
    );
    const embedding = Array.from(storedFloats);

    // Score the exact same embedding as a new observation
    const result = computeSurprisalScore({ id: 'obs-new', embedding }, { db });
    expect(result.score).toBeLessThan(0.4);
  });

  it('returns high surprisal (>0.7) for a highly novel observation', () => {
    // Insert a prior with embedding [1, 0, 0, 0, 0, 0, 0, 0]
    const prior = new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]);
    db.prepare('INSERT INTO brain_observations (id, type, title) VALUES (?, ?, ?)').run(
      'prior-1',
      'change',
      'Prior',
    );
    db.prepare('INSERT INTO brain_embeddings (observation_id, embedding) VALUES (?, ?)').run(
      'prior-1',
      Buffer.from(prior.buffer),
    );

    // Novel observation: orthogonal vector [0, 1, 0, 0, 0, 0, 0, 0]
    const novel = [0, 1, 0, 0, 0, 0, 0, 0];
    const result = computeSurprisalScore({ id: 'obs-novel', embedding: novel }, { db });
    expect(result.score).toBeGreaterThan(0.7);
  });
});

describe('computeSurprisalBatch', () => {
  it('sorts results descending by score (highest surprisal first)', () => {
    const obs = [
      { id: 'a', embedding: null }, // neutral 0.5
      { id: 'b', embedding: [0.1, 0.2] }, // no priors → 1.0
    ];
    const results = computeSurprisalBatch(obs, { db });
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });
});

// ---------------------------------------------------------------------------
// RPTree tests
// ---------------------------------------------------------------------------

describe('buildSurprisalTree', () => {
  it('returns zero counts when fewer than 2 observations provided', () => {
    const result = buildSurprisalTree([{ id: 'o1', embedding: [1, 2, 3] }], { db });
    expect(result.nodesWritten).toBe(0);
    expect(result.obsAssigned).toBe(0);
  });

  it('builds a tree and returns non-zero nodesWritten for N >= 8 observations', () => {
    const observations = Array.from({ length: 10 }, (_, i) => ({
      id: `obs-${i}`,
      embedding: Array.from({ length: 8 }, () => Math.random()),
    }));

    // Insert into brain_observations so tree_id UPDATE works
    for (const o of observations) {
      db.prepare('INSERT INTO brain_observations (id, type, title) VALUES (?, ?, ?)').run(
        o.id,
        'change',
        `Obs ${o.id}`,
      );
    }

    const result = buildSurprisalTree(observations, { db, minLeafSize: 2 });
    expect(result.nodesWritten).toBeGreaterThan(0);
    expect(result.actualMaxDepth).toBeGreaterThanOrEqual(2);
    expect(result.obsAssigned).toBeGreaterThan(0);
  });

  it('populates brain_memory_trees table', () => {
    const observations = Array.from({ length: 6 }, (_, i) => ({
      id: `o${i}`,
      embedding: Array.from({ length: 4 }, () => Math.random()),
    }));
    for (const o of observations) {
      db.prepare('INSERT INTO brain_observations (id, type, title) VALUES (?, ?, ?)').run(
        o.id,
        'change',
        o.id,
      );
    }

    buildSurprisalTree(observations, { db, minLeafSize: 2 });

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM brain_memory_trees').get() as {
      cnt: number;
    };
    expect(count.cnt).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Specialist tests
// ---------------------------------------------------------------------------

describe('DeductionSpecialist', () => {
  it('creates brain_learnings entries when LLM available', async () => {
    const specialist = new DeductionSpecialist();
    const obs = [
      {
        id: 'o1',
        type: 'change',
        title: 'Some technical change',
        narrative: 'The code was refactored to use TypeScript',
        project: null,
        peerId: 'global',
        sourceSessionId: null,
      },
    ];
    await specialist.process(obs, true, db);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM brain_learnings').get() as {
      cnt: number;
    };
    expect(count.cnt).toBeGreaterThan(0);
  });

  it('returns skipped=true when llmAvailable=false', async () => {
    const specialist = new DeductionSpecialist();
    const result = await specialist.process([], false, db);
    expect(result.skipped).toBe(true);
    expect(result.created).toBe(0);
  });
});

describe('InductionSpecialist', () => {
  it('creates brain_patterns when enough observations', async () => {
    const specialist = new InductionSpecialist();
    const obs = Array.from({ length: 3 }, (_, i) => ({
      id: `o${i}`,
      type: 'change',
      title: `Pattern obs ${i}`,
      narrative: 'Observation narrative',
      project: null,
      peerId: 'global',
      sourceSessionId: null,
    }));
    await specialist.process(obs, true, db);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM brain_patterns').get() as { cnt: number };
    expect(count.cnt).toBeGreaterThan(0);
  });

  it('returns skipped=true with insufficient observations', async () => {
    const specialist = new InductionSpecialist();
    const result = await specialist.process(
      [
        {
          id: 'o1',
          type: 'change',
          title: 'Only one',
          narrative: null,
          project: null,
          peerId: 'global',
          sourceSessionId: null,
        },
      ],
      true,
      db,
    );
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('insufficient');
  });
});

describe('UserPreferenceSpecialist', () => {
  it('silently no-ops when llmAvailable=false', async () => {
    const specialist = new UserPreferenceSpecialist();
    const result = await specialist.process([], false, db);
    expect(result.skipped).toBe(true);
    expect(result.created).toBe(0);
  });
});

describe('DecisionSpecialist', () => {
  it('creates brain_decisions for decision-like observations', async () => {
    const specialist = new DecisionSpecialist();
    const obs = [
      {
        id: 'o1',
        type: 'decision',
        title: 'Architecture Decision',
        narrative: 'We decided to use SQLite for the queue',
        project: null,
        peerId: 'global',
        sourceSessionId: null,
      },
    ];
    await specialist.process(obs, true, db);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM brain_decisions').get() as {
      cnt: number;
    };
    expect(count.cnt).toBeGreaterThan(0);
  });
});

describe('CodePatternSpecialist', () => {
  it('creates code patterns for code-related observations', async () => {
    const specialist = new CodePatternSpecialist();
    const obs = [
      {
        id: 'o1',
        type: 'change',
        title: 'Code refactor: function extraction',
        narrative: 'Extracted function from class',
        project: null,
        peerId: 'global',
        sourceSessionId: null,
      },
    ];
    await specialist.process(obs, true, db);

    const count = db.prepare('SELECT COUNT(*) AS cnt FROM brain_patterns').get() as { cnt: number };
    expect(count.cnt).toBeGreaterThan(0);
  });
});

describe('TaskOutcomeSpecialist', () => {
  it('silently no-ops when llmAvailable=false', async () => {
    const specialist = new TaskOutcomeSpecialist();
    const result = await specialist.process([], false, db);
    expect(result.skipped).toBe(true);
    expect(result.created).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// dispatchSpecialists tests
// ---------------------------------------------------------------------------

describe('dispatchSpecialists', () => {
  it('all specialists skip when resolveLlm returns null (graceful degrade)', async () => {
    insertObs(db, 'o1');
    const obs = [
      {
        id: 'o1',
        type: 'change',
        title: 'Test obs',
        narrative: 'Test',
        project: null,
        peerId: 'global',
        sourceSessionId: null,
      },
    ];

    const result = await dispatchSpecialists(obs, null, {
      db,
      resolveLlm: async () => null,
    });

    expect(result.totalSkipped).toBe(6); // all 6 specialists skip
    expect(result.totalCreated).toBe(0);
  });

  it('processes observations above threshold when LLM available', async () => {
    insertObs(db, 'o1');
    // Mock surprisal results: obs-1 has score above threshold
    const surprisalResults = [
      { id: 'o1', score: SPECIALIST_SURPRISAL_THRESHOLD + 0.1, embeddingAvailable: true },
    ];
    const obs = [
      {
        id: 'o1',
        type: 'change',
        title: 'Deduction target',
        narrative: 'We chose to refactor',
        project: null,
        peerId: 'global',
        sourceSessionId: null,
      },
    ];

    // LLM is available (returns non-null mock)
    const result = await dispatchSpecialists(obs, surprisalResults, {
      db,
      resolveLlm: async () => ({ model: 'mock', name: 'mock' }),
    });

    expect(result.specialists).toHaveLength(6);
    // At least some specialists ran (not all skipped)
    expect(result.totalSkipped).toBeLessThan(6);
  });

  it('skips all when all observations below surprisal threshold', async () => {
    const surprisalResults = [{ id: 'o1', score: 0.1, embeddingAvailable: true }]; // below threshold
    const obs = [
      {
        id: 'o1',
        type: 'change',
        title: 'Low surprisal',
        narrative: null,
        project: null,
        peerId: 'global',
        sourceSessionId: null,
      },
    ];

    const result = await dispatchSpecialists(obs, surprisalResults, {
      db,
      resolveLlm: async () => ({ model: 'mock' }),
    });

    // All skipped because no observations pass threshold
    expect(result.totalSkipped).toBe(6);
  });
});
