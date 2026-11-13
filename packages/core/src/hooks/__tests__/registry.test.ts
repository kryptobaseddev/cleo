import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HookRegistry } from '../registry.js';

describe('HookRegistry internal coordination events', () => {
  let registry: HookRegistry;

  beforeEach(() => {
    registry = new HookRegistry();
  });

  it('enables autonomous coordination events by default', () => {
    expect(registry.isEnabled('onWorkAvailable')).toBe(true);
    expect(registry.isEnabled('onAgentSpawn')).toBe(true);
    expect(registry.isEnabled('onAgentComplete')).toBe(true);
    expect(registry.isEnabled('onCascadeStart')).toBe(true);
    expect(registry.isEnabled('onPatrol')).toBe(true);
  });

  it('dispatches internal coordination events to registered handlers', async () => {
    const handler = vi.fn();

    registry.register({
      id: 'work-available-handler',
      event: 'onWorkAvailable',
      priority: 10,
      handler,
    });

    await registry.dispatch('onWorkAvailable', '/tmp/project', {
      timestamp: '2026-03-06T05:00:00.000Z',
      epicId: 'T5519',
      taskIds: ['T5520', 'T5522'],
      reason: 'dependency-cleared',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        epicId: 'T5519',
        taskIds: ['T5520', 'T5522'],
        reason: 'dependency-cleared',
      }),
    );
  });

  it('settles response-dependent writes while optional hooks remain tracked separately', async () => {
    const required = Promise.withResolvers<void>();
    const optional = Promise.withResolvers<void>();
    const deferred: Promise<void>[] = [];
    registry.register({
      id: 'capture-write',
      event: 'ResponseComplete',
      priority: 90,
      awaitBeforeResponse: true,
      handler: () => required.promise,
    });
    registry.register({
      id: 'optional-hook',
      event: 'ResponseComplete',
      priority: 100,
      handler: () => optional.promise,
    });
    let completed = false;
    const dispatch = registry
      .dispatch(
        'ResponseComplete',
        '/tmp/project',
        {
          timestamp: new Date().toISOString(),
          gateway: 'mutate',
          domain: 'tasks',
          operation: 'add',
          success: true,
        },
        (work) => {
          deferred.push(work);
        },
      )
      .then(() => {
        completed = true;
      });
    try {
      await Promise.resolve();
      expect(completed).toBe(false);
      expect(deferred).toHaveLength(1);
      required.resolve();
      await dispatch;
      expect(completed).toBe(true);
    } finally {
      required.resolve();
      optional.resolve();
      await dispatch;
      await Promise.all(deferred);
    }
  });
});
