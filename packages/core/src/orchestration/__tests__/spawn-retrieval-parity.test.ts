/**
 * M1 spawn-retrieval-parity gate — T1260 PSYCHE E3 (GREEN).
 *
 * Verifies that `composeSpawnPayload` at tier-1 produces a spawn prompt
 * containing a `## PSYCHE-MEMORY` section (structural parity with briefing.ts
 * which already uses `buildRetrievalBundle`), and that the returned
 * `SpawnPayload.retrievalBundle` has the same structural shape as the bundle
 * returned by a direct `buildRetrievalBundle` call.
 *
 * Promoted from `it.fails` scaffold (T1259 E2, v2026.4.127) to full green
 * integration tests after T1260 E3 (.128) wired composeSpawnPayload →
 * buildRetrievalBundle.
 *
 * @see packages/core/src/orchestration/spawn.ts — composeSpawnPayload (now wired)
 * @see packages/core/src/memory/brain-retrieval.ts:1918 — buildRetrievalBundle
 * @see packages/core/src/sessions/briefing.ts:212 — briefing-path (structural benchmark)
 * @task T1260 v2026.4.128 E3 M1 GREEN
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fixtures — mirror spawn.test.ts harness
// ---------------------------------------------------------------------------

const FIXTURE_WORKER_CANT = `---
kind: agent
version: 1
---

agent fixture-worker:
  role: worker
  parent: cleo-prime
  description: "Worker fixture for parity test."
  prompt: "You are fixture-worker."
  skills: ["ct-cleo"]
`;

interface TmpEnv {
  cleoHome: string;
  projectRoot: string;
  dbPath: string;
  globalCantDir: string;
  openDb: () => DatabaseSync;
  cleanup: () => void;
}

async function makeTmpEnv(suffix: string): Promise<TmpEnv> {
  const base = mkdtempSync(join(tmpdir(), `cleo-parity-${suffix}-`));
  const cleoHome = join(base, 'cleo-home');
  const projectRoot = join(base, 'project');
  const globalCantDir = join(base, 'global-cant-agents');
  const projectCantDir = join(projectRoot, '.cleo', 'cant', 'agents');

  mkdirSync(cleoHome, { recursive: true });
  mkdirSync(projectCantDir, { recursive: true });
  mkdirSync(globalCantDir, { recursive: true });

  writeFileSync(join(cleoHome, 'machine-key'), Buffer.alloc(32, 0xab), { mode: 0o600 });
  writeFileSync(join(cleoHome, 'global-salt'), Buffer.alloc(32, 0xcd), { mode: 0o600 });

  vi.doMock('../../paths.js', async () => {
    const actual = await vi.importActual<typeof import('../../paths.js')>('../../paths.js');
    return {
      ...actual,
      getCleoHome: () => cleoHome,
      getCleoGlobalAgentsDir: () => globalCantDir,
    };
  });

  const { ensureGlobalSignaldockDb, _resetGlobalSignaldockDb_TESTING_ONLY } = await import(
    '../../store/signaldock-sqlite.js'
  );
  _resetGlobalSignaldockDb_TESTING_ONLY();
  await ensureGlobalSignaldockDb();

  const dbPath = join(cleoHome, 'signaldock.db');

  // Seed the skills catalog so junction writes succeed.
  const seedDb = new DatabaseSync(dbPath);
  seedDb.exec('PRAGMA foreign_keys = ON');
  const nowTs = Math.floor(Date.now() / 1000);
  seedDb
    .prepare(
      `INSERT OR IGNORE INTO skills (id, slug, name, description, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('skill-ct-cleo', 'ct-cleo', 'CT CLEO', 'CLEO task protocol', 'core', nowTs);
  seedDb.close();

  // Install fixture agent CANT
  writeFileSync(join(globalCantDir, 'fixture-worker.cant'), FIXTURE_WORKER_CANT, 'utf8');

  const openDb = (): DatabaseSync => {
    const d = new DatabaseSync(dbPath);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('PRAGMA journal_mode = WAL');
    return d;
  };
  const cleanup = (): void => {
    _resetGlobalSignaldockDb_TESTING_ONLY();
    rmSync(base, { recursive: true, force: true });
  };
  return {
    cleoHome,
    projectRoot,
    dbPath,
    globalCantDir,
    openDb,
    cleanup,
  };
}

const FIXTURE_TASK: Task = {
  id: 'T9999',
  title: 'Parity fixture task',
  description: 'Task for spawn-retrieval-parity test',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  parentId: null,
  acceptance: ['parity test passes'],
  size: 'small',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  completedAt: null,
  cancelledAt: null,
  position: 0,
  positionVersion: 0,
};

// Minimal RetrievalBundle mock shape matching the @cleocode/contracts interface
const MOCK_EMPTY_BUNDLE = {
  cold: { userProfile: [], peerInstructions: '' },
  warm: { peerLearnings: [], peerPatterns: [], decisions: [] },
  hot: { sessionNarrative: '', recentObservations: [], activeTasks: [] },
  tokenCounts: { cold: 0, warm: 0, hot: 0, total: 0 },
} as const;

const MOCK_POPULATED_BUNDLE = {
  cold: { userProfile: [], peerInstructions: 'Prefer concise responses.' },
  warm: {
    peerLearnings: [
      {
        id: 'L-001',
        insight: 'Use pnpm not npm',
        createdAt: '2026-04-24T00:00:00Z',
        provenanceClass: 'swept-clean',
      },
    ],
    peerPatterns: [],
    decisions: [
      {
        id: 'D-001',
        decision: 'TypeScript strict mode',
        createdAt: '2026-04-24T00:00:00Z',
        provenanceClass: 'swept-clean',
      },
    ],
  },
  hot: {
    sessionNarrative: 'Working on PSYCHE E3 spawn wiring.',
    recentObservations: [],
    activeTasks: [],
  },
  tokenCounts: { cold: 5, warm: 25, hot: 12, total: 42 },
} as const;

// ---------------------------------------------------------------------------
// Tests — GREEN (T1260 E3)
// ---------------------------------------------------------------------------

describe('M1 spawn-retrieval-parity — E3 GREEN (T1260)', () => {
  let env: TmpEnv;
  let db: DatabaseSync;

  beforeEach(async () => {
    vi.resetModules();
    env = await makeTmpEnv('m1');
    db = env.openDb();
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      // already closed
    }
    env.cleanup();
    vi.restoreAllMocks();
  });

  it('SpawnPayload type includes retrievalBundle field (M1 — wired in E3)', async () => {
    // This test was `it.fails` in T1259 E2 (.127). It passes green now that
    // T1260 E3 wires composeSpawnPayload → buildRetrievalBundle.
    vi.doMock('../../memory/brain-retrieval.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/brain-retrieval.js')>(
        '../../memory/brain-retrieval.js',
      );
      return { ...actual, buildRetrievalBundle: vi.fn().mockResolvedValue(MOCK_EMPTY_BUNDLE) };
    });

    const { composeSpawnPayload } = await import('../spawn.js');
    const payload = await composeSpawnPayload(db, FIXTURE_TASK, {
      tier: 1,
      sessionId: 'ses_parity_test',
      peerId: 'global',
      projectRoot: env.projectRoot,
      agentId: 'fixture-worker',
      skipAtomicityCheck: true,
    });

    // The SpawnPayload MUST carry retrievalBundle (M1 gate)
    expect(payload.retrievalBundle).toBeDefined();
  });

  it('tier-1 spawn prompt contains ## PSYCHE-MEMORY section', async () => {
    vi.doMock('../../memory/brain-retrieval.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/brain-retrieval.js')>(
        '../../memory/brain-retrieval.js',
      );
      return { ...actual, buildRetrievalBundle: vi.fn().mockResolvedValue(MOCK_EMPTY_BUNDLE) };
    });

    const { composeSpawnPayload } = await import('../spawn.js');
    const payload = await composeSpawnPayload(db, FIXTURE_TASK, {
      tier: 1,
      sessionId: 'ses_parity_test',
      peerId: 'global',
      projectRoot: env.projectRoot,
      agentId: 'fixture-worker',
      skipAtomicityCheck: true,
    });

    expect(payload.prompt).toContain('## PSYCHE-MEMORY');
  });

  it('retrievalBundle shape matches buildRetrievalBundle contract (structural parity with briefing.ts)', async () => {
    vi.doMock('../../memory/brain-retrieval.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/brain-retrieval.js')>(
        '../../memory/brain-retrieval.js',
      );
      return { ...actual, buildRetrievalBundle: vi.fn().mockResolvedValue(MOCK_POPULATED_BUNDLE) };
    });

    const { composeSpawnPayload } = await import('../spawn.js');
    const payload = await composeSpawnPayload(db, FIXTURE_TASK, {
      tier: 1,
      sessionId: 'ses_parity_test',
      peerId: 'global',
      projectRoot: env.projectRoot,
      agentId: 'fixture-worker',
      skipAtomicityCheck: true,
    });

    expect(payload.retrievalBundle).toBeDefined();
    const bundle = payload.retrievalBundle!;

    // cold pass shape — same as briefing.ts path
    expect(Object.keys(bundle.cold)).toEqual(
      expect.arrayContaining(['userProfile', 'peerInstructions']),
    );
    // warm pass shape — same as briefing.ts path
    expect(Object.keys(bundle.warm)).toEqual(
      expect.arrayContaining(['peerLearnings', 'peerPatterns', 'decisions']),
    );
    // hot pass shape — same as briefing.ts path
    expect(Object.keys(bundle.hot)).toEqual(
      expect.arrayContaining(['sessionNarrative', 'recentObservations', 'activeTasks']),
    );
    // tokenCounts — same as briefing.ts path
    expect(Object.keys(bundle.tokenCounts)).toEqual(
      expect.arrayContaining(['cold', 'warm', 'hot', 'total']),
    );

    // verify content propagated correctly
    expect(bundle.cold.peerInstructions).toBe('Prefer concise responses.');
    expect(bundle.warm.peerLearnings).toHaveLength(1);
    expect(bundle.warm.decisions).toHaveLength(1);
    expect(bundle.hot.sessionNarrative).toBe('Working on PSYCHE E3 spawn wiring.');
    expect(bundle.tokenCounts.total).toBe(42);
  });

  it('tier-1 PSYCHE-MEMORY section contains peer instructions when bundle has content', async () => {
    vi.doMock('../../memory/brain-retrieval.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/brain-retrieval.js')>(
        '../../memory/brain-retrieval.js',
      );
      return { ...actual, buildRetrievalBundle: vi.fn().mockResolvedValue(MOCK_POPULATED_BUNDLE) };
    });

    const { composeSpawnPayload } = await import('../spawn.js');
    const payload = await composeSpawnPayload(db, FIXTURE_TASK, {
      tier: 1,
      sessionId: 'ses_parity_test',
      projectRoot: env.projectRoot,
      agentId: 'fixture-worker',
      skipAtomicityCheck: true,
    });

    expect(payload.prompt).toContain('## PSYCHE-MEMORY');
    expect(payload.prompt).toContain('Prefer concise responses.');
    expect(payload.prompt).toContain('Working on PSYCHE E3 spawn wiring.');
  });

  it('tier-0 prompt does NOT contain PSYCHE-MEMORY section', async () => {
    vi.doMock('../../memory/brain-retrieval.js', async () => {
      const actual = await vi.importActual<typeof import('../../memory/brain-retrieval.js')>(
        '../../memory/brain-retrieval.js',
      );
      return { ...actual, buildRetrievalBundle: vi.fn().mockResolvedValue(MOCK_POPULATED_BUNDLE) };
    });

    const { composeSpawnPayload } = await import('../spawn.js');
    const payload = await composeSpawnPayload(db, FIXTURE_TASK, {
      tier: 0,
      sessionId: 'ses_parity_test',
      projectRoot: env.projectRoot,
      agentId: 'fixture-worker',
      skipAtomicityCheck: true,
    });

    // Tier-0 is minimal — no PSYCHE-MEMORY
    expect(payload.prompt).not.toContain('## PSYCHE-MEMORY');
  });

  it('degrades gracefully when sessionId absent — no PSYCHE-MEMORY and no crash', async () => {
    const { composeSpawnPayload } = await import('../spawn.js');
    const payload = await composeSpawnPayload(db, FIXTURE_TASK, {
      tier: 1,
      // sessionId intentionally absent
      projectRoot: env.projectRoot,
      agentId: 'fixture-worker',
      skipAtomicityCheck: true,
    });

    // No sessionId → no retrieval bundle → no PSYCHE-MEMORY section
    expect(payload.retrievalBundle).toBeUndefined();
    expect(payload.prompt).not.toContain('## PSYCHE-MEMORY');
  });
});
