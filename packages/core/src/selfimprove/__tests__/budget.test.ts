/**
 * Tests for the self-improvement budget + circuit-breaker (T11889-C · T11913).
 *
 * @epic T11889
 * @task T11913
 */

import { describe, expect, it } from 'vitest';
import { BudgetExceededError, CircuitBreaker, DEFAULT_BUDGET, resolveBudget } from '../budget.js';

describe('resolveBudget — invariant clamps', () => {
  it('pins maxPrs and maxWorktrees to at most 1', () => {
    const b = resolveBudget({ maxPrs: 99, maxWorktrees: 50 }, {});
    expect(b.maxPrs).toBe(1);
    expect(b.maxWorktrees).toBe(1);
  });

  it('applies explicit token/usd overrides', () => {
    const b = resolveBudget({ maxTokens: 5, maxUsd: 2 }, {});
    expect(b.maxTokens).toBe(5);
    expect(b.maxUsd).toBe(2);
  });

  it('reads env overrides when no explicit value', () => {
    const b = resolveBudget(
      {},
      { CLEO_SELFIMPROVE_MAX_TOKENS: '123', CLEO_SELFIMPROVE_MAX_USD: '7' },
    );
    expect(b.maxTokens).toBe(123);
    expect(b.maxUsd).toBe(7);
  });

  it('falls back to defaults on bad env values', () => {
    const b = resolveBudget({}, { CLEO_SELFIMPROVE_MAX_TOKENS: 'nope' });
    expect(b.maxTokens).toBe(DEFAULT_BUDGET.maxTokens);
  });
});

describe('CircuitBreaker — latch', () => {
  it('starts closed and trips one-way (first reason wins)', () => {
    const cb = new CircuitBreaker();
    expect(cb.isOpen).toBe(false);
    cb.trip('gateRed', 'first');
    cb.trip('dbError', 'second');
    expect(cb.isOpen).toBe(true);
    expect(cb.state.reason).toBe('gateRed');
    expect(cb.state.detail).toBe('first');
  });

  it('assertClosed throws once tripped', () => {
    const cb = new CircuitBreaker();
    expect(() => cb.assertClosed()).not.toThrow();
    cb.trip('leaseUnavailable', 'denied');
    expect(() => cb.assertClosed()).toThrow(/E_SELFIMPROVE_CIRCUIT_OPEN|circuit-breaker OPEN/);
  });
});

describe('CircuitBreaker — chargeOrTrip (pre-flight budget)', () => {
  it('commits charges that fit and accumulates spend', () => {
    const cb = new CircuitBreaker({ maxTokens: 100, maxUsd: 10, maxPrs: 1, maxWorktrees: 1 });
    cb.chargeOrTrip({ tokens: 40 });
    cb.chargeOrTrip({ tokens: 40 });
    expect(cb.spend.tokens).toBe(80);
    expect(cb.isOpen).toBe(false);
  });

  it('trips with budgetOverrun and throws BudgetExceededError when a cap is exceeded', () => {
    const cb = new CircuitBreaker({ maxTokens: 100, maxUsd: 10, maxPrs: 1, maxWorktrees: 1 });
    cb.chargeOrTrip({ tokens: 90 });
    expect(() => cb.chargeOrTrip({ tokens: 20 })).toThrow(BudgetExceededError);
    expect(cb.isOpen).toBe(true);
    expect(cb.state.reason).toBe('budgetOverrun');
    // The over-limit charge was NOT committed.
    expect(cb.spend.tokens).toBe(90);
  });

  it('maxPrs=1 ceiling: the second PR charge trips', () => {
    const cb = new CircuitBreaker({ maxTokens: 1e6, maxUsd: 1e6, maxPrs: 1, maxWorktrees: 1 });
    cb.chargeOrTrip({ prs: 1 });
    expect(() => cb.chargeOrTrip({ prs: 1 })).toThrow(BudgetExceededError);
    expect(cb.state.reason).toBe('budgetOverrun');
  });

  it('maxWorktrees=0 budget trips the first boot charge', () => {
    const cb = new CircuitBreaker({ maxTokens: 1e6, maxUsd: 1e6, maxPrs: 1, maxWorktrees: 0 });
    expect(() => cb.chargeOrTrip({ worktrees: 1 })).toThrow(BudgetExceededError);
  });
});
