/**
 * Tests for T11928 — the pure lane→lane DRAG-TRANSITION rules.
 *
 * Covers the validity ladder (`same-lane > terminal-source >
 * gate-protected-target > resolved-target > plan`) and the status mapping for
 * every draggable target lane. Mirrors the `agent-lifecycle-lane.test.ts`
 * structure: pure function, node environment, no Svelte mount.
 *
 * @task T11928
 * @epic T11559
 */

import { describe, expect, it } from 'vitest';
import type { AgentLifecycleLane } from '../agent-lifecycle-lane.js';
import {
  isDraggableTargetLane,
  type LaneTransitionPlan,
  planLaneTransition,
} from '../lane-transition.js';

/** Narrow an ok result to its plan, failing loudly otherwise. */
function expectPlan(
  from: AgentLifecycleLane,
  to: AgentLifecycleLane,
  taskId = 'T1',
): LaneTransitionPlan {
  const res = planLaneTransition(taskId, from, to);
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error('expected ok plan');
  return res.plan;
}

describe('planLaneTransition — valid drags map to a tasks.update status (T11928)', () => {
  it('backlog → running sets status active', () => {
    const plan = expectPlan('backlog', 'running');
    expect(plan.status).toBe('active');
    expect(plan.fromLane).toBe('backlog');
    expect(plan.toLane).toBe('running');
    expect(plan.taskId).toBe('T1');
    expect(plan.summary).toContain('Backlog');
    expect(plan.summary).toContain('Running');
  });

  it('running → backlog sets status pending (defer)', () => {
    expect(expectPlan('running', 'backlog').status).toBe('pending');
  });

  it('running → blocked sets status blocked', () => {
    expect(expectPlan('running', 'blocked').status).toBe('blocked');
  });

  it('backlog → cancelled sets status cancelled', () => {
    expect(expectPlan('backlog', 'cancelled').status).toBe('cancelled');
  });

  it('cancelled → backlog is allowed (un-abandon)', () => {
    expect(expectPlan('cancelled', 'backlog').status).toBe('pending');
  });

  it('blocked → running clears the block (active)', () => {
    expect(expectPlan('blocked', 'running').status).toBe('active');
  });
});

describe('planLaneTransition — invalid drags are rejected with a typed reason (T11928)', () => {
  it('rejects a same-lane no-op', () => {
    const res = planLaneTransition('T1', 'running', 'running');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('same-lane');
  });

  it('rejects dragging OUT of Done (terminal source)', () => {
    const res = planLaneTransition('T1', 'done', 'running');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('terminal-source');
  });

  it('rejects dragging INTO Done (gate-protected — no bypass)', () => {
    const res = planLaneTransition('T1', 'running', 'done');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('gate-protected-target');
    expect(res.message).toMatch(/verification gates/i);
  });

  it('rejects dropping into Ready (resolved lane)', () => {
    const res = planLaneTransition('T1', 'backlog', 'ready');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('resolved-target');
  });

  it('rejects dropping into Review (resolved lane)', () => {
    const res = planLaneTransition('T1', 'running', 'review');
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.reason).toBe('resolved-target');
  });
});

describe('isDraggableTargetLane (T11928)', () => {
  it('accepts backlog / running / blocked / cancelled', () => {
    for (const lane of ['backlog', 'running', 'blocked', 'cancelled'] as const) {
      expect(isDraggableTargetLane(lane)).toBe(true);
    }
  });

  it('rejects ready / review / done', () => {
    for (const lane of ['ready', 'review', 'done'] as const) {
      expect(isDraggableTargetLane(lane)).toBe(false);
    }
  });
});
