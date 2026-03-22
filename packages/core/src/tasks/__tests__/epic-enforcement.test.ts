/**
 * Tests for epic lifecycle pipeline enforcement (T062).
 *
 * Covers:
 * - validateEpicCreation: min-5 AC, description required, mode gating
 * - validateChildStageCeiling: child stage must not exceed epic's stage
 * - validateEpicStageAdvancement: epic blocked by in-flight children
 * - findEpicAncestor: correct ancestor traversal
 * - Integration via addTask / updateTask
 *
 * @task T062
 * @epic T056
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';

// Epic enforcement tests NEED enforcement active — temporarily clear VITEST
const savedVitest = process.env.VITEST;
beforeAll(() => {
  delete process.env.VITEST;
});
afterAll(() => {
  if (savedVitest) process.env.VITEST = savedVitest;
});

import type { DataAccessor } from '../../store/data-accessor.js';
import { addTask } from '../add.js';
import {
  EPIC_MIN_AC,
  findEpicAncestor,
  getLifecycleMode,
  validateChildStageCeiling,
  validateEpicCreation,
  validateEpicStageAdvancement,
} from '../epic-enforcement.js';
import { updateTask } from '../update.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/** Config that disables session and acceptance enforcement for test isolation. */
function makeConfig(lifecycleMode: 'strict' | 'advisory' | 'off' = 'strict'): string {
  return JSON.stringify({
    lifecycle: { mode: lifecycleMode },
    enforcement: {
      session: { requiredForMutate: false },
      acceptance: { mode: 'off' },
    },
    verification: { enabled: false },
  });
}

// ---------------------------------------------------------------------------
// Unit: EPIC_MIN_AC
// ---------------------------------------------------------------------------

describe('EPIC_MIN_AC constant', () => {
  it('is 5', () => {
    expect(EPIC_MIN_AC).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Unit: getLifecycleMode
// ---------------------------------------------------------------------------

describe('getLifecycleMode', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns strict by default when no config', async () => {
    const mode = await getLifecycleMode(env.tempDir);
    expect(mode).toBe('strict');
  });

  it('returns advisory from config', async () => {
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('advisory'));
    const mode = await getLifecycleMode(env.tempDir);
    expect(mode).toBe('advisory');
  });

  it('returns off from config', async () => {
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('off'));
    const mode = await getLifecycleMode(env.tempDir);
    expect(mode).toBe('off');
  });
});

// ---------------------------------------------------------------------------
// Unit: validateEpicCreation
// ---------------------------------------------------------------------------

describe('validateEpicCreation (strict mode)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('accepts when 5 AC items and description are present', async () => {
    const result = await validateEpicCreation(
      {
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        description: 'Some completion criteria',
      },
      env.tempDir,
    );
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });

  it('throws when fewer than 5 AC items', async () => {
    await expect(
      validateEpicCreation(
        {
          acceptance: ['ac1', 'ac2', 'ac3', 'ac4'],
          description: 'Some completion criteria',
        },
        env.tempDir,
      ),
    ).rejects.toThrow(/5 acceptance criteria/);
  });

  it('throws when description is empty', async () => {
    await expect(
      validateEpicCreation(
        {
          acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
          description: '',
        },
        env.tempDir,
      ),
    ).rejects.toThrow(/non-empty description/);
  });

  it('throws when both AC count and description are insufficient', async () => {
    await expect(
      validateEpicCreation({ acceptance: [], description: '   ' }, env.tempDir),
    ).rejects.toThrow();
  });
});

describe('validateEpicCreation (advisory mode)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('advisory'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('does not throw on violation, returns warning', async () => {
    const result = await validateEpicCreation(
      { acceptance: ['ac1'], description: 'OK' },
      env.tempDir,
    );
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/5 acceptance criteria/);
  });
});

describe('validateEpicCreation (off mode)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('off'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('skips all checks and returns valid', async () => {
    const result = await validateEpicCreation({ acceptance: [], description: '' }, env.tempDir);
    expect(result.valid).toBe(true);
    expect(result.warning).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unit: validateChildStageCeiling
// ---------------------------------------------------------------------------

describe('validateChildStageCeiling (strict)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function seedEpicAtStage(stage: string): Promise<string> {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic description',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: stage,
      createdAt: now,
      updatedAt: now,
    });
    return 'T001';
  }

  it('allows child stage equal to epic stage', async () => {
    const epicId = await seedEpicAtStage('specification');
    const result = await validateChildStageCeiling(
      { childStage: 'specification', epicId },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });

  it('allows child stage below epic stage', async () => {
    const epicId = await seedEpicAtStage('implementation');
    const result = await validateChildStageCeiling(
      { childStage: 'research', epicId },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });

  it('throws when child stage exceeds epic stage', async () => {
    const epicId = await seedEpicAtStage('research');
    await expect(
      validateChildStageCeiling({ childStage: 'implementation', epicId }, accessor, env.tempDir),
    ).rejects.toThrow(/cannot be at pipeline stage/);
  });

  it('skips check when epic ID does not exist', async () => {
    const result = await validateChildStageCeiling(
      { childStage: 'testing', epicId: 'T999' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateChildStageCeiling (advisory)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('advisory'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns warning instead of throwing', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'desc',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    const result = await validateChildStageCeiling(
      { childStage: 'testing', epicId: 'T001' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/cannot be at pipeline stage/);
  });
});

// ---------------------------------------------------------------------------
// Unit: validateEpicStageAdvancement
// ---------------------------------------------------------------------------

describe('validateEpicStageAdvancement (strict)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('allows advancement when no children exist', async () => {
    const result = await validateEpicStageAdvancement(
      { epicId: 'T001', currentStage: 'research', newStage: 'implementation' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });

  it('allows advancement when all children are done', async () => {
    const now = new Date().toISOString();
    // Seed epic
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    // Seed done child at research
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child',
      description: 'Child',
      status: 'done',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });

    const result = await validateEpicStageAdvancement(
      { epicId: 'T001', currentStage: 'research', newStage: 'implementation' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });

  it('throws when child is in-flight at current stage', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child',
      description: 'Child',
      status: 'active',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      validateEpicStageAdvancement(
        { epicId: 'T001', currentStage: 'research', newStage: 'implementation' },
        accessor,
        env.tempDir,
      ),
    ).rejects.toThrow(/cannot advance/);
  });

  it('ignores children at a different (later) stage', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    // Child is at implementation (not at current stage 'research')
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child',
      description: 'Child',
      status: 'active',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      pipelineStage: 'implementation',
      createdAt: now,
      updatedAt: now,
    });

    const result = await validateEpicStageAdvancement(
      { epicId: 'T001', currentStage: 'research', newStage: 'implementation' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });

  it('ignores cancelled children at current stage', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child',
      description: 'Child',
      status: 'cancelled',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });

    const result = await validateEpicStageAdvancement(
      { epicId: 'T001', currentStage: 'research', newStage: 'implementation' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });

  it('is no-op for same-stage (no advancement)', async () => {
    const result = await validateEpicStageAdvancement(
      { epicId: 'T001', currentStage: 'research', newStage: 'research' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
  });
});

describe('validateEpicStageAdvancement (advisory)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('advisory'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns warning instead of throwing when blocked', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child',
      description: 'Child',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });

    const result = await validateEpicStageAdvancement(
      { epicId: 'T001', currentStage: 'research', newStage: 'implementation' },
      accessor,
      env.tempDir,
    );
    expect(result.valid).toBe(true);
    expect(result.warning).toMatch(/cannot advance/);
  });
});

// ---------------------------------------------------------------------------
// Unit: findEpicAncestor
// ---------------------------------------------------------------------------

describe('findEpicAncestor', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns null when task has no ancestors', async () => {
    const result = await findEpicAncestor('T999', accessor);
    expect(result).toBeNull();
  });

  it('finds a direct epic parent', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Epic',
      description: 'Epic',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child',
      description: 'Child',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      parentId: 'T001',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });

    // findEpicAncestor takes the task whose ancestors to walk.
    // For T002's parent T001, we pass T001 to check its ancestors, OR
    // we pass T002 to check ancestors of T002 (which includes T001).
    const epic = await findEpicAncestor('T001', accessor);
    // T001 has no ancestors (root level), so no epic ancestor
    expect(epic).toBeNull();

    // For T002's parent: we already know T001 is the epic, so we pass parentId=T001
    // and check if T001 itself is an epic — that's handled in add.ts separately.
    // findEpicAncestor walks ancestors of the supplied ID.
    const fromChild = await findEpicAncestor('T002', accessor);
    // T002's ancestor is T001 (epic) — should be found
    expect(fromChild?.id).toBe('T001');
  });

  it('returns null when no epic in ancestor chain', async () => {
    const now = new Date().toISOString();
    await accessor.upsertSingleTask({
      id: 'T001',
      title: 'Parent task',
      description: 'desc',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });
    await accessor.upsertSingleTask({
      id: 'T002',
      title: 'Child subtask',
      description: 'desc',
      status: 'pending',
      priority: 'medium',
      type: 'subtask',
      parentId: 'T001',
      pipelineStage: 'research',
      createdAt: now,
      updatedAt: now,
    });

    const epic = await findEpicAncestor('T002', accessor);
    expect(epic).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Integration: addTask epic creation enforcement
// ---------------------------------------------------------------------------

describe('addTask epic creation enforcement (strict)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('creates an epic when 5 AC and description are provided', async () => {
    const result = await addTask(
      {
        title: 'My epic',
        description: 'Completion criteria: all features shipped',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
      },
      env.tempDir,
      accessor,
    );
    expect(result.task.type).toBe('epic');
    expect(result.task.acceptance?.length).toBe(5);
  });

  it('blocks epic creation with fewer than 5 AC', async () => {
    await expect(
      addTask(
        {
          title: 'Bad epic',
          description: 'Completion criteria here',
          type: 'epic',
          acceptance: ['ac1', 'ac2', 'ac3'],
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow(/5 acceptance criteria/);
  });
});

describe('addTask child stage ceiling (strict)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('allows child at same stage as epic', async () => {
    // Create epic at research
    const epicResult = await addTask(
      {
        title: 'Epic',
        description: 'Epic desc',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    const childResult = await addTask(
      {
        title: 'Child',
        description: 'Child task',
        parentId: epicId,
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    expect(childResult.task.pipelineStage).toBe('research');
  });

  it('blocks child at stage beyond epic stage', async () => {
    const epicResult = await addTask(
      {
        title: 'Epic',
        description: 'Epic desc',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    await expect(
      addTask(
        {
          title: 'Child',
          description: 'Child task',
          parentId: epicId,
          pipelineStage: 'implementation',
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow(/cannot be at pipeline stage/);
  });
});

// ---------------------------------------------------------------------------
// Integration: updateTask epic stage advancement gate
// ---------------------------------------------------------------------------

describe('updateTask epic stage advancement gate (strict)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('allows advancing epic stage when no in-flight children at current stage', async () => {
    // Create epic at research with 5 AC
    const epicResult = await addTask(
      {
        title: 'Epic',
        description: 'Epic desc',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    // Advance epic to implementation — no children
    const updateResult = await updateTask(
      { taskId: epicId, pipelineStage: 'implementation' },
      env.tempDir,
      accessor,
    );
    expect(updateResult.task.pipelineStage).toBe('implementation');
  });

  it('blocks advancing epic when child is in-flight at current stage', async () => {
    // Create epic at research
    const epicResult = await addTask(
      {
        title: 'Epic',
        description: 'Epic desc',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    // Create in-flight child at research stage
    await addTask(
      {
        title: 'Child',
        description: 'Child task',
        parentId: epicId,
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );

    // Attempt to advance epic — should be blocked
    await expect(
      updateTask({ taskId: epicId, pipelineStage: 'implementation' }, env.tempDir, accessor),
    ).rejects.toThrow(/cannot advance/);
  });
});

describe('updateTask child stage ceiling on update (strict)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await writeFile(join(env.cleoDir, 'config.json'), makeConfig('strict'));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('blocks updating child to a stage beyond epic', async () => {
    // Create epic at research
    const epicResult = await addTask(
      {
        title: 'Epic',
        description: 'Epic desc',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    // Create child at research
    const childResult = await addTask(
      {
        title: 'Child',
        description: 'Child task',
        parentId: epicId,
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const childId = childResult.task.id;

    // Attempt to update child to implementation (beyond epic's research)
    await expect(
      updateTask({ taskId: childId, pipelineStage: 'implementation' }, env.tempDir, accessor),
    ).rejects.toThrow(/cannot be at pipeline stage/);
  });

  it('allows updating child to a stage equal to epic', async () => {
    // Create epic at implementation
    const epicResult = await addTask(
      {
        title: 'Epic',
        description: 'Epic desc',
        type: 'epic',
        acceptance: ['ac1', 'ac2', 'ac3', 'ac4', 'ac5'],
        pipelineStage: 'implementation',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    // Create child at research
    const childResult = await addTask(
      {
        title: 'Child',
        description: 'Child task',
        parentId: epicId,
        pipelineStage: 'research',
      },
      env.tempDir,
      accessor,
    );
    const childId = childResult.task.id;

    // Update child to implementation (same as epic)
    const updateResult = await updateTask(
      { taskId: childId, pipelineStage: 'implementation' },
      env.tempDir,
      accessor,
    );
    expect(updateResult.task.pipelineStage).toBe('implementation');
  });
});
