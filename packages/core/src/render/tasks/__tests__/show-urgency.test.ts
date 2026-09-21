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

import type { Task, TestGate } from '@cleocode/contracts';
import type { AdminContextPullResult } from '@cleocode/contracts/operations/admin';
import { describe, expect, it } from 'vitest';
import { renderShow } from '../show.js';

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
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
  };
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

describe('typed requirement read consumers (T12292)', () => {
  it('retains literal text and every typed gate field in human output and admin task snapshots', () => {
    const gate: TestGate = {
      kind: 'test',
      req: 'PARTNER-001',
      description: 'Verify exact partner completion',
      command: 'node',
      args: ['axiom-app/scripts/verify-partner-completion.mjs', '--task', 'T001'],
      expect: 'exit0',
      cwd: 'included-root',
      env: { FIXTURE_VALUE: 'literal | ü' },
      timeoutMs: 1800000,
    };
    const task = makeTask({ id: 'T001', acceptance: ['literal | criterion', gate] });
    const contextTask: AdminContextPullResult['task'] = {
      id: task.id,
      title: task.title,
      status: task.status,
      acceptance: task.acceptance ?? [],
    };
    expect(contextTask.acceptance).toEqual(['literal | criterion', gate]);
    const rendered = stripAnsi(renderShow({ task }, false));
    expect(rendered).toContain('literal | criterion');
    expect(rendered).toContain(JSON.stringify(gate));
    expect(rendered).not.toContain('[object Object]');
    expect(task.acceptance).toEqual(['literal | criterion', gate]);
  });
});
