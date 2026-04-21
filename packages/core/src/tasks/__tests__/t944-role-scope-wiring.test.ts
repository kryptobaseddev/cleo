/**
 * T944 — role/scope/severity wiring tests.
 *
 * Verifies that:
 * - `addTask` accepts and persists role/scope/severity
 * - `findTasks` filters by role
 * - `rowToTask` / `taskToRow` round-trip role/scope/severity
 * - DB column defaults are applied when role/scope are omitted
 *
 * @task T944
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks } from '../find.js';

describe('T944 role/scope wiring — addTask + findTasks', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('round-trips role and scope through upsertSingleTask + loadSingleTask', async () => {
    await accessor.upsertSingleTask({
      id: 'T100',
      title: 'Bug task',
      description: 'A bug with explicit role and scope',
      status: 'pending',
      priority: 'high',
      createdAt: new Date().toISOString(),
      role: 'bug',
      scope: 'feature',
    });

    const loaded = await accessor.loadSingleTask('T100');
    expect(loaded).toBeTruthy();
    expect(loaded!.role).toBe('bug');
    expect(loaded!.scope).toBe('feature');
    expect(loaded!.severity).toBeUndefined();
  });

  it('preserves severity for bug role', async () => {
    await accessor.upsertSingleTask({
      id: 'T101',
      title: 'P0 bug',
      description: 'Critical production bug',
      status: 'pending',
      priority: 'critical',
      createdAt: new Date().toISOString(),
      role: 'bug',
      scope: 'project',
      severity: 'P0',
    });

    const loaded = await accessor.loadSingleTask('T101');
    expect(loaded).toBeTruthy();
    expect(loaded!.role).toBe('bug');
    expect(loaded!.scope).toBe('project');
    expect(loaded!.severity).toBe('P0');
  });

  it('findTasks --role filter returns only matching tasks', async () => {
    await accessor.upsertSingleTask({
      id: 'T200',
      title: 'Research task',
      description: 'A research item',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      role: 'research',
      scope: 'feature',
    });

    await accessor.upsertSingleTask({
      id: 'T201',
      title: 'Work task',
      description: 'Standard implementation',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      role: 'work',
      scope: 'feature',
    });

    const researchResults = await findTasks(
      { query: 'task', role: 'research' },
      env.tempDir,
      accessor,
    );
    expect(researchResults.results.some((r) => r.id === 'T200')).toBe(true);
    expect(researchResults.results.some((r) => r.id === 'T201')).toBe(false);

    const workResults = await findTasks({ query: 'task', role: 'work' }, env.tempDir, accessor);
    expect(workResults.results.some((r) => r.id === 'T201')).toBe(true);
    expect(workResults.results.some((r) => r.id === 'T200')).toBe(false);
  });

  it('findTasks without --role filter returns all matching tasks', async () => {
    await accessor.upsertSingleTask({
      id: 'T300',
      title: 'Spike task alpha',
      description: 'Spike exploration',
      status: 'pending',
      priority: 'low',
      createdAt: new Date().toISOString(),
      role: 'spike',
      scope: 'unit',
    });

    await accessor.upsertSingleTask({
      id: 'T301',
      title: 'Spike task beta',
      description: 'Another spike',
      status: 'pending',
      priority: 'low',
      createdAt: new Date().toISOString(),
      role: 'research',
      scope: 'unit',
    });

    const allResults = await findTasks({ query: 'spike task' }, env.tempDir, accessor);
    const ids = allResults.results.map((r) => r.id);
    expect(ids).toContain('T300');
    expect(ids).toContain('T301');
  });

  it('role defaults to "work" when omitted on insert', async () => {
    await accessor.upsertSingleTask({
      id: 'T400',
      title: 'Default role task',
      description: 'Should inherit work role default',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    });

    const loaded = await accessor.loadSingleTask('T400');
    expect(loaded).toBeTruthy();
    // DB default is 'work' — rowToTask maps it through
    expect(loaded!.role).toBe('work');
  });

  it('scope defaults to "feature" when omitted on insert', async () => {
    await accessor.upsertSingleTask({
      id: 'T401',
      title: 'Default scope task',
      description: 'Should inherit feature scope default',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    });

    const loaded = await accessor.loadSingleTask('T401');
    expect(loaded).toBeTruthy();
    expect(loaded!.scope).toBe('feature');
  });
});
