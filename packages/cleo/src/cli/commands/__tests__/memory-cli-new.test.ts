/**
 * Smoke + wiring tests for the 8 new `cleo memory` subcommands (T1013).
 *
 * Commands covered:
 *   1. cleo memory precompact-flush           — T1004 shim-unblocker
 *   2. cleo memory backfill run               — T1003 staged backfill
 *   3. cleo memory backfill approve <runId>   — T1003 approval
 *   4. cleo memory backfill rollback <runId>  — T1003 rollback
 *   5. cleo memory digest                     — T1006 session-briefing digest
 *   6. cleo memory recent                     — T1006 recent observations tail
 *   7. cleo memory diary read / write         — T1006 diary CRUD
 *   8. cleo memory watch                      — T1006 SSE-style long-poll
 *
 * Each test mocks `dispatchFromCli` + `dispatchRaw` so we can assert the
 * correct (gateway, domain, operation, params) tuple is sent. The full
 * dispatch pipeline is covered by dedicated handler tests under
 * `packages/cleo/src/dispatch/domains/__tests__/memory-*.test.ts`.
 *
 * @task T1013
 * @epic T1000
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the command under test so the
// dispatch functions are patched at module-load time.
// ---------------------------------------------------------------------------

const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);
const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { CommandDef } from 'citty';
import { memoryCommand } from '../memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the top-level memory subcommand map. */
async function getMemorySubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof memoryCommand.subCommands === 'function'
      ? await memoryCommand.subCommands()
      : memoryCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

/** Resolve a nested subcommand map (e.g. `backfill.run`). */
async function getNestedSubs(parent: CommandDef): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof parent.subCommands === 'function' ? await parent.subCommands() : parent.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

/** Invoke a subcommand's `run` function with the given args. */
async function runSub(
  cmd: CommandDef,
  args: Record<string, unknown>,
  rawArgs: string[] = [],
): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('Subcommand has no run function');
  await runFn({ args, rawArgs, cmd: resolved });
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('memory CLI — T1013 new subcommands: presence + metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers all 6 new top-level memory subcommands', async () => {
    const subs = await getMemorySubs();
    expect(subs).toHaveProperty('precompact-flush');
    expect(subs).toHaveProperty('backfill');
    expect(subs).toHaveProperty('digest');
    expect(subs).toHaveProperty('recent');
    expect(subs).toHaveProperty('diary');
    expect(subs).toHaveProperty('watch');
  });

  it('preserves all legacy memory subcommands (additive only)', async () => {
    const subs = await getMemorySubs();
    // A representative sample — the full list lives in memory.ts
    for (const legacy of [
      'store',
      'find',
      'stats',
      'observe',
      'timeline',
      'fetch',
      'llm-status',
      'verify',
      'pending-verify',
      'tier',
    ]) {
      expect(subs).toHaveProperty(legacy);
    }
  });

  it('backfill group hosts run / approve / rollback', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);
    expect(nested).toHaveProperty('run');
    expect(nested).toHaveProperty('approve');
    expect(nested).toHaveProperty('rollback');
  });

  it('diary group hosts read / write', async () => {
    const subs = await getMemorySubs();
    const diary = subs['diary'] as CommandDef;
    const nested = await getNestedSubs(diary);
    expect(nested).toHaveProperty('read');
    expect(nested).toHaveProperty('write');
  });
});

// ---------------------------------------------------------------------------
// 1. precompact-flush
// ---------------------------------------------------------------------------

describe('cleo memory precompact-flush (T1004)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('dispatches to mutate memory.precompact-flush with empty params (empty queue case)', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['precompact-flush']!, {});

    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('mutate');
    expect(domain).toBe('memory');
    expect(operation).toBe('precompact-flush');
    expect(params).toEqual({});
  });

  it('dispatches identically regardless of populated/empty queue (thin wrapper)', async () => {
    // Simulate "populated queue" vs "empty queue" — the CLI contract is
    // the same in both cases: it calls the dispatch op with no extra params.
    const subs = await getMemorySubs();

    mockDispatchFromCli.mockResolvedValueOnce(undefined); // populated
    await runSub(subs['precompact-flush']!, {});
    mockDispatchFromCli.mockResolvedValueOnce(undefined); // empty
    await runSub(subs['precompact-flush']!, {});

    expect(mockDispatchFromCli).toHaveBeenCalledTimes(2);
    for (const call of mockDispatchFromCli.mock.calls) {
      expect(call[0]).toBe('mutate');
      expect(call[2]).toBe('precompact-flush');
      expect(call[3]).toEqual({});
    }
  });

  it('passes the canonical command label for output rendering', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['precompact-flush']!, {});

    const outputOpts = mockDispatchFromCli.mock.calls[0]![4] as {
      command: string;
      operation: string;
    };
    expect(outputOpts.command).toBe('memory-precompact-flush');
    expect(outputOpts.operation).toBe('memory.precompact-flush');
  });
});

// ---------------------------------------------------------------------------
// 2. backfill run
// ---------------------------------------------------------------------------

describe('cleo memory backfill run (T1003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('dispatches to mutate memory.backfill.run with --source', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);

    await runSub(nested['run']!, { source: '/tmp/session.jsonl' });

    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, domain, operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('mutate');
    expect(domain).toBe('memory');
    expect(operation).toBe('backfill.run');
    expect(params).toEqual({ source: '/tmp/session.jsonl' });
  });

  it('omits undefined optional args from params', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);

    await runSub(nested['run']!, {});

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({});
    expect(params).not.toHaveProperty('source');
    expect(params).not.toHaveProperty('kind');
    expect(params).not.toHaveProperty('targetTable');
  });

  it('passes kind + target-table through to the dispatch op', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);

    await runSub(nested['run']!, {
      source: 's',
      kind: 'observation-promotion',
      'target-table': 'brain_page_edges',
    });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({
      source: 's',
      kind: 'observation-promotion',
      targetTable: 'brain_page_edges',
    });
  });
});

// ---------------------------------------------------------------------------
// 3. backfill approve
// ---------------------------------------------------------------------------

describe('cleo memory backfill approve (T1003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('dispatches with the positional runId', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);

    await runSub(nested['approve']!, { runId: 'run_abc123' });

    const [gateway, , operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('mutate');
    expect(operation).toBe('backfill.approve');
    expect((params as Record<string, unknown>).runId).toBe('run_abc123');
  });

  it('forwards --approved-by when supplied', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);

    await runSub(nested['approve']!, { runId: 'r1', 'approved-by': 'cleo-prime' });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params.runId).toBe('r1');
    expect(params.approvedBy).toBe('cleo-prime');
  });
});

// ---------------------------------------------------------------------------
// 4. backfill rollback
// ---------------------------------------------------------------------------

describe('cleo memory backfill rollback (T1003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('dispatches rollback with positional runId', async () => {
    const subs = await getMemorySubs();
    const backfill = subs['backfill'] as CommandDef;
    const nested = await getNestedSubs(backfill);

    await runSub(nested['rollback']!, { runId: 'run_xyz789' });

    const [gateway, , operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('mutate');
    expect(operation).toBe('backfill.rollback');
    expect((params as Record<string, unknown>).runId).toBe('run_xyz789');
  });
});

// ---------------------------------------------------------------------------
// 5. digest
// ---------------------------------------------------------------------------

describe('cleo memory digest (T1006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('dispatches to query memory.digest without params when no --limit', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['digest']!, {});

    const [gateway, , operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('query');
    expect(operation).toBe('digest');
    expect(params).toEqual({});
  });

  it('passes --limit as a number', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['digest']!, { limit: '15' });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({ limit: 15 });
    expect(typeof params.limit).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// 6. recent
// ---------------------------------------------------------------------------

describe('cleo memory recent (T1006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('dispatches to query memory.recent', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['recent']!, {});

    const [gateway, , operation] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('query');
    expect(operation).toBe('recent');
  });

  it('forwards --limit, --type, --since, --session, --tier filters', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['recent']!, {
      limit: '50',
      type: 'diary',
      since: '24h',
      session: 'ses_123',
      tier: 'short',
    });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({
      limit: 50,
      type: 'diary',
      since: '24h',
      session: 'ses_123',
      tier: 'short',
    });
  });

  it('omits filters when args are undefined', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['recent']!, { limit: '10' });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({ limit: 10 });
    expect(params).not.toHaveProperty('type');
    expect(params).not.toHaveProperty('since');
  });
});

// ---------------------------------------------------------------------------
// 7. diary read / write
// ---------------------------------------------------------------------------

describe('cleo memory diary (T1006)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  it('diary read dispatches to query memory.diary', async () => {
    const subs = await getMemorySubs();
    const diary = subs['diary'] as CommandDef;
    const nested = await getNestedSubs(diary);

    await runSub(nested['read']!, { limit: '25' });

    const [gateway, , operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('query');
    expect(operation).toBe('diary');
    expect((params as Record<string, unknown>).limit).toBe(25);
  });

  it('diary write dispatches to mutate memory.diary.write with text', async () => {
    const subs = await getMemorySubs();
    const diary = subs['diary'] as CommandDef;
    const nested = await getNestedSubs(diary);

    await runSub(nested['write']!, { text: 'Today I shipped T1013.' });

    const [gateway, , operation, params] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('mutate');
    expect(operation).toBe('diary.write');
    expect((params as Record<string, unknown>).text).toBe('Today I shipped T1013.');
  });

  it('diary write roundtrip: write then read fires dispatches in order', async () => {
    const subs = await getMemorySubs();
    const diary = subs['diary'] as CommandDef;
    const nested = await getNestedSubs(diary);

    await runSub(nested['write']!, { text: 'entry 1' });
    await runSub(nested['read']!, {});

    expect(mockDispatchFromCli).toHaveBeenCalledTimes(2);
    expect(mockDispatchFromCli.mock.calls[0]![2]).toBe('diary.write');
    expect(mockDispatchFromCli.mock.calls[1]![2]).toBe('diary');
  });

  it('diary write forwards optional --title and --agent', async () => {
    const subs = await getMemorySubs();
    const diary = subs['diary'] as CommandDef;
    const nested = await getNestedSubs(diary);

    await runSub(nested['write']!, {
      text: 'entry',
      title: 'my entry',
      agent: 'cleo-prime',
    });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({ text: 'entry', title: 'my entry', agent: 'cleo-prime' });
  });
});

// ---------------------------------------------------------------------------
// 8. watch (non-follow + follow SSE mode)
// ---------------------------------------------------------------------------

describe('cleo memory watch (T1006)', () => {
  const originalWrite = process.stdout.write.bind(process.stdout);
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let writeBuffer: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    writeBuffer = [];
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
      if (typeof chunk === 'string') writeBuffer.push(chunk);
      else if (chunk instanceof Uint8Array) writeBuffer.push(Buffer.from(chunk).toString('utf-8'));
      return true;
    });
    mockDispatchFromCli.mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeSpy.mockRestore();
    // Safety net: restore the real write in case of a misbehaving test
    process.stdout.write = originalWrite;
  });

  it('non-follow mode: single dispatch to query memory.watch', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['watch']!, {});

    expect(mockDispatchFromCli).toHaveBeenCalledOnce();
    const [gateway, , operation] = mockDispatchFromCli.mock.calls[0]!;
    expect(gateway).toBe('query');
    expect(operation).toBe('watch');
    expect(mockDispatchRaw).not.toHaveBeenCalled();
  });

  it('non-follow mode: forwards --cursor and --limit', async () => {
    const subs = await getMemorySubs();
    await runSub(subs['watch']!, { cursor: '2026-04-19 12:00:00', limit: '5' });

    const params = mockDispatchFromCli.mock.calls[0]![3] as Record<string, unknown>;
    expect(params).toEqual({ cursor: '2026-04-19 12:00:00', limit: 5 });
  });

  it('follow mode: opens stream with a ping event then emits observation + close', async () => {
    const subs = await getMemorySubs();

    // First poll returns one event + nextCursor; subsequent polls return empty
    // but we signal shutdown via SIGINT after the first batch writes.
    mockDispatchRaw.mockImplementation(async () => {
      // Schedule SIGINT so the follow loop exits on the next tick
      setImmediate(() => process.emit('SIGINT'));
      return {
        success: true,
        data: {
          events: [
            {
              id: 'O-1',
              text: 'first observation',
              created_at: '2026-04-19 12:00:01',
            },
          ],
          nextCursor: '2026-04-19 12:00:01',
        },
        meta: {
          duration_ms: 1,
          requestId: 'req-1',
          timestamp: '2026-04-19T12:00:00.000Z',
        },
      };
    });

    await runSub(subs['watch']!, { follow: true, interval: '1' });

    const emitted = writeBuffer.join('');
    expect(emitted).toContain('event: ping');
    expect(emitted).toContain('event: observation');
    expect(emitted).toContain('first observation');
    expect(emitted).toContain('event: close');
  });

  it('follow mode: handleRawError is invoked on failed response', async () => {
    const subs = await getMemorySubs();

    mockDispatchRaw.mockResolvedValueOnce({
      success: false,
      error: { code: 'E_DB_UNAVAILABLE', message: 'brain.db is unavailable' },
      meta: { duration_ms: 1, requestId: 'req-err', timestamp: '2026-04-19T12:00:00.000Z' },
    });
    mockHandleRawError.mockImplementation(() => {
      // In real life this calls process.exit — here we just capture the call.
    });

    await runSub(subs['watch']!, { follow: true, interval: '1' });

    expect(mockHandleRawError).toHaveBeenCalledOnce();
    const [resp, ctx] = mockHandleRawError.mock.calls[0]!;
    expect((resp as { success: boolean }).success).toBe(false);
    expect((ctx as { operation: string }).operation).toBe('memory.watch');
  });

  it('follow mode: advances cursor between polls', async () => {
    const subs = await getMemorySubs();

    let call = 0;
    mockDispatchRaw.mockImplementation(async () => {
      call++;
      if (call >= 2) setImmediate(() => process.emit('SIGINT'));
      return {
        success: true,
        data: {
          events: [],
          nextCursor: `cursor-${call}`,
        },
        meta: { duration_ms: 1, requestId: 'req', timestamp: '2026-04-19T12:00:00.000Z' },
      };
    });

    await runSub(subs['watch']!, { follow: true, interval: '1' });

    // Second poll should use cursor-1 (returned by first poll)
    expect(mockDispatchRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
    const secondCallParams = mockDispatchRaw.mock.calls[1]![3] as Record<string, unknown>;
    expect(secondCallParams.cursor).toBe('cursor-1');
  });
});
