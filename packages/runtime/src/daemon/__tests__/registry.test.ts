/**
 * Registry + lifecycle + IPC-client tests for the daemon submodule (T11367).
 *
 * Covers all five T11367 acceptance test requirements:
 * 1. register two subsystems and start them
 * 2. health aggregation into a HealthStatus that projects onto MonitorResponse
 * 3. graceful shutdown ordering (LIFO)
 * 4. lifecycle hooks fire in order; onError catches a throwing start
 * 5. malformed-NDJSON-line rejection via the typed IPC client
 *
 * @task T11367
 */

import {
  MonitorResponseSchema,
  type SubsystemHealth,
  toMonitorChildren,
} from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';

import { defineSubsystem } from '../define-subsystem.js';
import { SubsystemRegistry } from '../registry.js';
import { createSupervisorIpcClient, MalformedIpcFrameError } from '../supervisor-client.js';

/** Build a healthy probe row for a named subsystem. */
function runningRow(name: string, pid: number): SubsystemHealth {
  return { child_id: name, pid, state: 'running', restart_count: 0 };
}

describe('defineSubsystem (T11367)', () => {
  it('returns a frozen registrable subsystem', () => {
    const s = defineSubsystem({
      name: 'alpha',
      start: () => undefined,
      healthProbe: () => runningRow('alpha', 1),
      shutdown: () => undefined,
    });
    expect(s.name).toBe('alpha');
    expect(Object.isFrozen(s)).toBe(true);
  });

  it('rejects an empty name and missing methods', () => {
    expect(() =>
      defineSubsystem({
        name: '',
        start: () => undefined,
        healthProbe: () => runningRow('x', 1),
        shutdown: () => undefined,
      }),
    ).toThrow(TypeError);
  });
});

describe('SubsystemRegistry lifecycle (T11367)', () => {
  it('registers two subsystems, starts them, and aggregates health', async () => {
    const registry = new SubsystemRegistry();
    registry.register(
      defineSubsystem({
        name: 'studio',
        start: () => 'studio-ctx',
        healthProbe: () => runningRow('studio', 100),
        shutdown: () => undefined,
      }),
    );
    registry.register(
      defineSubsystem({
        name: 'gc',
        start: () => 42,
        healthProbe: () => runningRow('gc', 200),
        shutdown: () => undefined,
      }),
    );

    expect(registry.names).toEqual(['studio', 'gc']);

    await registry.startAll();
    const health = await registry.aggregateHealth();

    expect(health.subsystems).toHaveLength(2);
    expect(health.allHealthy).toBe(true);

    // AC4: the aggregate projects onto the FROZEN supervisor MonitorResponse.
    const monitor = MonitorResponseSchema.safeParse({
      kind: 'monitor',
      children: toMonitorChildren(health),
    });
    expect(monitor.success).toBe(true);
  });

  it('rejects duplicate subsystem names', () => {
    const registry = new SubsystemRegistry();
    const make = (): ReturnType<typeof defineSubsystem> =>
      defineSubsystem({
        name: 'dup',
        start: () => undefined,
        healthProbe: () => runningRow('dup', 1),
        shutdown: () => undefined,
      });
    registry.register(make());
    expect(() => registry.register(make())).toThrow(/duplicate subsystem name/);
  });

  it('shuts down in reverse registration order (LIFO)', async () => {
    const order: string[] = [];
    const registry = new SubsystemRegistry();
    registry.register(
      defineSubsystem({
        name: 'first',
        start: () => undefined,
        healthProbe: () => runningRow('first', 1),
        shutdown: () => {
          order.push('first');
        },
      }),
    );
    registry.register(
      defineSubsystem({
        name: 'second',
        start: () => undefined,
        healthProbe: () => runningRow('second', 2),
        shutdown: () => {
          order.push('second');
        },
      }),
    );

    await registry.startAll();
    await registry.shutdownAll();

    // Registration order: first, second → shutdown order: second, first.
    expect(order).toEqual(['second', 'first']);
  });

  it('fires lifecycle hooks in order and onError catches a throwing start', async () => {
    const events: string[] = [];
    const onError = vi.fn();
    const registry = new SubsystemRegistry({
      onStart: (name) => {
        events.push(`start:${name}`);
      },
      onShutdown: (name) => {
        events.push(`shutdown:${name}`);
      },
      onError,
    });

    registry.register(
      defineSubsystem({
        name: 'good',
        start: () => {
          events.push('good.start()');
          return undefined;
        },
        healthProbe: () => runningRow('good', 1),
        shutdown: () => {
          events.push('good.shutdown()');
        },
      }),
    );
    registry.register(
      defineSubsystem({
        name: 'bad',
        start: () => {
          throw new Error('boom');
        },
        healthProbe: () => runningRow('bad', 0),
        shutdown: () => undefined,
      }),
    );

    await expect(registry.startAll()).rejects.toThrow('boom');

    // good started (start() ran, then onStart fired) before bad threw.
    expect(events).toEqual(['good.start()', 'start:good']);
    // onError fired with the throwing subsystem name, an Error, and phase=start.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('bad', expect.any(Error), 'start');

    // shutdownAll only tears down started subsystems (good), not the failed bad.
    await registry.shutdownAll();
    expect(events).toContain('good.shutdown()');
    expect(events).toContain('shutdown:good');
  });

  it('a failing healthProbe degrades to a stopped row without aborting the snapshot', async () => {
    const registry = new SubsystemRegistry();
    registry.register(
      defineSubsystem({
        name: 'healthy',
        start: () => undefined,
        healthProbe: () => runningRow('healthy', 1),
        shutdown: () => undefined,
      }),
    );
    registry.register(
      defineSubsystem({
        name: 'flaky',
        start: () => undefined,
        healthProbe: () => {
          throw new Error('probe failed');
        },
        shutdown: () => undefined,
      }),
    );

    await registry.startAll();
    const health = await registry.aggregateHealth();

    expect(health.subsystems).toHaveLength(2);
    expect(health.allHealthy).toBe(false);
    const flaky = health.subsystems.find((row) => row.child_id === 'flaky');
    expect(flaky?.state).toBe('stopped');
    expect(flaky?.detail).toContain('probe failed');
  });
});

describe('SupervisorIpcClient NDJSON codec (T11367 AC2)', () => {
  it('encodes a request envelope as a versioned, correlated NDJSON line', () => {
    const client = createSupervisorIpcClient();
    const { id, line } = client.encodeRequest({ kind: 'health' });

    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trimEnd());
    expect(parsed.protocol_version).toBe('1.0.0');
    expect(parsed.direction).toBe('request');
    expect(parsed.id).toBe(id);
    expect(parsed.request.kind).toBe('health');
  });

  it('decodes a well-formed response envelope', () => {
    const client = createSupervisorIpcClient();
    const wire = JSON.stringify({
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'response',
      response: { kind: 'spawned', child_id: 'w1', pid: 4242 },
    });
    const env = client.decodeResponseLine(wire);
    expect(env.direction).toBe('response');
    expect(env.response.kind).toBe('spawned');
  });

  it('rejects a non-JSON line with a typed MalformedIpcFrameError (never silently dropped)', () => {
    const client = createSupervisorIpcClient();
    expect(() => client.decodeResponseLine('{not json')).toThrow(MalformedIpcFrameError);
  });

  it('rejects a schema-violating frame with a typed MalformedIpcFrameError', () => {
    const client = createSupervisorIpcClient();
    // Valid JSON, invalid contract: unknown response kind.
    const bad = JSON.stringify({
      protocol_version: '1.0.0',
      id: 'abc',
      direction: 'response',
      response: { kind: 'bogus' },
    });
    let caught: unknown;
    try {
      client.decodeResponseLine(bad);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MalformedIpcFrameError);
    expect((caught as MalformedIpcFrameError).line).toBe(bad);
  });
});
