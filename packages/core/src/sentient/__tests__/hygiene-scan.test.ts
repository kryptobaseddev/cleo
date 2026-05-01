/**
 * Tests for the hygiene scan module — T1636.
 *
 * Coverage:
 *   - Scan 1 (orphan tasks): tasks whose parent is done/cancelled/missing
 *   - Scan 2 (top-level tasks): root-level type=task tasks without a parent
 *   - Scan 3 (content defects): missing AC, vague AC, missing files for type=task
 *   - Scan 4 (premature-close leaks): done tasks whose parent epic is still open
 *     with no remaining active siblings
 *   - Kill-switch guard: scan aborts when killSwitch=true
 *   - No-DB guard: scan returns no-db when DB is null
 *   - safeRunHygieneScan: swallows unexpected errors
 *   - Integration: HYGIENE_SCAN_INTERVAL_MS constant is exported
 *
 * Tests use in-memory DatabaseSync — no real tasks.db is opened.
 * Brain observations are injected via options.observeMemory — no brain.db is opened.
 *
 * @task T1636
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HYGIENE_SCAN_INTERVAL_MS,
  runHygieneScan,
  safeRunHygieneScan,
  VAGUE_AC_CHAR_THRESHOLD,
} from '../hygiene-scan.js';
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
      title TEXT NOT NULL DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      type TEXT DEFAULT 'task',
      priority TEXT NOT NULL DEFAULT 'medium',
      pipeline_stage TEXT,
      acceptance_json TEXT DEFAULT NULL,
      files_json TEXT DEFAULT NULL,
      labels_json TEXT NOT NULL DEFAULT '[]',
      notes_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      role TEXT NOT NULL DEFAULT 'work',
      scope TEXT NOT NULL DEFAULT 'feature'
    )
  `);
  return db;
}

function insertTask(
  db: DatabaseSync,
  opts: {
    id: string;
    parentId?: string | null;
    type?: string;
    status?: string;
    acceptanceJson?: string | null;
    filesJson?: string | null;
    updatedAt?: string;
  },
): void {
  db.prepare(`
    INSERT INTO tasks (id, parent_id, type, status, acceptance_json, files_json, updated_at,
      created_at, role, scope)
    VALUES (:id, :parentId, :type, :status, :acceptanceJson, :filesJson,
      COALESCE(:updatedAt, datetime('now')), datetime('now'), 'work', 'feature')
  `).run({
    id: opts.id,
    parentId: opts.parentId ?? null,
    type: opts.type ?? 'task',
    status: opts.status ?? 'pending',
    acceptanceJson: opts.acceptanceJson ?? null,
    filesJson: opts.filesJson ?? null,
    updatedAt: opts.updatedAt ?? null,
  });
}

// ---------------------------------------------------------------------------
// Test state helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cleo-hygiene-test-'));
  statePath = join(tmpDir, 'sentient-state.json');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeState(overrides: Partial<typeof DEFAULT_SENTIENT_STATE> = {}): Promise<void> {
  await writeSentientState(statePath, { ...DEFAULT_SENTIENT_STATE, ...overrides });
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('HYGIENE_SCAN_INTERVAL_MS is 4 hours', () => {
    expect(HYGIENE_SCAN_INTERVAL_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('VAGUE_AC_CHAR_THRESHOLD is 20', () => {
    expect(VAGUE_AC_CHAR_THRESHOLD).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Kill-switch guard
// ---------------------------------------------------------------------------

describe('kill-switch guard', () => {
  it('returns killed when isKilled returns true', async () => {
    await writeState({ killSwitch: false });
    const db = createTestDb();

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => true,
    });

    expect(outcome.kind).toBe('killed');
    expect(outcome.totalObserved).toBe(0);
    expect(outcome.detail).toContain('killSwitch active');
  });

  it('proceeds when isKilled returns false', async () => {
    await writeState({ killSwitch: false });
    const db = createTestDb();

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.kind).toBe('scanned');
  });
});

// ---------------------------------------------------------------------------
// No-DB guard
// ---------------------------------------------------------------------------

describe('no-db guard', () => {
  it('returns no-db when db is null', async () => {
    await writeState();
    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db: null,
      isKilled: async () => false,
    });

    expect(outcome.kind).toBe('no-db');
    expect(outcome.detail).toContain('tasks.db not available');
  });
});

// ---------------------------------------------------------------------------
// Scan 1: orphan tasks
// ---------------------------------------------------------------------------

describe('Scan 1 — orphan tasks', () => {
  it('finds no orphans when all tasks have live parents', async () => {
    await writeState();
    const db = createTestDb();
    const observed: string[] = [];

    // Epic parent (active)
    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });
    // Child task with active parent
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E1' });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observed.push(p.title);
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.checks.orphan.found).toBe(0);
    expect(outcome.checks.orphan.observed).toBe(0);
    expect(observed.filter((t) => t.includes('hygiene:orphan'))).toHaveLength(0);
  });

  it('detects orphan when parent is done', async () => {
    await writeState();
    const db = createTestDb();
    const observed: string[] = [];

    // Epic parent (done)
    insertTask(db, { id: 'E1', type: 'epic', status: 'done', parentId: null });
    // Child task still pending
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E1' });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observed.push(p.title);
      },
    });

    expect(outcome.kind).toBe('scanned');
    expect(outcome.checks.orphan.found).toBe(1);
    expect(outcome.checks.orphan.observed).toBe(1);
    expect(observed.some((t) => t.includes('hygiene:orphan'))).toBe(true);
  });

  it('detects orphan when parent is cancelled', async () => {
    await writeState();
    const db = createTestDb();

    insertTask(db, { id: 'E1', type: 'epic', status: 'cancelled', parentId: null });
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E1' });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.orphan.found).toBe(1);
  });

  it('detects orphan when parent is missing entirely', async () => {
    await writeState();
    const db = createTestDb();

    // Task references non-existent parent
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E999' });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.orphan.found).toBe(1);
  });

  it('emits observation with task ID in text', async () => {
    await writeState();
    const db = createTestDb();
    const observations: { text: string; title: string }[] = [];

    insertTask(db, { id: 'E1', type: 'epic', status: 'done', parentId: null });
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E1' });

    await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observations.push({ text: p.text, title: p.title });
      },
    });

    const orphanObs = observations.find((o) => o.title.includes('hygiene:orphan'));
    expect(orphanObs).toBeDefined();
    expect(orphanObs?.text).toContain('T1');
  });
});

// ---------------------------------------------------------------------------
// Scan 2: top-level type=task (no parent)
// ---------------------------------------------------------------------------

describe('Scan 2 — top-level type=task orphans', () => {
  it('finds no top-level tasks when all tasks have parents', async () => {
    await writeState();
    const db = createTestDb();

    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E1' });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.topLevelOrphan.found).toBe(0);
  });

  it('detects top-level task without a parent', async () => {
    await writeState();
    const db = createTestDb();
    const observed: string[] = [];

    // Root-level task (no parent)
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: null });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observed.push(p.title);
      },
    });

    expect(outcome.checks.topLevelOrphan.found).toBe(1);
    expect(outcome.checks.topLevelOrphan.observed).toBe(1);
    expect(observed.some((t) => t.includes('hygiene:top-level-orphan'))).toBe(true);
  });

  it('does NOT flag root-level epics as top-level orphans', async () => {
    await writeState();
    const db = createTestDb();

    // Root-level epic is expected — no orphan
    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.topLevelOrphan.found).toBe(0);
  });

  it('includes re-parent action in observation text', async () => {
    await writeState();
    const db = createTestDb();
    const observations: { text: string }[] = [];

    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: null });

    await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observations.push({ text: p.text });
      },
    });

    const obs = observations.find((o) => o.text.includes('T1'));
    expect(obs?.text).toContain('cleo update');
  });
});

// ---------------------------------------------------------------------------
// Scan 3: content quality defects
// ---------------------------------------------------------------------------

describe('Scan 3 — content defects', () => {
  it('finds no defects when all tasks have good AC and files', async () => {
    await writeState();
    const db = createTestDb();

    insertTask(db, {
      id: 'E1',
      type: 'epic',
      status: 'active',
      parentId: null,
    });
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'pending',
      parentId: 'E1',
      acceptanceJson: JSON.stringify([
        'This is a detailed acceptance criterion that is long enough',
      ]),
      filesJson: JSON.stringify(['src/foo.ts']),
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.contentDefect.found).toBe(0);
  });

  it('detects missing acceptance criteria', async () => {
    await writeState();
    const db = createTestDb();
    const observed: string[] = [];

    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'pending',
      parentId: null,
      acceptanceJson: null, // no AC
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observed.push(p.title);
      },
    });

    // T1 appears in orphan check AND content defect check — both may fire
    expect(outcome.checks.contentDefect.found).toBeGreaterThanOrEqual(1);
    expect(observed.some((t) => t.includes('hygiene:content-defect'))).toBe(true);
  });

  it(`detects vague AC shorter than ${VAGUE_AC_CHAR_THRESHOLD} chars`, async () => {
    await writeState();
    const db = createTestDb();

    insertTask(db, {
      id: 'E1',
      type: 'epic',
      status: 'active',
      parentId: null,
    });
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'pending',
      parentId: 'E1',
      acceptanceJson: JSON.stringify(['done']), // only 4 chars — too vague
      filesJson: JSON.stringify(['src/foo.ts']),
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.contentDefect.found).toBe(1);
  });

  it('detects type=task with empty files list', async () => {
    await writeState();
    const db = createTestDb();

    insertTask(db, {
      id: 'E1',
      type: 'epic',
      status: 'active',
      parentId: null,
    });
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'pending',
      parentId: 'E1',
      acceptanceJson: JSON.stringify(['This is a sufficiently long acceptance criterion']),
      filesJson: JSON.stringify([]), // empty files
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.contentDefect.found).toBe(1);
  });

  it('does NOT flag epics for missing files (files only required for type=task)', async () => {
    await writeState();
    const db = createTestDb();

    // Epic with no files — should not trigger content defect
    insertTask(db, {
      id: 'E1',
      type: 'epic',
      status: 'active',
      parentId: null,
      acceptanceJson: JSON.stringify(['This is a sufficiently long acceptance criterion']),
      filesJson: null,
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.contentDefect.found).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Scan 4: premature-close leaks
// ---------------------------------------------------------------------------

describe('Scan 4 — premature-close leaks', () => {
  it('finds no leaks when parent epic is closed after task done', async () => {
    await writeState();
    const db = createTestDb();

    // Parent epic is done too — no leak
    insertTask(db, { id: 'E1', type: 'epic', status: 'done', parentId: null });
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'done',
      parentId: 'E1',
      updatedAt: new Date().toISOString(),
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.prematureCloseLeak.found).toBe(0);
  });

  it('detects leak when done task has active parent with no remaining siblings', async () => {
    await writeState();
    const db = createTestDb();
    const observed: string[] = [];

    // Parent epic is still active
    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });
    // Only child — done — but parent not closed (leak)
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'done',
      parentId: 'E1',
      updatedAt: new Date().toISOString(),
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observed.push(p.title);
      },
    });

    expect(outcome.checks.prematureCloseLeak.found).toBe(1);
    expect(outcome.checks.prematureCloseLeak.observed).toBe(1);
    expect(observed.some((t) => t.includes('hygiene:premature-close-leak'))).toBe(true);
  });

  it('does NOT flag when done task has active siblings (parent still legitimately open)', async () => {
    await writeState();
    const db = createTestDb();

    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });
    // Done child
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'done',
      parentId: 'E1',
      updatedAt: new Date().toISOString(),
    });
    // Active sibling — parent legitimately open
    insertTask(db, { id: 'T2', type: 'task', status: 'pending', parentId: 'E1' });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.checks.prematureCloseLeak.found).toBe(0);
  });

  it('includes CRITICAL label in leak observation text', async () => {
    await writeState();
    const db = createTestDb();
    const observations: { text: string }[] = [];

    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'done',
      parentId: 'E1',
      updatedAt: new Date().toISOString(),
    });

    await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async (p) => {
        observations.push({ text: p.text });
      },
    });

    const leakObs = observations.find((o) => o.text.includes('premature-close-leak'));
    expect(leakObs?.text).toContain('CRITICAL');
  });
});

// ---------------------------------------------------------------------------
// Digest output (totalObserved aggregation)
// ---------------------------------------------------------------------------

describe('totalObserved aggregation', () => {
  it('counts 0 when no defects found', async () => {
    await writeState();
    const db = createTestDb();

    // Clean epic with proper child
    insertTask(db, { id: 'E1', type: 'epic', status: 'active', parentId: null });
    insertTask(db, {
      id: 'T1',
      type: 'task',
      status: 'pending',
      parentId: 'E1',
      acceptanceJson: JSON.stringify(['This is a sufficiently long acceptance criterion']),
      filesJson: JSON.stringify(['src/foo.ts']),
    });

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.totalObserved).toBe(0);
    expect(outcome.detail).toContain('0 observation(s) emitted');
  });

  it('counts observations correctly across checks', async () => {
    await writeState();
    const db = createTestDb();
    let observeCallCount = 0;

    // Trigger Scan 1 (orphan) and Scan 2 (top-level)
    insertTask(db, { id: 'E1', type: 'epic', status: 'done', parentId: null });
    insertTask(db, { id: 'T1', type: 'task', status: 'pending', parentId: 'E1' }); // orphan
    insertTask(db, { id: 'T2', type: 'task', status: 'pending', parentId: null }); // top-level

    const outcome = await runHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
      observeMemory: async () => {
        observeCallCount++;
      },
    });

    // Scans 1 + 2 each emit one observation
    expect(outcome.totalObserved).toBeGreaterThanOrEqual(2);
    expect(observeCallCount).toBe(outcome.totalObserved);
  });
});

// ---------------------------------------------------------------------------
// safeRunHygieneScan: error handling
// ---------------------------------------------------------------------------

describe('safeRunHygieneScan', () => {
  it('swallows unexpected errors and returns error outcome', async () => {
    await writeState();

    // Use a broken db to force a throw path
    const outcome = await safeRunHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db: null,
      isKilled: async () => {
        throw new Error('unexpected isKilled error');
      },
    });

    expect(outcome.kind).toBe('error');
    expect(outcome.detail).toContain('hygiene scan threw');
    expect(outcome.totalObserved).toBe(0);
  });

  it('returns scanned outcome on happy path', async () => {
    await writeState();
    const db = createTestDb();

    const outcome = await safeRunHygieneScan({
      projectRoot: tmpDir,
      statePath,
      db,
      isKilled: async () => false,
    });

    expect(outcome.kind).toBe('scanned');
  });
});
