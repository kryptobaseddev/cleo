/**
 * Tests for the T894 atomic scope enforcement in {@link validateSpawnReadiness}.
 *
 * Verifies:
 *  - Worker role + no files → V_ATOMIC_SCOPE_MISSING error
 *  - Worker role + > MAX_WORKER_FILES → V_ATOMIC_SCOPE_TOO_LARGE error
 *  - Worker role + ≤ MAX_WORKER_FILES → valid (no atomic error)
 *  - Orchestrator role bypasses the file-scope gate
 *  - Lead role bypasses the file-scope gate
 *  - Epic type bypasses the file-scope gate regardless of role
 *  - Existing checks (V_MISSING_DESC, V_ALREADY_DONE, etc.) still work
 *
 * Uses an in-memory fake DataAccessor to keep the tests fast and hermetic.
 *
 * @task T894 Atomic task enforcement
 * @epic T889
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { MAX_WORKER_FILES } from '../atomicity.js';
import { validateSpawnReadiness } from '../validate-spawn.js';

// ---------------------------------------------------------------------------
// Minimal in-memory accessor stub
// ---------------------------------------------------------------------------

function makeAccessor(tasks: Task[]): DataAccessor {
  const map = new Map(tasks.map((t) => [t.id, t]));
  return {
    loadSingleTask: async (id: string) => map.get(id) ?? null,
    loadTasks: async (ids: string[]) => ids.flatMap((id) => (map.get(id) ? [map.get(id)!] : [])),
    queryTasks: async () => ({ tasks: [...map.values()], total: map.size }),
    getChildren: async () => [],
  } as unknown as DataAccessor;
}

// ---------------------------------------------------------------------------
// Base task fixtures
// ---------------------------------------------------------------------------

function baseTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'T9801',
    title: 'Validate-spawn test task',
    description: 'A test task for validate-spawn.',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    createdAt: '2026-04-17T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Existing checks still work
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — existing checks (regression)', () => {
  it('returns V_NOT_FOUND when task is missing', async () => {
    const accessor = makeAccessor([]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_NOT_FOUND')).toBe(true);
  });

  it('returns V_ALREADY_DONE for a completed task', async () => {
    const accessor = makeAccessor([baseTask({ status: 'done' })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_ALREADY_DONE')).toBe(true);
  });

  it('returns V_MISSING_DESC when description is missing', async () => {
    const accessor = makeAccessor([baseTask({ description: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_MISSING_DESC')).toBe(true);
  });

  it('is ready when task is valid and no role is supplied', async () => {
    const accessor = makeAccessor([baseTask()]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.ready).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T894: Atomic scope enforcement — worker role
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — T894 atomic scope (worker role)', () => {
  it('worker role + no files field → V_ATOMIC_SCOPE_MISSING', async () => {
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'V_ATOMIC_SCOPE_MISSING');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('T9801');
  });

  it('worker role + empty files array → V_ATOMIC_SCOPE_MISSING', async () => {
    const accessor = makeAccessor([baseTask({ files: [] })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(false);
    expect(result.issues.some((i) => i.code === 'V_ATOMIC_SCOPE_MISSING')).toBe(true);
  });

  it(`worker role + ${MAX_WORKER_FILES + 1} files → V_ATOMIC_SCOPE_TOO_LARGE`, async () => {
    const tooManyFiles = Array.from(
      { length: MAX_WORKER_FILES + 1 },
      (_, i) => `packages/core/src/file-${i}.ts`,
    );
    const accessor = makeAccessor([baseTask({ files: tooManyFiles })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(false);
    const issue = result.issues.find((i) => i.code === 'V_ATOMIC_SCOPE_TOO_LARGE');
    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain(String(tooManyFiles.length));
  });

  it(`worker role + exactly ${MAX_WORKER_FILES} files → valid`, async () => {
    const exactFiles = Array.from(
      { length: MAX_WORKER_FILES },
      (_, i) => `packages/core/src/file-${i}.ts`,
    );
    const accessor = makeAccessor([baseTask({ files: exactFiles })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(true);
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
  });

  it('worker role + 1 file → valid', async () => {
    const accessor = makeAccessor([baseTask({ files: ['packages/core/src/foo.ts'] })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.ready).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T894: Role and type exemptions
// ---------------------------------------------------------------------------

describe('validateSpawnReadiness — T894 exemptions (orchestrator, lead, epic)', () => {
  it('orchestrator role with no files → valid (exempt)', async () => {
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'orchestrator',
    });
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('lead role with no files → valid (exempt)', async () => {
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'lead',
    });
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('epic type with worker role + no files → valid (epic is exempt)', async () => {
    const accessor = makeAccessor([baseTask({ type: 'epic', files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('worker role + >3 files but epic type → valid (epic exempt)', async () => {
    const manyFiles = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];
    const accessor = makeAccessor([baseTask({ type: 'epic', files: manyFiles })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor, {
      role: 'worker',
    });
    expect(result.issues.some((i) => i.code === 'V_ATOMIC_SCOPE_TOO_LARGE')).toBe(false);
    expect(result.ready).toBe(true);
  });

  it('no role supplied → no V_ATOMIC checks run at all', async () => {
    // Without a role the caller has not yet resolved the spawn role — skip.
    const accessor = makeAccessor([baseTask({ files: undefined })]);
    const result = await validateSpawnReadiness('T9801', undefined, accessor);
    expect(result.issues.some((i) => i.code.startsWith('V_ATOMIC'))).toBe(false);
    expect(result.ready).toBe(true);
  });
});
