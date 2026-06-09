/**
 * Tests for T11926 — the pure agent-lifecycle LANE RESOLVER.
 *
 * Covers every lane plus the documented precedence ladder
 * (`cancelled > done > blocked > review > running > ready > backlog`) and the
 * dependency-eligibility edge cases. Mirrors the `resolve-column-id.test.ts`
 * structure: pure function, node environment, no Svelte mount.
 *
 * @task T11926
 * @epic T11559
 */

import type { TaskStatus } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import {
  AGENT_LIFECYCLE_LANE_HINTS,
  AGENT_LIFECYCLE_LANE_LABELS,
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
  type AgentLifecycleSignal,
  resolveAgentLifecycleLane,
} from '../agent-lifecycle-lane.js';

/** All-false gate snapshot helper. */
const NO_GATES = { implemented: false, testsPassed: false, qaPassed: false };
/** All-green gate snapshot helper. */
const ALL_GATES = { implemented: true, testsPassed: true, qaPassed: true };

/** Build a signal with sensible non-triggering defaults. */
function signal(
  over: Partial<AgentLifecycleSignal> & { status: TaskStatus },
): AgentLifecycleSignal {
  return {
    blockedBy: null,
    depends: [],
    unmetDependsCount: 0,
    gates: NO_GATES,
    readyToComplete: false,
    prAwaiting: false,
    hitlPending: false,
    workerActive: false,
    ...over,
  };
}

describe('AGENT_LIFECYCLE_LANES taxonomy (T11926)', () => {
  it('declares all seven lanes in canonical order', () => {
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

  it('provides a non-empty label + hint for every lane', () => {
    for (const lane of AGENT_LIFECYCLE_LANES) {
      expect(AGENT_LIFECYCLE_LANE_LABELS[lane]).toBeTruthy();
      expect(AGENT_LIFECYCLE_LANE_HINTS[lane]).toBeTruthy();
    }
  });
});

describe('resolveAgentLifecycleLane — terminal lanes (T11926)', () => {
  it('status=cancelled → cancelled', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'cancelled' }))).toBe('cancelled');
  });

  it('status=done → done', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'done' }))).toBe('done');
  });

  it('cancelled wins even with all-green gates + active worker (terminal short-circuit)', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({
          status: 'cancelled',
          gates: ALL_GATES,
          workerActive: true,
          readyToComplete: true,
        }),
      ),
    ).toBe('cancelled');
  });

  it('done wins even with active worker + PR awaiting (no leak into Running/Review)', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({ status: 'done', workerActive: true, prAwaiting: true, gates: ALL_GATES }),
      ),
    ).toBe('done');
  });
});

describe('resolveAgentLifecycleLane — blocked lane (T11926)', () => {
  it('status=blocked → blocked', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'blocked' }))).toBe('blocked');
  });

  it('non-empty blockedBy reason → blocked (even when status=pending)', () => {
    expect(
      resolveAgentLifecycleLane(signal({ status: 'pending', blockedBy: 'waiting for API key' })),
    ).toBe('blocked');
  });

  it('whitespace-only blockedBy does NOT block', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({ status: 'pending', blockedBy: '   ', nextAction: 'spawn-worker' }),
      ),
    ).toBe('ready');
  });

  it('HITL pending → blocked (even when active)', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({ status: 'active', hitlPending: true, workerActive: true }),
      ),
    ).toBe('blocked');
  });

  it('known-unmet dependency → blocked', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({ status: 'pending', depends: ['T1'], unmetDependsCount: 1 }),
      ),
    ).toBe('blocked');
  });
});

describe('resolveAgentLifecycleLane — review lane (T11926)', () => {
  it('all gates green (non-terminal) → review', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'active', gates: ALL_GATES }))).toBe(
      'review',
    );
  });

  it('readyToComplete=true → review', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'active', readyToComplete: true }))).toBe(
      'review',
    );
  });

  it('PR awaiting → review', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'active', prAwaiting: true }))).toBe(
      'review',
    );
  });

  it('partial gates (impl+tests but not qa) does NOT reach review', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({
          status: 'active',
          gates: { implemented: true, testsPassed: true, qaPassed: false },
        }),
      ),
    ).toBe('running');
  });
});

describe('resolveAgentLifecycleLane — running lane (T11926)', () => {
  it('status=active → running', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'active' }))).toBe('running');
  });

  it('workerActive=true on a pending task → running', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'pending', workerActive: true }))).toBe(
      'running',
    );
  });
});

describe('resolveAgentLifecycleLane — ready lane (T11926)', () => {
  it('pending + deps satisfied + spawn-worker hint → ready', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({
          status: 'pending',
          depends: ['T1'],
          unmetDependsCount: 0,
          nextAction: 'spawn-worker',
        }),
      ),
    ).toBe('ready');
  });

  it('pending + no deps + spawn-worker hint → ready', () => {
    expect(
      resolveAgentLifecycleLane(signal({ status: 'pending', nextAction: 'spawn-worker' })),
    ).toBe('ready');
  });
});

describe('resolveAgentLifecycleLane — backlog lane (T11926)', () => {
  it('plain pending with no dispatch hint → backlog', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'pending' }))).toBe('backlog');
  });

  it('pending with depends but unknown unmet-count → backlog (conservative)', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({
          status: 'pending',
          depends: ['T1'],
          unmetDependsCount: undefined,
          nextAction: 'spawn-worker',
        }),
      ),
    ).toBe('backlog');
  });

  it('pending, deps satisfied, but NO spawn-worker hint → backlog (not yet promoted)', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({ status: 'pending', depends: ['T1'], unmetDependsCount: 0, nextAction: 'verify' }),
      ),
    ).toBe('backlog');
  });
});

describe('resolveAgentLifecycleLane — precedence ladder (T11926)', () => {
  it('Blocked > Running: blocked status with active worker → blocked', () => {
    expect(resolveAgentLifecycleLane(signal({ status: 'blocked', workerActive: true }))).toBe(
      'blocked',
    );
  });

  it('Blocked > Review: blockedBy reason with all gates green → blocked', () => {
    expect(
      resolveAgentLifecycleLane(
        signal({ status: 'active', blockedBy: 'HITL', gates: ALL_GATES, readyToComplete: true }),
      ),
    ).toBe('blocked');
  });

  it('Review > Running: active worker with all gates green → review', () => {
    expect(
      resolveAgentLifecycleLane(signal({ status: 'active', workerActive: true, gates: ALL_GATES })),
    ).toBe('review');
  });

  it('Running > Ready: active status outranks a spawn-worker hint', () => {
    expect(
      resolveAgentLifecycleLane(signal({ status: 'active', nextAction: 'spawn-worker' })),
    ).toBe('running');
  });

  it('Ready > Backlog: spawn-worker hint promotes a pending task out of backlog', () => {
    const base = signal({ status: 'pending' });
    expect(resolveAgentLifecycleLane(base)).toBe('backlog');
    expect(resolveAgentLifecycleLane({ ...base, nextAction: 'spawn-worker' })).toBe('ready');
  });

  it('every lane is reachable by at least one signal (full coverage sweep)', () => {
    const reached = new Set<AgentLifecycleLane>([
      resolveAgentLifecycleLane(signal({ status: 'cancelled' })),
      resolveAgentLifecycleLane(signal({ status: 'done' })),
      resolveAgentLifecycleLane(signal({ status: 'blocked' })),
      resolveAgentLifecycleLane(signal({ status: 'active', gates: ALL_GATES })),
      resolveAgentLifecycleLane(signal({ status: 'active' })),
      resolveAgentLifecycleLane(signal({ status: 'pending', nextAction: 'spawn-worker' })),
      resolveAgentLifecycleLane(signal({ status: 'pending' })),
    ]);
    expect([...reached].sort()).toEqual([...AGENT_LIFECYCLE_LANES].sort());
  });
});
