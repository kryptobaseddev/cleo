/**
 * Self-improvement dispatch handler tests (T11889 · T11889-D).
 *
 * Drives the REAL {@link SelfimproveHandler} in isolation — the CORE
 * `runSelfImprove` engine and the cleo-side dispatcher are both mocked, so the
 * test exercises ONLY the thin delegate's contract:
 *
 *   1. **Registry-parity contract** — `mutate('run', {})` must NOT return
 *      `E_INVALID_OPERATION` (the handler recognizes the op); with no scenario
 *      it returns `E_INVALID_INPUT` BEFORE any engine call or dispatcher bind
 *      (so the global registry-parity sweep can invoke it with empty params).
 *   2. **Delegation** — `mutate('run', { scenario })` calls CORE `runSelfImprove`
 *      with the injected `ReplayDispatch` port and default `execute:false`
 *      (the default-OFF guardrail).
 *   3. **Default-OFF / dry-run interplay** — `--execute` permits mutation only
 *      when `--dry-run` is NOT also set.
 *   4. **OperationDef SSoT** — the `selfimprove.run` entry exists in the
 *      OPERATIONS registry with `requiredParams: ['scenario']` and `selfimprove`
 *      is a canonical domain.
 *
 * @task T11914
 * @epic T11889
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// `vi.mock` factories are hoisted above all imports + top-level consts, so the
// mock fns are created via `vi.hoisted` to be available inside the factory.
const { runSelfImproveMock, dispatchMock } = vi.hoisted(() => ({
  runSelfImproveMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

// Mock the CORE engine barrel — the handler imports `runSelfImprove` +
// `getProjectRoot` + `getLogger` from `@cleocode/core/internal`. Stubbing it
// keeps the test off the heavy core/runtime dependency tree.
vi.mock('@cleocode/core/internal', () => ({
  runSelfImprove: runSelfImproveMock,
  getProjectRoot: vi.fn(() => '/tmp/selfimprove-test'),
  getLogger: vi.fn(() => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Mock the cli adapter so the lazy `import('../adapters/cli.js')` inside the
// handler resolves a fake dispatcher (never touches the real DB/registry).
vi.mock('../../adapters/cli.js', () => ({
  getCliDispatcher: vi.fn(() => ({ dispatch: dispatchMock })),
}));

// Stub `createDispatchMeta` so the handler's `_base → _meta` chain does not pull
// the full `@cleocode/runtime/gateway` source graph (an unbuilt dependency tree
// in sparse worktrees). `_meta.ts` is the ONLY runtime/gateway touch in scope.
vi.mock('@cleocode/runtime/gateway', () => ({
  createDispatchMeta: (gateway: string, domain: string, operation: string) => ({
    gateway,
    domain,
    operation,
    requestId: 'test-request-id',
    duration_ms: 0,
    timestamp: new Date(0).toISOString(),
  }),
}));

import { CANONICAL_DOMAINS, OPERATIONS } from '@cleocode/contracts';
import { SelfimproveHandler } from '../selfimprove.js';

describe('SelfimproveHandler dispatch (T11889 · T11889-D)', () => {
  let handler: SelfimproveHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new SelfimproveHandler();
  });

  it('declares only the run mutation op', () => {
    expect(handler.getSupportedOperations()).toEqual({ query: [], mutate: ['run'] });
  });

  it('rejects a missing scenario with E_INVALID_INPUT, NOT E_INVALID_OPERATION', async () => {
    const res = await handler.mutate('run', {});
    expect(res.success).toBe(false);
    // The registry-parity contract: the handler RECOGNIZES `run` (so it never
    // returns E_INVALID_OPERATION) but rejects the empty params it is swept with.
    expect(res.error?.code).toBe('E_INVALID_INPUT');
    expect(res.error?.code).not.toBe('E_INVALID_OPERATION');
    // Param validation runs BEFORE any engine call.
    expect(runSelfImproveMock).not.toHaveBeenCalled();
  });

  it('returns E_INVALID_OPERATION for an unknown mutate op', async () => {
    const res = await handler.mutate('frobnicate', { scenario: 'x' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_OPERATION');
  });

  it('returns E_INVALID_OPERATION for any query op (no read surface)', async () => {
    const res = await handler.query('run', { scenario: 'x' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_INVALID_OPERATION');
  });

  it('delegates run to CORE runSelfImprove (default OFF — execute:false)', async () => {
    runSelfImproveMock.mockResolvedValue({
      outcome: 'regression-dry-run',
      scenario: 'dhq-replay-find',
      runId: 'selfimprove-1',
      executed: false,
      regressions: [],
      questionHash: null,
      draftPr: null,
      breaker: { open: false, reason: null, detail: null },
    });

    const res = await handler.mutate('run', { scenario: 'dhq-replay-find' });

    expect(res.success).toBe(true);
    expect(runSelfImproveMock).toHaveBeenCalledTimes(1);
    const opts = runSelfImproveMock.mock.calls[0]![0];
    expect(opts.scenario).toBe('dhq-replay-find');
    // Default OFF: no --execute ⇒ execute:false.
    expect(opts.execute).toBe(false);
    // The injected ReplayDispatch port is a function (closes over the dispatcher).
    expect(typeof opts.dispatch).toBe('function');
  });

  it('permits mutation when --execute is set and --dry-run is NOT', async () => {
    runSelfImproveMock.mockResolvedValue({
      outcome: 'green',
      scenario: 'dhq-replay-find',
      runId: 'r',
      executed: true,
      regressions: [],
      questionHash: null,
      draftPr: null,
      breaker: { open: false, reason: null, detail: null },
    });

    await handler.mutate('run', { scenario: 'dhq-replay-find', execute: true });
    expect(runSelfImproveMock.mock.calls[0]![0].execute).toBe(true);
  });

  it('forces DRY-RUN when --dry-run is set even with --execute (default-OFF wins)', async () => {
    runSelfImproveMock.mockResolvedValue({
      outcome: 'green',
      scenario: 'dhq-replay-find',
      runId: 'r',
      executed: false,
      regressions: [],
      questionHash: null,
      draftPr: null,
      breaker: { open: false, reason: null, detail: null },
    });

    await handler.mutate('run', { scenario: 'dhq-replay-find', execute: true, dryRun: true });
    expect(runSelfImproveMock.mock.calls[0]![0].execute).toBe(false);
  });

  it('surfaces an engine throw as E_INTERNAL (not a crash)', async () => {
    runSelfImproveMock.mockRejectedValue(new Error('boom'));
    const res = await handler.mutate('run', { scenario: 'dhq-replay-find' });
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('E_INTERNAL');
    expect(res.error?.message).toContain('boom');
  });

  it('the ReplayDispatch port forwards to the cli dispatcher with source=rpc', async () => {
    runSelfImproveMock.mockResolvedValue({
      outcome: 'green',
      scenario: 's',
      runId: 'r',
      executed: false,
      regressions: [],
      questionHash: null,
      draftPr: null,
      breaker: { open: false, reason: null, detail: null },
    });
    dispatchMock.mockResolvedValue({ meta: {}, success: true, data: {} });

    await handler.mutate('run', { scenario: 's' });
    const dispatch = runSelfImproveMock.mock.calls[0]![0].dispatch;
    await dispatch({ gateway: 'query', domain: 'tasks', operation: 'show', params: { id: 'T1' } });

    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const req = dispatchMock.mock.calls[0]![0];
    expect(req).toMatchObject({
      gateway: 'query',
      domain: 'tasks',
      operation: 'show',
      params: { id: 'T1' },
      source: 'rpc',
    });
    expect(typeof req.requestId).toBe('string');
  });
});

describe('selfimprove OperationDef SSoT (T11889-D)', () => {
  it('registers selfimprove as a canonical domain', () => {
    expect(CANONICAL_DOMAINS).toContain('selfimprove');
  });

  it('exposes selfimprove.run with requiredParams:[scenario]', () => {
    const op = OPERATIONS.find((o) => o.domain === 'selfimprove' && o.operation === 'run');
    expect(op).toBeDefined();
    expect(op?.gateway).toBe('mutate');
    expect(op?.idempotent).toBe(false);
    expect(op?.sessionRequired).toBe(true);
    expect(op?.requiredParams).toEqual(['scenario']);
    expect(op?.params?.map((p) => p.name)).toEqual(['scenario', 'execute', 'dryRun', 'backend']);
  });
});
