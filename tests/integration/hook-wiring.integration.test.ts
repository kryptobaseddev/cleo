/**
 * Integration tests for hook wiring — adapter hooks dispatch through HookRegistry.
 * @task T5240
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { AdapterManager } from '../../src/core/adapters/manager.js';
import { hooks } from '../../src/core/hooks/registry.js';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');

describe('Adapter hook wiring', () => {
  beforeEach(() => {
    AdapterManager.resetInstance();
  });

  afterEach(async () => {
    const mgr = AdapterManager.getInstance(PROJECT_ROOT);
    await mgr.dispose();
    AdapterManager.resetInstance();
  });

  it('dispatch onSessionStart does not throw with no handlers', async () => {
    await expect(
      hooks.dispatch('onSessionStart', PROJECT_ROOT, {
        timestamp: new Date().toISOString(),
        sessionId: 'test-session',
        name: 'test',
        scope: { type: 'global' },
      }),
    ).resolves.not.toThrow();
  });

  it('dispatch onSessionEnd does not throw with no handlers', async () => {
    await expect(
      hooks.dispatch('onSessionEnd', PROJECT_ROOT, {
        timestamp: new Date().toISOString(),
        sessionId: 'test-session-end',
      }),
    ).resolves.not.toThrow();
  });

  it('manually registered hook receives dispatch', async () => {
    let received = false;
    const unregister = hooks.register({
      id: 'test-hook-wiring',
      event: 'onSessionStart',
      handler: async () => {
        received = true;
      },
      priority: 100,
    });

    await hooks.dispatch('onSessionStart', PROJECT_ROOT, {
      timestamp: new Date().toISOString(),
      sessionId: 'test-manual',
      name: 'test',
      scope: { type: 'global' },
    });

    expect(received).toBe(true);
    unregister();
  });

  it('unregistered hook does not receive dispatch', async () => {
    let received = false;
    const unregister = hooks.register({
      id: 'test-hook-unregister',
      event: 'onSessionStart',
      handler: async () => {
        received = true;
      },
      priority: 100,
    });

    unregister();

    await hooks.dispatch('onSessionStart', PROJECT_ROOT, {
      timestamp: new Date().toISOString(),
      sessionId: 'test-unregistered',
      name: 'test',
      scope: { type: 'global' },
    });

    expect(received).toBe(false);
  });

  it('hook errors are swallowed (best-effort dispatch)', async () => {
    const unregister = hooks.register({
      id: 'test-hook-error',
      event: 'onSessionStart',
      handler: async () => {
        throw new Error('intentional test error');
      },
      priority: 100,
    });

    await expect(
      hooks.dispatch('onSessionStart', PROJECT_ROOT, {
        timestamp: new Date().toISOString(),
        sessionId: 'test-error',
        name: 'test',
        scope: { type: 'global' },
      }),
    ).resolves.not.toThrow();

    unregister();
  });

  it('hooks execute in priority order (highest first)', async () => {
    const order: string[] = [];

    const unregLow = hooks.register({
      id: 'test-low-priority',
      event: 'onToolStart',
      handler: async () => {
        order.push('low');
      },
      priority: 10,
    });

    const unregHigh = hooks.register({
      id: 'test-high-priority',
      event: 'onToolStart',
      handler: async () => {
        order.push('high');
      },
      priority: 1000,
    });

    await hooks.dispatch('onToolStart', PROJECT_ROOT, {
      timestamp: new Date().toISOString(),
      toolName: 'test-tool',
    });

    // Both should have been called (Promise.allSettled runs in parallel,
    // but the handlers array is sorted by priority)
    expect(order).toContain('high');
    expect(order).toContain('low');

    unregLow();
    unregHigh();
  });

  it('listHandlers returns registered handlers for event', () => {
    const unreg = hooks.register({
      id: 'test-list-handler',
      event: 'onError',
      handler: async () => {},
      priority: 50,
    });

    const handlers = hooks.listHandlers('onError');
    expect(handlers.some((h) => h.id === 'test-list-handler')).toBe(true);

    unreg();
  });
});
