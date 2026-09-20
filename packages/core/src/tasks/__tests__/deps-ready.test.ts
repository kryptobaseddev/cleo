/**
 * Tests for the shared depsReady utility.
 * @task T4820
 */

import { TASK_STATUSES } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { depsReady } from '../deps-ready.js';

describe('depsReady', () => {
  it.each([
    ['pending', false],
    ['active', false],
    ['blocked', false],
    ['done', true],
    ['cancelled', false],
    ['archived', true],
    ['proposed', false],
  ] as const)('assesses %s against independent execution-readiness outcomes', (status, expected) => {
    expect(depsReady(['T100'], new Map([['T100', { status }]]))).toBe(expected);
  });

  it('covers every canonical status without deriving expectations from the implementation', () => {
    expect([...TASK_STATUSES].sort()).toEqual([
      'active',
      'archived',
      'blocked',
      'cancelled',
      'done',
      'pending',
      'proposed',
    ]);
  });

  it.each([
    42,
    false,
    'task',
    { status: 42 },
    { status: 'invented' },
  ])('rejects malformed or unsupported dependency evidence %j', (record) => {
    expect(depsReady(['T100'], new Map([['T100', record]]))).toBe(false);
  });

  it('returns true when depends is undefined', () => {
    const lookup = new Map<string, { status: string }>();
    expect(depsReady(undefined, lookup)).toBe(true);
  });

  it('returns true when depends is empty', () => {
    const lookup = new Map<string, { status: string }>();
    expect(depsReady([], lookup)).toBe(true);
  });

  it('returns true when all deps are done', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'done' }],
      ['T002', { status: 'done' }],
    ]);
    expect(depsReady(['T001', 'T002'], lookup)).toBe(true);
  });

  it('blocks cancelled dependencies under the spawn readiness contract', () => {
    const lookup = new Map<string, { status: string }>([['T001', { status: 'cancelled' }]]);
    expect(depsReady(['T001'], lookup)).toBe(false);
  });

  it('blocks a mix containing cancelled dependencies under the spawn contract', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'done' }],
      ['T002', { status: 'cancelled' }],
    ]);
    expect(depsReady(['T001', 'T002'], lookup)).toBe(false);
  });

  it('returns false when any dep is pending', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'done' }],
      ['T002', { status: 'pending' }],
    ]);
    expect(depsReady(['T001', 'T002'], lookup)).toBe(false);
  });

  it('returns false when any dep is active', () => {
    const lookup = new Map<string, { status: string }>([['T001', { status: 'active' }]]);
    expect(depsReady(['T001'], lookup)).toBe(false);
  });

  it('returns false when any dep is blocked', () => {
    const lookup = new Map<string, { status: string }>([['T001', { status: 'blocked' }]]);
    expect(depsReady(['T001'], lookup)).toBe(false);
  });

  it('returns false when dep ID is not in lookup', () => {
    const lookup = new Map<string, { status: string }>();
    expect(depsReady(['T999'], lookup)).toBe(false);
  });

  it('returns false when dep is null in lookup', () => {
    const lookup = new Map<string, unknown>([['T001', null]]);
    expect(depsReady(['T001'], lookup as ReadonlyMap<string, { status?: string } | unknown>)).toBe(
      false,
    );
  });

  it('returns false when dep has no status property', () => {
    const lookup = new Map<string, unknown>([['T001', { title: 'no status' }]]);
    expect(depsReady(['T001'], lookup as ReadonlyMap<string, { status?: string } | unknown>)).toBe(
      false,
    );
  });

  it('accepts Map<string, unknown> without type errors', () => {
    const lookup = new Map<string, unknown>([
      ['T001', { status: 'done', title: 'task', extra: 42 }],
    ]);
    expect(depsReady(['T001'], lookup as ReadonlyMap<string, { status?: string } | unknown>)).toBe(
      true,
    );
  });
});
