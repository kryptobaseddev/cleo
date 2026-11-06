/**
 * Tests for task cancellation operations.
 * @task T4627
 * @epic T4454
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { canCancel } from '../cancel-ops.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

describe('canCancel', () => {
  it('allows cancelling pending tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'pending' }));
    expect(result.allowed).toBe(true);
  });

  it('allows cancelling active tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'active' }));
    expect(result.allowed).toBe(true);
  });

  it('allows cancelling blocked tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'blocked' }));
    expect(result.allowed).toBe(true);
  });

  it('disallows cancelling completed tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'done' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('completed');
  });

  it('disallows cancelling already cancelled tasks', () => {
    const result = canCancel(makeTask({ id: 'T001', status: 'cancelled' }));
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('already cancelled');
  });
});
