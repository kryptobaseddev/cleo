/**
 * L1/L2 divergence guard (T12120 · GH #1245, #1248).
 *
 * `cleo list` derived its citty FLAGS from the operations registry but
 * hand-copied only a SUBSET of them into the dispatch payload:
 *
 * ```ts
 * if (args['status'] !== undefined) params['status'] = args['status'];
 * // ... 7 of 10 declared params; `compact` was never copied
 * ```
 *
 * So `--help` advertised the registry's surface while dispatch received the
 * hand-copy's surface, and the two drifted silently. `--compact` was
 * advertised, implemented in core, and never delivered (GH #1248).
 *
 * These tests fail if a registry-declared param is not forwarded, so the two
 * halves can never diverge again.
 *
 * @task T12120
 */

import { describe, expect, it } from 'vitest';
import {
  getOperationParams,
  paramsToCittyArgs,
  registryParamsToDispatchPayload,
} from '../registry-args.js';

describe('registryParamsToDispatchPayload (T12120)', () => {
  const listParams = getOperationParams('query', 'tasks', 'list');

  it('forwards EVERY param the tasks.list registry declares', () => {
    // Supply a value for every declared flag, typed per its declaration.
    const args: Record<string, unknown> = {};
    for (const param of listParams) {
      const flag = param.cli?.flag ?? param.name;
      args[flag] =
        param.type === 'boolean' ? true : param.type === 'number' ? 7 : `value-${param.name}`;
    }

    const payload = registryParamsToDispatchPayload(listParams, args);

    const declared = listParams.map((p) => p.name).sort();
    const forwarded = Object.keys(payload).sort();
    expect(forwarded).toEqual(declared);
  });

  it('advertises and forwards the SAME surface — no flag may be help-only', () => {
    const advertised = Object.keys(paramsToCittyArgs(listParams)).sort();
    const forwardable = listParams.map((p) => p.cli?.flag ?? p.name).sort();
    expect(forwardable).toEqual(advertised);
  });

  it('includes the four flags that were previously inert', () => {
    const declared = listParams.map((p) => p.name);
    // GH #1245 / #1246 — never existed at any layer.
    expect(declared).toContain('severity');
    expect(declared).toContain('kind');
    // GH #1247 — declared but never read by the query builder.
    expect(declared).toContain('children');
    // GH #1248 — declared and implemented, but dropped by the CLI hand-copy.
    expect(declared).toContain('compact');
  });

  it('omits params that were not supplied rather than forwarding undefined', () => {
    const payload = registryParamsToDispatchPayload(listParams, { status: 'pending' });
    expect(payload).toEqual({ status: 'pending' });
  });

  it('coerces a number param instead of forwarding the raw string', () => {
    const payload = registryParamsToDispatchPayload(listParams, { limit: '25' });
    expect(payload['limit']).toBe(25);
  });

  it('forwards limit=0 — the "no limit" escape hatch, not a falsy no-op (GH #1242)', () => {
    const payload = registryParamsToDispatchPayload(listParams, { limit: '0' });
    expect(payload['limit']).toBe(0);
  });

  it('drops an unparseable number rather than forwarding NaN', () => {
    const payload = registryParamsToDispatchPayload(listParams, { limit: 'abc' });
    expect(payload).not.toHaveProperty('limit');
  });

  it('maps a CLI flag spelling back to its canonical param name', () => {
    const params = [
      {
        name: 'idempotencyKey',
        type: 'string' as const,
        required: false,
        description: 'token',
        cli: { flag: 'idempotency-key' },
      },
    ];
    const payload = registryParamsToDispatchPayload(params, { 'idempotency-key': 'abc' });
    expect(payload).toEqual({ idempotencyKey: 'abc' });
  });
});
