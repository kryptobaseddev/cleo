/**
 * Unit tests for `cleo llm cost <session-id>` (T9274 AC #3 backfill).
 *
 * Verifies:
 *   1. costCommand exists and is wired into the llm subCommands map.
 *   2. Empty session → success envelope with totalUsd=0, recordCount=0.
 *   3. Records present → correct cost summation via computeCost.
 *   4. "current" shorthand resolves CLEO_SESSION_ID.
 *   5. breakdown is sorted by createdAt ascending.
 *
 * The token_usage query (listTokenUsage) is mocked to avoid real DB access.
 * The computeCost call is exercised through the real llm-cost.ts code path —
 * expected totals below are computed from the PRICING_SNAPSHOT at 2026-05-13
 * rates (claude-sonnet-4-6-20251001: $3/M input, $15/M output).
 *
 * @task T9274
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared BEFORE dynamic imports so vitest replaces the module
// before the command module binds its lazy imports.
// ---------------------------------------------------------------------------

const mockListTokenUsage = vi.fn();

vi.mock('@cleocode/core/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/core/internal')>();
  return {
    ...actual,
    listTokenUsage: (...args: unknown[]) => mockListTokenUsage(...args),
    // getProjectRoot is statically imported by llm-cost.ts — stub it so the
    // handler does not try to walk the real filesystem.
    getProjectRoot: () => '/fake/project/root',
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import type { CommandDef } from 'citty';
import { llmCommand } from '../commands/llm.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve and return the `subCommands` map from `llmCommand`.
 */
async function getLlmSubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof llmCommand.subCommands === 'function'
      ? await llmCommand.subCommands()
      : llmCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

/**
 * Run a citty subcommand with the given args, capturing stdout output.
 *
 * Patches `process.stdout.write` and `process.exit` to intercept output
 * without side effects. Restores both in the finally block.
 */
async function runSubCapture(
  cmd: CommandDef,
  args: Record<string, unknown>,
): Promise<{ stdout: string; exitCode: number | undefined }> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('Subcommand has no run function');

  const chunks: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: unknown) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;

  let exitCode: number | undefined;
  const origExit = process.exit;
  // process.exit typing requires `never`; we cast to any here only in the test harness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  };

  try {
    await runFn({ args, rawArgs: [], cmd: resolved });
  } catch (err) {
    // Only re-throw if it's not the fake process.exit we injected above.
    if (!(err instanceof Error && err.message.startsWith('process.exit('))) {
      throw err;
    }
  } finally {
    process.stdout.write = origWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).exit = origExit;
  }

  return { stdout: chunks.join(''), exitCode };
}

/** Minimal token_usage row shape expected by loadSessionCostBreakdown. */
interface FakeUsageRow {
  id: string;
  provider: string;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  createdAt: string;
  transport: string;
  method: string;
  confidence: string;
  gateway: null;
  domain: null;
  operation: null;
  sessionId: string;
  taskId: null;
  requestId: null;
  inputChars: number;
  outputChars: number;
  requestHash: null;
  responseHash: null;
  metadataJson: string;
}

function makeRow(
  overrides: Partial<FakeUsageRow> &
    Pick<FakeUsageRow, 'id' | 'inputTokens' | 'outputTokens' | 'createdAt'>,
): FakeUsageRow {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6-20251001',
    totalTokens: overrides.inputTokens + overrides.outputTokens,
    transport: 'agent',
    method: 'heuristic',
    confidence: 'coarse',
    gateway: null,
    domain: null,
    operation: null,
    sessionId: 'sess_test',
    taskId: null,
    requestId: null,
    inputChars: 0,
    outputChars: 0,
    requestHash: null,
    responseHash: null,
    metadataJson: '{}',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleo llm cost — CLI wiring (T9274)', () => {
  beforeEach(() => {
    mockListTokenUsage.mockReset();
    // Default: empty result set.
    mockListTokenUsage.mockResolvedValue({ records: [], total: 0, filtered: 0 });
  });

  afterEach(() => {
    delete process.env['CLEO_SESSION_ID'];
  });

  it('exposes "cost" in the llm subCommands map', async () => {
    const subs = await getLlmSubs();
    expect('cost' in subs, '"cost" must be a key in llm subCommands').toBe(true);
  });

  it('empty session → success envelope with totalUsd=0 and recordCount=0', async () => {
    const subs = await getLlmSubs();
    const { stdout, exitCode } = await runSubCapture(subs['cost']!, {
      sessionId: 'sess_empty',
    });

    expect(exitCode, 'should not exit abnormally').toBeUndefined();
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(envelope['success']).toBe(true);
    const data = envelope['result'] as Record<string, unknown>;
    expect(data['totalUsd']).toBe(0);
    expect(data['recordCount']).toBe(0);
    expect(Array.isArray(data['breakdown'])).toBe(true);
    expect((data['breakdown'] as unknown[]).length).toBe(0);
    // Should include the informational note.
    expect(typeof data['note']).toBe('string');
    expect((data['note'] as string).length).toBeGreaterThan(0);
  });

  it('records present → sums cost correctly, no note field', async () => {
    // claude-sonnet-4-6-20251001: $3/M input, $15/M output (snapshot 2026-05-13)
    // row-1: 1000 input + 500 output = (1000/1M)*3 + (500/1M)*15 = 0.000003 + 0.0000075 = 0.0000105
    // row-2: 2000 input + 1000 output = (2000/1M)*3 + (1000/1M)*15 = 0.000006 + 0.000015 = 0.000021
    // total = 0.0000315
    mockListTokenUsage.mockResolvedValue({
      records: [
        makeRow({
          id: 'row-1',
          inputTokens: 1_000,
          outputTokens: 500,
          createdAt: '2026-05-14T01:00:00.000Z',
        }),
        makeRow({
          id: 'row-2',
          inputTokens: 2_000,
          outputTokens: 1_000,
          createdAt: '2026-05-14T02:00:00.000Z',
        }),
      ],
      total: 2,
      filtered: 2,
    });

    const subs = await getLlmSubs();
    const { stdout, exitCode } = await runSubCapture(subs['cost']!, {
      sessionId: 'sess_real',
    });

    expect(exitCode, 'should not exit abnormally').toBeUndefined();
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(envelope['success']).toBe(true);
    const data = envelope['result'] as Record<string, unknown>;
    expect(data['sessionId']).toBe('sess_real');
    expect(data['recordCount']).toBe(2);
    const breakdown = data['breakdown'] as Array<Record<string, unknown>>;
    expect(breakdown.length).toBe(2);

    // Total cost should be positive and non-zero.
    const totalUsd = data['totalUsd'] as number;
    expect(totalUsd).toBeGreaterThan(0);
    // Approximate sanity check: ~$0.0000315 for 3k input + 1.5k output tokens at sonnet rates.
    expect(totalUsd).toBeCloseTo(0.0000315, 8);

    // No note when records exist.
    expect(data['note']).toBeUndefined();
  });

  it('"current" resolves CLEO_SESSION_ID env var', async () => {
    process.env['CLEO_SESSION_ID'] = 'sess_env_123';

    const subs = await getLlmSubs();
    await runSubCapture(subs['cost']!, { sessionId: 'current' });

    expect(mockListTokenUsage).toHaveBeenCalledWith(
      '/fake/project/root',
      expect.objectContaining({ sessionId: 'sess_env_123' }),
    );
  });

  it('"current" without CLEO_SESSION_ID falls back to "current" literal', async () => {
    delete process.env['CLEO_SESSION_ID'];

    const subs = await getLlmSubs();
    await runSubCapture(subs['cost']!, { sessionId: 'current' });

    expect(mockListTokenUsage).toHaveBeenCalledWith(
      '/fake/project/root',
      expect.objectContaining({ sessionId: 'current' }),
    );
  });

  it('breakdown is sorted by createdAt ascending', async () => {
    // row-b has a later timestamp but is listed first in the mock result —
    // the handler must sort ascending before emitting.
    mockListTokenUsage.mockResolvedValue({
      records: [
        makeRow({
          id: 'row-b',
          inputTokens: 100,
          outputTokens: 50,
          createdAt: '2026-05-14T02:00:00.000Z',
        }),
        makeRow({
          id: 'row-a',
          inputTokens: 200,
          outputTokens: 100,
          createdAt: '2026-05-14T01:00:00.000Z',
        }),
      ],
      total: 2,
      filtered: 2,
    });

    const subs = await getLlmSubs();
    const { stdout } = await runSubCapture(subs['cost']!, { sessionId: 'sess_sort' });
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;
    const breakdown = (envelope['result'] as Record<string, unknown>)['breakdown'] as Array<
      Record<string, unknown>
    >;

    // Earlier timestamp must come first.
    expect(breakdown[0]?.['id']).toBe('row-a');
    expect(breakdown[1]?.['id']).toBe('row-b');
  });

  it('passes projectRoot from getProjectRoot to listTokenUsage', async () => {
    const subs = await getLlmSubs();
    await runSubCapture(subs['cost']!, { sessionId: 'sess_proj' });

    // The mock getProjectRoot returns '/fake/project/root'.
    expect(mockListTokenUsage).toHaveBeenCalledWith('/fake/project/root', expect.anything());
  });
});
