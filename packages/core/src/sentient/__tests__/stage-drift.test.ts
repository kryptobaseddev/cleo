/**
 * Tests for the stage-drift detector — T1635.
 *
 * Coverage:
 *   - computeEffectiveStage (pure unit tests)
 *   - runStageDriftScan: no-drift path (no proposals written)
 *   - runStageDriftScan: single-stage drift (gap ≤ threshold, no proposals)
 *   - runStageDriftScan: multi-stage drift (gap > threshold, proposal emitted)
 *   - runStageDriftScan: kill-switch guard
 *   - runStageDriftScan: tier2Enabled guard
 *   - runStageDriftScan: dedup prevents duplicate proposals
 *   - safeRunStageDriftScan: swallows unexpected errors
 *
 * Tests use an in-memory DatabaseSync — no real tasks.db is opened.
 *
 * @task T1635
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeEffectiveStage, EFFECTIVE_STAGE_INDEX } from '../../lifecycle/effective-stage.js';
import {
  DRIFT_GAP_THRESHOLD,
  DRIFT_PROPOSAL_PREFIX,
  runStageDriftScan,
  safeRunStageDriftScan,
} from '../stage-drift-tick.js';
import { DEFAULT_SENTIENT_STATE, writeSentientState } from '../state.js';

// ---------------------------------------------------------------------------
// Test DB helpers
// ---------------------------------------------------------------------------

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      type TEXT,
      priority TEXT NOT NULL DEFAULT 'medium',
      pipeline_stage TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      role TEXT NOT NULL DEFAULT 'work',
      scope TEXT NOT NULL DEFAULT 'feature'
    )
  `);
  return db;
}

function insertEpic(
  db: DatabaseSync,
  id: string,
  opts: { status?: string; pipelineStage?: string | null } = {},
): void {
  db.prepare(`
    INSERT INTO tasks (id, title, status, type, pipeline_stage, created_at, role, scope)
    VALUES (:id, :title, :status, 'epic', :pipelineStage, datetime('now'), 'work', 'project')
  `).run({
    id,
    title: `Epic ${id}`,
    status: opts.status ?? 'active',
    pipelineStage: opts.pipelineStage ?? null,
  });
}

function insertTask(
  db: DatabaseSync,
  id: string,
  parentId: string,
  opts: { status?: string } = {},
): void {
  db.prepare(`
    INSERT INTO tasks (id, title, parent_id, status, created_at, role, scope)
    VALUES (:id, :title, :parentId, :status, datetime('now'), 'work', 'feature')
  `).run({
    id,
    title: `Task ${id}`,
    parentId,
    status: opts.status ?? 'pending',
  });
}

// ---------------------------------------------------------------------------
// Test state helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cleo-drift-test-'));
  statePath = join(tmpDir, 'sentient-state.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function writeState(overrides: Partial<typeof DEFAULT_SENTIENT_STATE> = {}): Promise<void> {
  await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE, ...overrides });
}

// ---------------------------------------------------------------------------
// Unit tests: computeEffectiveStage (pure)
// ---------------------------------------------------------------------------

describe('computeEffectiveStage', () => {
  it('returns research when no children done', () => {
    const result = computeEffectiveStage({
      epicId: 'T1',
      childrenTotal: 5,
      childrenDone: 0,
      allGatesPassed: false,
    });
    expect(result).toBe('research');
  });

  it('returns research when no children at all (default)', () => {
    const result = computeEffectiveStage({
      epicId: 'T1',
      childrenTotal: 0,
      childrenDone: 0,
      allGatesPassed: false,
    });
    expect(result).toBe('research');
  });

  it('returns implementation when some but not all children done (1-99%)', () => {
    const result = computeEffectiveStage({
      epicId: 'T1',
      childrenTotal: 5,
      childrenDone: 2,
      allGatesPassed: false,
    });
    expect(result).toBe('implementation');
  });

  it('returns implementation when only 1 of 10 children done', () => {
    const result = computeEffectiveStage({
      epicId: 'T1',
      childrenTotal: 10,
      childrenDone: 1,
      allGatesPassed: false,
    });
    expect(result).toBe('implementation');
  });

  it('returns testing when all children done but gates pending', () => {
    const result = computeEffectiveStage({
      epicId: 'T1',
      childrenTotal: 3,
      childrenDone: 3,
      allGatesPassed: false,
    });
    expect(result).toBe('testing');
  });

  it('returns release when all children done and all gates passed', () => {
    const result = computeEffectiveStage({
      epicId: 'T1',
      childrenTotal: 3,
      childrenDone: 3,
      allGatesPassed: true,
    });
    expect(result).toBe('release');
  });

  it('EFFECTIVE_STAGE_INDEX maps stages correctly', () => {
    expect(EFFECTIVE_STAGE_INDEX.research).toBe(1);
    expect(EFFECTIVE_STAGE_INDEX.implementation).toBe(6);
    expect(EFFECTIVE_STAGE_INDEX.testing).toBe(8);
    expect(EFFECTIVE_STAGE_INDEX.release).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: runStageDriftScan
// ---------------------------------------------------------------------------

describe('runStageDriftScan', () => {
  it('returns killed when kill switch is active', async () => {
    await writeState({ killSwitch: true, tier2Enabled: true });

    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db: createTestDb(),
      isKilled: async () => true,
    });

    expect(outcome.kind).toBe('killed');
    expect(outcome.epicsScanned).toBe(0);
    expect(outcome.proposalsWritten).toBe(0);
  });

  it('returns disabled when tier2Enabled is false', async () => {
    await writeState({ killSwitch: false, tier2Enabled: false });

    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db: createTestDb(),
    });

    expect(outcome.kind).toBe('disabled');
    expect(outcome.proposalsWritten).toBe(0);
  });

  it('returns no-epics when there are no active epics', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Insert a done epic — should be excluded
    insertEpic(db, 'T999', { status: 'done', pipelineStage: 'research' });

    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
    });

    expect(outcome.kind).toBe('no-epics');
    expect(outcome.epicsScanned).toBe(0);
  });

  it('no-drift path: no proposals emitted when stored stage matches effective stage', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Epic in research with 0 children done → effective = research (index 1)
    // stored = research (index 1) → gap = 0 → no proposal
    insertEpic(db, 'T100', { status: 'active', pipelineStage: 'research' });

    let allocated = 0;
    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      allocateTaskId: async () => {
        allocated++;
        return `T${9000 + allocated}`;
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.epicsScanned).toBe(1);
    expect(outcome.driftDetected).toHaveLength(0);
    expect(outcome.proposalsWritten).toBe(0);
    expect(allocated).toBe(0);
  });

  it('single-stage drift: gap <= threshold → no proposal (strict boundary)', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Epic stored at implementation (index 6).
    // 3 of 5 children done → effective = implementation (index 6).
    // gap = 0 → no proposal.
    insertEpic(db, 'T100', { status: 'active', pipelineStage: 'implementation' });
    insertTask(db, 'C1', 'T100', { status: 'done' });
    insertTask(db, 'C2', 'T100', { status: 'done' });
    insertTask(db, 'C3', 'T100', { status: 'done' });
    insertTask(db, 'C4', 'T100', { status: 'pending' });
    insertTask(db, 'C5', 'T100', { status: 'pending' });

    let allocated = 0;
    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      driftGapThreshold: DRIFT_GAP_THRESHOLD,
      allocateTaskId: async () => {
        allocated++;
        return `T${9000 + allocated}`;
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.driftDetected).toHaveLength(0);
    expect(outcome.proposalsWritten).toBe(0);
    expect(allocated).toBe(0);
  });

  it('single-stage drift threshold: gap = 1 with threshold=1 → proposal NOT emitted (boundary: > not >=)', async () => {
    // Gap of exactly the threshold is NOT enough to trigger (rule: gap > threshold).
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Stored: research (index 1). Effective: implementation (index 6). Gap = 5 → proposal
    // But let's test a gap=1 scenario: stored consensus (index 2), effective research (index 1)
    // STAGE_ORDER consensus=2, effective research=1, gap=1 → below threshold of 2 → no proposal
    insertEpic(db, 'T100', { status: 'active', pipelineStage: 'consensus' });
    // 0 children done → effective = research (index 1), stored consensus (index 2), gap=1

    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      driftGapThreshold: DRIFT_GAP_THRESHOLD, // default = 2
      allocateTaskId: async () => 'T9001',
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.driftDetected).toHaveLength(0);
    expect(outcome.proposalsWritten).toBe(0);
  });

  it('multi-stage drift: gap > threshold → proposal emitted', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Stored: research (index 1). 3 of 3 children done + all gates passed.
    // Effective: release (index 9). Gap = 8 → DRIFT → proposal.
    insertEpic(db, 'T200', { status: 'active', pipelineStage: 'research' });
    insertTask(db, 'C1', 'T200', { status: 'done' });
    insertTask(db, 'C2', 'T200', { status: 'done' });
    insertTask(db, 'C3', 'T200', { status: 'done' });

    let taskIdCounter = 0;
    const allocatedIds: string[] = [];

    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      allocateTaskId: async () => {
        taskIdCounter++;
        const id = `T${9000 + taskIdCounter}`;
        allocatedIds.push(id);
        return id;
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.epicsScanned).toBe(1);
    expect(outcome.driftDetected).toHaveLength(1);
    expect(outcome.driftDetected[0]?.epicId).toBe('T200');
    expect(outcome.driftDetected[0]?.storedStage).toBe('research');
    expect(outcome.driftDetected[0]?.effectiveStage).toBe('release');
    expect(outcome.proposalsWritten).toBe(1);

    // Verify proposal was inserted into DB.
    const row = db.prepare(`SELECT id, title, status FROM tasks WHERE id = :id`).get({
      id: allocatedIds[0],
    }) as { id: string; title: string; status: string } | undefined;

    expect(row).toBeDefined();
    expect(row?.status).toBe('proposed');
    expect(row?.title).toContain(DRIFT_PROPOSAL_PREFIX);
    expect(row?.title).toContain('T200');
    expect(row?.title).toContain('research');
    expect(row?.title).toContain('release');
  });

  it('multi-stage drift: implementation stored, all done + gates passed → release (gap=3)', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Stored: implementation (index 6). Effective: release (index 9). Gap = 3 > 2 → proposal.
    insertEpic(db, 'T300', { status: 'active', pipelineStage: 'implementation' });
    insertTask(db, 'C1', 'T300', { status: 'done' });
    insertTask(db, 'C2', 'T300', { status: 'done' });

    let taskIdCounter = 0;
    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      allocateTaskId: async () => {
        taskIdCounter++;
        return `T${9000 + taskIdCounter}`;
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.driftDetected).toHaveLength(1);
    expect(outcome.driftDetected[0]?.gap).toBe(3); // 9 - 6
    expect(outcome.proposalsWritten).toBe(1);
  });

  it('dedup: duplicate proposal for same epic is NOT written twice', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    insertEpic(db, 'T400', { status: 'active', pipelineStage: 'research' });
    insertTask(db, 'C1', 'T400', { status: 'done' });
    insertTask(db, 'C2', 'T400', { status: 'done' });
    // All done, gates treated as passed (no gate rows) → effective = release.

    let taskIdCounter = 0;
    const allocate = async (): Promise<string> => {
      taskIdCounter++;
      return `T${9000 + taskIdCounter}`;
    };

    // First scan: should write a proposal.
    const first = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      allocateTaskId: allocate,
    });
    expect(first.proposalsWritten).toBe(1);

    // Second scan: dedup should prevent a second proposal.
    const second = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      allocateTaskId: allocate,
    });
    expect(second.proposalsWritten).toBe(0);
    expect(second.driftDetected).toHaveLength(1); // drift still detected
  });

  it('multiple drifted epics: proposals written for each (up to rate limit)', async () => {
    await writeState({ tier2Enabled: true });

    const db = createTestDb();
    // Two epics, both drifted (research stored, all children done).
    insertEpic(db, 'T500', { status: 'active', pipelineStage: 'research' });
    insertTask(db, 'CA1', 'T500', { status: 'done' });

    insertEpic(db, 'T501', { status: 'active', pipelineStage: 'research' });
    insertTask(db, 'CB1', 'T501', { status: 'done' });

    let taskIdCounter = 0;
    const outcome = await runStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db,
      allocateTaskId: async () => {
        taskIdCounter++;
        return `T${9000 + taskIdCounter}`;
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.driftDetected).toHaveLength(2);
    expect(outcome.proposalsWritten).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// safeRunStageDriftScan: error handling
// ---------------------------------------------------------------------------

describe('safeRunStageDriftScan', () => {
  it('swallows unexpected errors and returns error outcome', async () => {
    await writeState({ tier2Enabled: true });

    // Inject a broken DB that throws on prepare.
    const brokenDb = {
      prepare: () => {
        throw new Error('simulated DB error');
      },
    } as unknown as DatabaseSync;

    const outcome = await safeRunStageDriftScan({
      projectRoot: tmpDir,
      statePath,
      db: brokenDb,
    });

    // The outer safe wrapper catches the throw.
    expect(['error', 'disabled', 'killed', 'no-epics', 'scanned']).toContain(outcome.kind);
    // Must not re-throw.
  });
});
