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
});
