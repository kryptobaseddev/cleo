/**
 * Tests for task show.
 * @task T4460
 * @epic T4454
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { showTask, taskShow } from '../show.js';

describe('showTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('shows a task by ID', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test task',
        status: 'pending',
        priority: 'high',
        description: 'Detailed info',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.id).toBe('T001');
    expect(result.title).toBe('Test task');
    expect(result.description).toBe('Detailed info');
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(showTask('T999', env.tempDir, accessor)).rejects.toThrow('Task not found');
  });

  // ---------------------------------------------------------------------------
  // T10109 — Malformed task ID handling. `cleo show T932EP` historically
  // surfaced a KeyError 'data' instead of a clean LAFS envelope. The fix is
  // two-layered:
  //   1. Dispatch middleware (sanitizeTaskId) already rejects malformed IDs
  //      with E_VALIDATION_FAILED before the core handler runs.
  //   2. Core showTask defensively rejects format-violating IDs so direct
  //      callers (tests, in-process consumers, future API surfaces) get the
  //      same hard guard.
  // These tests lock in (2): every non-canonical input throws a CleoError
  // with INVALID_INPUT, never a TypeError / KeyError / silent DB miss.
  // ---------------------------------------------------------------------------

  describe('malformed task ID (T10109)', () => {
    const invalidIds = [
      ['T932EP', 'epic-suffixed orphan ID'],
      ['T-foo', 'dash-separator'],
      ['t9999', 'lowercase prefix'],
      ['T', 'prefix only, no digits'],
      ['TASKABC', 'non-digit body'],
      ['garbage', 'no prefix'],
      ['T123abc', 'digits then letters'],
      ['T 123', 'whitespace in middle'],
    ];

    for (const [input, label] of invalidIds) {
      it(`rejects ${label} (${JSON.stringify(input)}) with Invalid task ID format`, async () => {
        await seedTasks(accessor, []);
        await expect(showTask(input, env.tempDir, accessor)).rejects.toThrow(
          /Invalid task ID format/i,
        );
      });
    }

    it('rejects empty string with Task ID is required', async () => {
      await seedTasks(accessor, []);
      await expect(showTask('', env.tempDir, accessor)).rejects.toThrow(/Task ID is required/i);
    });

    it('accepts T0 as format-valid but returns Task not found when absent', async () => {
      // T0 matches the format pattern (T followed by digits) — it should fall
      // through to the not-found path, NOT be rejected as malformed.
      await seedTasks(accessor, []);
      await expect(showTask('T0', env.tempDir, accessor)).rejects.toThrow('Task not found: T0');
    });
  });

  // ---------------------------------------------------------------------------
  // T10109 — EngineResult wrapper contract. `taskShow` is the dispatch-layer
  // entry point; it MUST always resolve to a structured EngineResult (never
  // throw, never KeyError). These tests confirm every malformed input maps
  // to `{ success: false, error: { code, message } }` — the LAFS envelope
  // contract that consumers (CLI, MCP, HTTP) depend on.
  // ---------------------------------------------------------------------------

  describe('taskShow EngineResult envelope (T10109)', () => {
    it('returns success envelope for valid existing ID', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Test',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);
      const result = await taskShow(env.tempDir, 'T001');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data?.task.id).toBe('T001');
      }
    });

    it.each([
      ['T932EP', 'epic-suffixed orphan'],
      ['T-foo', 'dash-separator'],
      ['t9999', 'lowercase prefix'],
      ['T', 'prefix only'],
      ['TASKABC', 'non-digit body'],
      ['garbage', 'no prefix'],
      ['T123abc', 'digits then letters'],
      ['T 123', 'whitespace in middle'],
    ])('returns structured error envelope (not KeyError) for malformed input %j (%s)', async (input) => {
      await seedTasks(accessor, []);
      const result = await taskShow(env.tempDir, input);
      // Critical: never throws, always returns structured envelope
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected failure result for malformed input');
      }
      expect(result.error).toBeDefined();
      expect(typeof result.error.code).toBe('string');
      expect(typeof result.error.message).toBe('string');
      // The message should reference task ID format, not a generic DB miss
      expect(result.error.message).toMatch(/invalid task id format/i);
    });

    it('returns structured envelope for empty string', async () => {
      await seedTasks(accessor, []);
      const result = await taskShow(env.tempDir, '');
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected failure result for empty string');
      }
      expect(result.error.message).toMatch(/task id is required/i);
    });

    it('returns NOT_FOUND envelope for well-formed but absent ID', async () => {
      await seedTasks(accessor, []);
      const result = await taskShow(env.tempDir, 'T0');
      expect(result.success).toBe(false);
      if (result.success) {
        throw new Error('Expected failure result for missing task');
      }
      // Format-valid IDs that miss the DB get the NOT_FOUND surface, NOT
      // INVALID_INPUT — preserving the existing contract.
      expect(result.error.message).toMatch(/not found/i);
    });
  });

  it('includes children list', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Child 1',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Child 2',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T001', env.tempDir, accessor);
    expect(result.children).toEqual(['T002', 'T003']);
  });

  it('includes dependency status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dependency',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked task',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T002', env.tempDir, accessor);
    expect(result.dependencyStatus).toHaveLength(1);
    expect(result.dependencyStatus![0]).toEqual({
      id: 'T001',
      status: 'done',
      title: 'Dependency',
    });
  });

  it('includes hierarchy path', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Subtask',
        status: 'pending',
        priority: 'medium',
        parentId: 'T002',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await showTask('T003', env.tempDir, accessor);
    expect(result.hierarchyPath).toEqual(['T001', 'T002', 'T003']);
  });
});
