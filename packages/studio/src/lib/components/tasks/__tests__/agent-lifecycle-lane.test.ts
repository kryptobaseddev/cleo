/**
 * Re-export parity test for the Studio agent-lifecycle lane shim.
 *
 * The full behavioural coverage of the resolver now lives with the SSoT in
 * `@cleocode/core/tasks` (see
 * `packages/core/src/tasks/__tests__/agent-lifecycle-lane.test.ts`). This test
 * only confirms the Studio re-export shim (T11934) forwards the same symbols and
 * the same precedence behaviour, so the `/tasks/kanban` route + `KanbanView`
 * keep resolving lanes identically to the `cleo tui` board.
 *
 * @task T11934 — lane model lifted to core; Studio re-exports it
 * @task T11926 — original Studio resolver
 * @epic T11559
 */

import { resolveAgentLifecycleLane as coreResolve } from '@cleocode/core/tasks';
import { describe, expect, it } from 'vitest';
import { AGENT_LIFECYCLE_LANES, resolveAgentLifecycleLane } from '../agent-lifecycle-lane.js';

describe('Studio agent-lifecycle-lane re-export shim (T11934)', () => {
  it('re-exports the canonical resolver from @cleocode/core/tasks (same function identity)', () => {
    expect(resolveAgentLifecycleLane).toBe(coreResolve);
  });

  it('re-exports the canonical seven-lane taxonomy in order', () => {
    expect(AGENT_LIFECYCLE_LANES).toEqual([
      'backlog',
      'ready',
      'running',
      'review',
      'blocked',
      'done',
      'cancelled',
    ]);
  });

  it('resolves the precedence ladder through the shim', () => {
    expect(resolveAgentLifecycleLane({ status: 'cancelled' })).toBe('cancelled');
    expect(resolveAgentLifecycleLane({ status: 'done' })).toBe('done');
    expect(resolveAgentLifecycleLane({ status: 'blocked' })).toBe('blocked');
    expect(
      resolveAgentLifecycleLane({
        status: 'active',
        gates: { implemented: true, testsPassed: true, qaPassed: true },
      }),
    ).toBe('review');
    expect(resolveAgentLifecycleLane({ status: 'active' })).toBe('running');
    expect(resolveAgentLifecycleLane({ status: 'pending', nextAction: 'spawn-worker' })).toBe(
      'ready',
    );
    expect(resolveAgentLifecycleLane({ status: 'pending' })).toBe('backlog');
  });
});
