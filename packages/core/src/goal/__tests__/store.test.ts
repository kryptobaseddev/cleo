/**
 * Tests for the DB-persisted per-agent goal store (T11377).
 *
 * Proves the two load-bearing guarantees:
 *  1. A goal SURVIVES a simulated process restart (closeDb → getDb re-opens the
 *     file-backed tasks.db and the row is still there).
 *  2. Two distinct owners (session/agent identities) yield ISOLATED
 *     getActiveGoal results — no session-bleed.
 *
 * Plus CRUD coverage: criteria append, status update, sub-goal parent linkage,
 * idempotent create, and JSONB round-trip (goal_kind / criteria read back
 * through json(col), never raw BLOB).
 *
 * @epic T11290
 * @task T11377
 * @saga T11283
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GoalKind } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../store/sqlite.js';
import {
  appendCriteria,
  createGoal,
  type GoalOwner,
  getActiveGoal,
  getGoalById,
  listGoals,
  updateGoal,
} from '../store.js';

let projectRoot: string;

const OWNER_A: GoalOwner = { sessionId: 'ses_A', agentId: 'agent-A' };
const OWNER_B: GoalOwner = { sessionId: 'ses_B', agentId: 'agent-B' };
const FUZZY: GoalKind = { kind: 'fuzzy' };
const TASK_GOAL: GoalKind = { kind: 'task-completion', targetTaskId: 'T123' };

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'cleo-goal-store-'));
  // Pre-create `.cleo/` so resolveCleoDir anchors to the temp dir.
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
});

afterEach(() => {
  // Close the singleton so the next test opens a fresh file-backed DB.
  closeDb();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('goal store — persistence + restart', () => {
  it('persists a goal that survives a simulated process restart', async () => {
    const created = await createGoal(
      { goalKind: TASK_GOAL, intent: 'complete T123', turnBudget: 8, owner: OWNER_A },
      projectRoot,
    );
    expect(created.id).toBeTruthy();
    expect(created.status).toBe('active');

    // Simulate a process restart: drop the in-memory singleton, then re-open the
    // file-backed DB from disk.
    closeDb();

    const reloaded = await getGoalById(created.id, projectRoot);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.intent).toBe('complete T123');
    // JSONB goal_kind round-trips through json(col) — never raw BLOB.
    expect(reloaded?.goalKind).toEqual(TASK_GOAL);
    expect(reloaded?.turnBudget).toBe(8);
  });

  it('round-trips JSONB columns (goalKind, criteria) through json(col)', async () => {
    const created = await createGoal(
      {
        goalKind: FUZZY,
        intent: 'explore auth',
        turnBudget: 5,
        criteria: ['c1', 'c2'],
        owner: OWNER_A,
      },
      projectRoot,
    );
    const reloaded = await getGoalById(created.id, projectRoot);
    expect(reloaded?.goalKind).toEqual(FUZZY);
    expect(reloaded?.criteria).toEqual(['c1', 'c2']);
    expect(reloaded?.lastVerdict).toBeNull();
  });
});

describe('goal store — per-agent isolation (no session-bleed)', () => {
  it('two distinct owners get isolated getActiveGoal results', async () => {
    await createGoal(
      { goalKind: FUZZY, intent: 'goal-A', turnBudget: 5, owner: OWNER_A },
      projectRoot,
    );
    await createGoal(
      { goalKind: FUZZY, intent: 'goal-B', turnBudget: 5, owner: OWNER_B },
      projectRoot,
    );

    const aGoal = await getActiveGoal(projectRoot, OWNER_A);
    const bGoal = await getActiveGoal(projectRoot, OWNER_B);

    expect(aGoal?.intent).toBe('goal-A');
    expect(bGoal?.intent).toBe('goal-B');
    // The critical anti-bleed assertion: A never sees B's goal and vice-versa.
    expect(aGoal?.intent).not.toBe('goal-B');
    expect(bGoal?.intent).not.toBe('goal-A');
  });

  it('an owner with no goals sees null even when another agent has one', async () => {
    await createGoal(
      { goalKind: FUZZY, intent: 'only-A', turnBudget: 5, owner: OWNER_A },
      projectRoot,
    );
    const bGoal = await getActiveGoal(projectRoot, OWNER_B);
    expect(bGoal).toBeNull();
  });

  it('listGoals is scoped to the owner', async () => {
    await createGoal({ goalKind: FUZZY, intent: 'a1', turnBudget: 5, owner: OWNER_A }, projectRoot);
    await createGoal({ goalKind: FUZZY, intent: 'a2', turnBudget: 5, owner: OWNER_A }, projectRoot);
    await createGoal({ goalKind: FUZZY, intent: 'b1', turnBudget: 5, owner: OWNER_B }, projectRoot);
    const aList = await listGoals(projectRoot, OWNER_A);
    const bList = await listGoals(projectRoot, OWNER_B);
    expect(aList.map((g) => g.intent).sort()).toEqual(['a1', 'a2']);
    expect(bList.map((g) => g.intent)).toEqual(['b1']);
  });
});

describe('goal store — CRUD', () => {
  it('appendCriteria appends without losing prior criteria', async () => {
    const created = await createGoal(
      { goalKind: FUZZY, intent: 'g', turnBudget: 5, criteria: ['first'], owner: OWNER_A },
      projectRoot,
    );
    const after = await appendCriteria(created.id, 'second', projectRoot);
    expect(after?.criteria).toEqual(['first', 'second']);
  });

  it('updateGoal patches status + turnsUsed + lastVerdict', async () => {
    const created = await createGoal(
      { goalKind: FUZZY, intent: 'g', turnBudget: 5, owner: OWNER_A },
      projectRoot,
    );
    const updated = await updateGoal(
      created.id,
      {
        status: 'paused',
        turnsUsed: 2,
        pausedReason: 'judge failed',
        lastVerdict: { ok: false, impossible: false, reason: 'still working' },
      },
      projectRoot,
    );
    expect(updated?.status).toBe('paused');
    expect(updated?.turnsUsed).toBe(2);
    expect(updated?.pausedReason).toBe('judge failed');
    expect(updated?.lastVerdict?.reason).toBe('still working');
  });

  it('a paused goal is still returned by getActiveGoal (resumable)', async () => {
    const created = await createGoal(
      { goalKind: FUZZY, intent: 'g', turnBudget: 5, owner: OWNER_A },
      projectRoot,
    );
    await updateGoal(created.id, { status: 'paused' }, projectRoot);
    const active = await getActiveGoal(projectRoot, OWNER_A);
    expect(active?.id).toBe(created.id);
  });

  it('a satisfied goal is NOT returned by getActiveGoal (terminal)', async () => {
    const created = await createGoal(
      { goalKind: FUZZY, intent: 'g', turnBudget: 5, owner: OWNER_A },
      projectRoot,
    );
    await updateGoal(created.id, { status: 'satisfied' }, projectRoot);
    const active = await getActiveGoal(projectRoot, OWNER_A);
    expect(active).toBeNull();
  });

  it('createGoal is idempotent on the idempotency key', async () => {
    const first = await createGoal(
      {
        goalKind: FUZZY,
        intent: 'g',
        turnBudget: 5,
        owner: OWNER_A,
        idempotencyKey: 'stable-key',
      },
      projectRoot,
    );
    const second = await createGoal(
      {
        goalKind: FUZZY,
        intent: 'DIFFERENT — should be ignored',
        turnBudget: 99,
        owner: OWNER_A,
        idempotencyKey: 'stable-key',
      },
      projectRoot,
    );
    expect(second.id).toBe(first.id);
    // The conflicting create was a no-op — the original values survive.
    expect(second.intent).toBe('g');
    expect(second.turnBudget).toBe(5);
    const all = await listGoals(projectRoot, OWNER_A);
    expect(all).toHaveLength(1);
  });

  it('a sub-goal links parentGoalId', async () => {
    const parent = await createGoal(
      { goalKind: FUZZY, intent: 'parent', turnBudget: 5, owner: OWNER_A },
      projectRoot,
    );
    const child = await createGoal(
      {
        goalKind: TASK_GOAL,
        intent: 'child',
        turnBudget: 3,
        parentGoalId: parent.id,
        owner: OWNER_A,
      },
      projectRoot,
    );
    expect(child.parentGoalId).toBe(parent.id);
  });
});
