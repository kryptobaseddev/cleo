/**
 * Tests for the Urgency line rendered by `cleo show` (T9905).
 *
 * The renderer now emits a `Urgency:` line that lays the two orthogonal axes
 * side-by-side, e.g. `Urgency:    priority=critical severity=P0`. Tasks with
 * no severity render `severity=—` so the dual-axis is visible even when only
 * one side carries data.
 *
 * @task T9905
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { renderShow } from '../show.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.id,
    description: '',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    parentId: null,
    labels: [],
    depends: [],
    acceptance: [],
    createdAt: '2026-04-22T00:00:00Z',
    ...overrides,
  } as Task;
}

/** Strip ANSI escape codes for legible assertion. */
function stripAnsi(s: string): string {
  return s.replace(/\[[0-9;]*m/g, '');
}

describe('renderShow urgency line (T9905)', () => {
  it('renders a Urgency line carrying both axes', () => {
    const out = stripAnsi(
      renderShow({ task: makeTask({ id: 'T1', priority: 'critical', severity: 'P0' }) }, false),
    );
    expect(out).toMatch(/Urgency:/);
    expect(out).toMatch(/priority=critical/);
    expect(out).toMatch(/severity=P0/);
  });

  it('emits a placeholder for missing severity', () => {
    const out = stripAnsi(renderShow({ task: makeTask({ id: 'T1', priority: 'high' }) }, false));
    expect(out).toMatch(/Urgency:/);
    expect(out).toMatch(/severity=—/);
  });
});
