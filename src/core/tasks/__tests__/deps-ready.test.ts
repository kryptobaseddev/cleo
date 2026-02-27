/**
 * Tests for the shared depsReady utility.
 * @task T4820
 */

import { describe, it, expect } from 'vitest';
import { depsReady } from '../deps-ready.js';

describe('depsReady', () => {
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

  it('returns true when all deps are cancelled', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'cancelled' }],
    ]);
    expect(depsReady(['T001'], lookup)).toBe(true);
  });

  it('returns true with mix of done and cancelled deps', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'done' }],
      ['T002', { status: 'cancelled' }],
    ]);
    expect(depsReady(['T001', 'T002'], lookup)).toBe(true);
  });

  it('returns false when any dep is pending', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'done' }],
      ['T002', { status: 'pending' }],
    ]);
    expect(depsReady(['T001', 'T002'], lookup)).toBe(false);
  });

  it('returns false when any dep is active', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'active' }],
    ]);
    expect(depsReady(['T001'], lookup)).toBe(false);
  });

  it('returns false when any dep is blocked', () => {
    const lookup = new Map<string, { status: string }>([
      ['T001', { status: 'blocked' }],
    ]);
    expect(depsReady(['T001'], lookup)).toBe(false);
  });

  it('returns false when dep ID is not in lookup', () => {
    const lookup = new Map<string, { status: string }>();
    expect(depsReady(['T999'], lookup)).toBe(false);
  });

  it('returns false when dep is null in lookup', () => {
    const lookup = new Map<string, unknown>([
      ['T001', null],
    ]);
    expect(depsReady(['T001'], lookup as ReadonlyMap<string, { status?: string } | unknown>)).toBe(false);
  });

  it('returns false when dep has no status property', () => {
    const lookup = new Map<string, unknown>([
      ['T001', { title: 'no status' }],
    ]);
    expect(depsReady(['T001'], lookup as ReadonlyMap<string, { status?: string } | unknown>)).toBe(false);
  });

  it('accepts Map<string, unknown> without type errors', () => {
    const lookup = new Map<string, unknown>([
      ['T001', { status: 'done', title: 'task', extra: 42 }],
    ]);
    expect(depsReady(['T001'], lookup as ReadonlyMap<string, { status?: string } | unknown>)).toBe(true);
  });
});
