/**
 * TaskType discriminator narrowing tests.
 *
 * Pins the post-ADR-083 §2.5 union shape (`'saga' | 'epic' | 'task' |
 * 'subtask'`) so that:
 *   - Adding/removing a tier in the canonical {@link TaskType} union breaks
 *     this test loudly (caught at compile time AND runtime).
 *   - Discriminated-union narrowing on `task.type === 'saga'` keeps working
 *     for downstream consumers.
 *
 * @since SAGA T10326 · Epic T10277 · Task T10328 (W1.A)
 */

import { describe, expectTypeOf, it } from 'vitest';
import type { Task, TaskType } from '../task.js';

describe('TaskType discriminator', () => {
  it('narrows when type === "saga"', () => {
    const t: Task = {
      id: 'T1',
      title: 'demo',
      description: 'demo task',
      status: 'pending',
      priority: 'medium',
      type: 'saga',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    if (t.type === 'saga') {
      expectTypeOf(t.type).toEqualTypeOf<'saga'>();
    }
  });

  it('narrows when type === "epic"', () => {
    const t: Task = {
      id: 'T2',
      title: 'demo',
      description: 'demo task',
      status: 'pending',
      priority: 'medium',
      type: 'epic',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    if (t.type === 'epic') {
      expectTypeOf(t.type).toEqualTypeOf<'epic'>();
    }
  });

  it('accepts all 4 tier values', () => {
    const types: TaskType[] = ['saga', 'epic', 'task', 'subtask'];
    expectTypeOf(types).toEqualTypeOf<TaskType[]>();
  });

  it('TaskType is the 4-element union per ADR-083 §2.5', () => {
    expectTypeOf<TaskType>().toEqualTypeOf<'saga' | 'epic' | 'task' | 'subtask'>();
  });
});
