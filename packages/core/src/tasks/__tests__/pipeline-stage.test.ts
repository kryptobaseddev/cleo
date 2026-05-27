/**
 * Tests for pipeline stage binding (T060).
 *
 * Covers:
 * - Stage validation
 * - Auto-assignment on task creation (standalone, epic, under-parent)
 * - Forward-only transition enforcement on update
 * - Stage persistence through rowToTask / taskToRow round-trip
 *
 * @task T060
 * @epic T056
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';

/** Config that disables session, acceptance, and lifecycle enforcement for test isolation. */
const NO_SESSION_CONFIG = JSON.stringify({
  lifecycle: { mode: 'off' },
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  verification: { enabled: false },
});

import {
  getPipelineStageOrder,
  isPipelineTransitionForward,
  isTerminalPipelineStage,
  isValidPipelineStage,
  resolveDefaultPipelineStage,
  TASK_PIPELINE_STAGES,
  TERMINAL_PIPELINE_STAGES,
  validatePipelineStage,
  validatePipelineTransition,
} from '../pipeline-stage.js';
import { updateTask } from '../update.js';

// ---------------------------------------------------------------------------
// Unit tests — pure functions
// ---------------------------------------------------------------------------

describe('isValidPipelineStage', () => {
  it('returns true for all canonical stages', () => {
    for (const stage of TASK_PIPELINE_STAGES) {
      expect(isValidPipelineStage(stage)).toBe(true);
    }
  });

  it('returns false for unknown strings', () => {
    expect(isValidPipelineStage('unknown')).toBe(false);
    expect(isValidPipelineStage('')).toBe(false);
    expect(isValidPipelineStage('RESEARCH')).toBe(false);
  });
});

describe('validatePipelineStage', () => {
  it('does not throw for valid stages', () => {
    expect(() => validatePipelineStage('research')).not.toThrow();
    expect(() => validatePipelineStage('implementation')).not.toThrow();
    expect(() => validatePipelineStage('contribution')).not.toThrow();
  });

  it('throws CleoError for invalid stage', () => {
    expect(() => validatePipelineStage('invalid')).toThrow('Invalid pipeline stage');
  });
});

describe('getPipelineStageOrder', () => {
  it('returns expected order values', () => {
    expect(getPipelineStageOrder('research')).toBe(1);
    expect(getPipelineStageOrder('implementation')).toBe(6);
    expect(getPipelineStageOrder('release')).toBe(9);
    expect(getPipelineStageOrder('contribution')).toBe(10);
  });

  it('returns -1 for unknown stage', () => {
    expect(getPipelineStageOrder('unknown')).toBe(-1);
  });
});

describe('isPipelineTransitionForward', () => {
  it('allows same stage (no-op)', () => {
    expect(isPipelineTransitionForward('research', 'research')).toBe(true);
    expect(isPipelineTransitionForward('implementation', 'implementation')).toBe(true);
  });

  it('allows forward transitions', () => {
    expect(isPipelineTransitionForward('research', 'consensus')).toBe(true);
    expect(isPipelineTransitionForward('research', 'implementation')).toBe(true);
    expect(isPipelineTransitionForward('implementation', 'release')).toBe(true);
  });

  it('rejects backward transitions', () => {
    expect(isPipelineTransitionForward('implementation', 'research')).toBe(false);
    expect(isPipelineTransitionForward('testing', 'specification')).toBe(false);
    expect(isPipelineTransitionForward('release', 'implementation')).toBe(false);
  });

  it('allows transitions with unknown stages (defensive)', () => {
    expect(isPipelineTransitionForward('unknown', 'research')).toBe(true);
    expect(isPipelineTransitionForward('research', 'unknown')).toBe(true);
  });
});

describe('validatePipelineTransition', () => {
  it('allows forward transitions', () => {
    expect(() => validatePipelineTransition('research', 'implementation')).not.toThrow();
    expect(() => validatePipelineTransition('implementation', 'testing')).not.toThrow();
  });

  it('allows same-stage (no-op)', () => {
    expect(() => validatePipelineTransition('implementation', 'implementation')).not.toThrow();
  });

  it('allows any transition from null/undefined current stage', () => {
    expect(() => validatePipelineTransition(null, 'implementation')).not.toThrow();
    expect(() => validatePipelineTransition(undefined, 'research')).not.toThrow();
  });

  it('throws for backward transitions', () => {
    expect(() => validatePipelineTransition('implementation', 'research')).toThrow(
      'cannot move backward',
    );
    expect(() => validatePipelineTransition('testing', 'specification')).toThrow(
      'cannot move backward',
    );
  });

  it('throws for invalid new stage', () => {
    expect(() => validatePipelineTransition(null, 'invalid')).toThrow('Invalid pipeline stage');
  });
});

describe('resolveDefaultPipelineStage', () => {
  it('returns explicit stage when provided and valid', () => {
    expect(resolveDefaultPipelineStage({ explicitStage: 'testing' })).toBe('testing');
  });

  it('inherits from parent pipeline stage', () => {
    const result = resolveDefaultPipelineStage({
      parentTask: { pipelineStage: 'specification', type: 'epic' },
    });
    expect(result).toBe('specification');
  });

  it('defaults to research for epics', () => {
    expect(resolveDefaultPipelineStage({ taskType: 'epic' })).toBe('research');
  });

  it('defaults to implementation for standalone tasks', () => {
    expect(resolveDefaultPipelineStage({ taskType: 'task' })).toBe('implementation');
    expect(resolveDefaultPipelineStage({})).toBe('implementation');
  });

  it('explicit stage takes priority over parent inheritance', () => {
    const result = resolveDefaultPipelineStage({
      explicitStage: 'testing',
      parentTask: { pipelineStage: 'research', type: 'epic' },
    });
    expect(result).toBe('testing');
  });

  it('parent inheritance takes priority over type default', () => {
    const result = resolveDefaultPipelineStage({
      taskType: 'task', // would default to implementation
      parentTask: { pipelineStage: 'specification', type: 'epic' }, // but parent overrides
    });
    expect(result).toBe('specification');
  });

  it('ignores parent with invalid pipelineStage', () => {
    const result = resolveDefaultPipelineStage({
      taskType: 'task',
      parentTask: { pipelineStage: 'invalid_stage', type: 'epic' },
    });
    // Falls through to task default
    expect(result).toBe('implementation');
  });
});

// ---------------------------------------------------------------------------
// T871 — terminal pipeline stage helpers
// ---------------------------------------------------------------------------

describe('TERMINAL_PIPELINE_STAGES / isTerminalPipelineStage (T871)', () => {
  it('TASK_PIPELINE_STAGES includes both terminal markers', () => {
    expect(TASK_PIPELINE_STAGES).toContain('contribution');
    expect(TASK_PIPELINE_STAGES).toContain('cancelled');
  });

  it('TERMINAL_PIPELINE_STAGES contains exactly contribution and cancelled', () => {
    expect(TERMINAL_PIPELINE_STAGES.has('contribution')).toBe(true);
    expect(TERMINAL_PIPELINE_STAGES.has('cancelled')).toBe(true);
    expect(TERMINAL_PIPELINE_STAGES.size).toBe(2);
  });

  it('isTerminalPipelineStage returns true for contribution and cancelled', () => {
    expect(isTerminalPipelineStage('contribution')).toBe(true);
    expect(isTerminalPipelineStage('cancelled')).toBe(true);
  });

  it('isTerminalPipelineStage returns false for non-terminal stages', () => {
    expect(isTerminalPipelineStage('research')).toBe(false);
    expect(isTerminalPipelineStage('implementation')).toBe(false);
    expect(isTerminalPipelineStage('release')).toBe(false);
  });

  it('isTerminalPipelineStage handles null / undefined / unknown safely', () => {
    expect(isTerminalPipelineStage(null)).toBe(false);
    expect(isTerminalPipelineStage(undefined)).toBe(false);
    expect(isTerminalPipelineStage('')).toBe(false);
    expect(isTerminalPipelineStage('unknown')).toBe(false);
  });

  it('cancelled has strictly higher order than contribution (forward-only preserved)', () => {
    expect(getPipelineStageOrder('cancelled')).toBeGreaterThan(
      getPipelineStageOrder('contribution'),
    );
  });

  it('any non-terminal stage can transition forward into cancelled', () => {
    expect(isPipelineTransitionForward('research', 'cancelled')).toBe(true);
    expect(isPipelineTransitionForward('implementation', 'cancelled')).toBe(true);
    expect(isPipelineTransitionForward('release', 'cancelled')).toBe(true);
    expect(isPipelineTransitionForward('contribution', 'cancelled')).toBe(true);
  });

  it('cancelled cannot transition back to any earlier stage', () => {
    expect(isPipelineTransitionForward('cancelled', 'research')).toBe(false);
    expect(isPipelineTransitionForward('cancelled', 'implementation')).toBe(false);
    expect(isPipelineTransitionForward('cancelled', 'contribution')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration tests — addTask + updateTask with real SQLite
// ---------------------------------------------------------------------------

describe('addTask pipeline stage auto-assignment', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    // Disable session enforcement so tests run without an active session
    await writeFile(join(env.cleoDir, 'config.json'), NO_SESSION_CONFIG);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('assigns implementation to a standalone task by default', async () => {
    const result = await addTask(
      { title: 'Standalone task', description: 'A standalone task without explicit stage' },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('implementation');
  });

  it('assigns research to an epic by default', async () => {
    const result = await addTask(
      {
        title: 'My epic',
        description: 'An epic with default stage',
        type: 'epic',
      },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('research');
  });

  it('respects explicit pipelineStage on creation', async () => {
    const result = await addTask(
      {
        title: 'Testing task',
        description: 'Task at testing stage',
        pipelineStage: 'testing',
      },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('testing');
  });

  it('inherits parent pipeline stage when creating child task', async () => {
    // Create epic at specification stage
    const epicResult = await addTask(
      {
        title: 'Parent epic',
        description: 'Epic at specification stage',
        type: 'epic',
        pipelineStage: 'specification',
      },
      env.tempDir,
      accessor,
    );
    const epicId = epicResult.task.id;

    // Create child task under that epic — should inherit specification
    const childResult = await addTask(
      {
        title: 'Child task',
        description: 'Child task inheriting parent stage',
        parentId: epicId,
      },
      env.tempDir,
      accessor,
    );
    expect(childResult.task.pipelineStage).toBe('specification');
  });

  it('rejects invalid pipelineStage on creation', async () => {
    await expect(
      addTask(
        {
          title: 'Bad stage',
          description: 'Task with invalid stage',
          pipelineStage: 'not_a_real_stage',
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow('Invalid pipeline stage');
  });

  it('persists pipelineStage through round-trip', async () => {
    await addTask(
      {
        title: 'Persist test',
        description: 'Test that stage persists to DB',
        pipelineStage: 'validation',
      },
      env.tempDir,
      accessor,
    );

    // Load back from DB
    const loaded = await accessor.loadSingleTask('T001');
    expect(loaded?.pipelineStage).toBe('validation');
  });
});

describe('updateTask pipeline stage transitions', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    // Disable session enforcement so tests run without an active session
    await writeFile(join(env.cleoDir, 'config.json'), NO_SESSION_CONFIG);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('allows forward stage transition', async () => {
    // Create at implementation stage
    await addTask(
      {
        title: 'Transition test',
        description: 'Task for transition testing',
        pipelineStage: 'implementation',
      },
      env.tempDir,
      accessor,
    );

    // Move forward to validation
    const result = await updateTask(
      { taskId: 'T001', pipelineStage: 'validation' },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('validation');
    expect(result.changes).toContain('pipelineStage');
  });

  it('allows same-stage transition (no-op)', async () => {
    await addTask(
      {
        title: 'Same stage test',
        description: 'Task for same-stage transition test',
        pipelineStage: 'implementation',
      },
      env.tempDir,
      accessor,
    );

    const result = await updateTask(
      { taskId: 'T001', pipelineStage: 'implementation' },
      env.tempDir,
      accessor,
    );
    expect(result.task.pipelineStage).toBe('implementation');
  });

  it('rejects backward stage transition', async () => {
    // Create at testing stage
    await addTask(
      {
        title: 'Backward test',
        description: 'Task that should not go backward',
        pipelineStage: 'testing',
      },
      env.tempDir,
      accessor,
    );

    // Attempt to move backward to implementation
    await expect(
      updateTask({ taskId: 'T001', pipelineStage: 'implementation' }, env.tempDir, accessor),
    ).rejects.toThrow('cannot move backward');
  });

  it('rejects invalid stage on update', async () => {
    await addTask(
      {
        title: 'Invalid update',
        description: 'Task with upcoming invalid update',
        pipelineStage: 'implementation',
      },
      env.tempDir,
      accessor,
    );

    await expect(
      updateTask({ taskId: 'T001', pipelineStage: 'not_real' }, env.tempDir, accessor),
    ).rejects.toThrow('Invalid pipeline stage');
  });

  it('persists updated stage to DB', async () => {
    await addTask(
      {
        title: 'Persist update',
        description: 'Task for update persistence test',
        pipelineStage: 'implementation',
      },
      env.tempDir,
      accessor,
    );

    await updateTask({ taskId: 'T001', pipelineStage: 'validation' }, env.tempDir, accessor);

    const loaded = await accessor.loadSingleTask('T001');
    expect(loaded?.pipelineStage).toBe('validation');
  });
});
