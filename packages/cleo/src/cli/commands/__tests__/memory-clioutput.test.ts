/**
 * Snapshot + wiring tests for the cliOutput migration of memory.ts (T1721).
 *
 * Commands covered (the ones that previously used raw console.log):
 *   1. cleo memory consolidate   — replaces isJson branch with cliOutput
 *   2. cleo memory dream         — replaces isJson branch with cliOutput
 *   3. cleo memory reflect       — replaces isJson branch with cliOutput
 *   4. cleo memory dedup-scan    — replaces isJson branch with cliOutput
 *   5. cleo memory import        — replaces isJson branch with cliOutput
 *   6. cleo memory tier stats    — replaces isJson branch with cliOutput
 *   7. cleo memory tier promote  — replaces isJson branch with cliOutput
 *   8. cleo memory tier demote   — replaces isJson branch with cliOutput
 *   9. cleo memory store         — cliError for unknown type
 *
 * @task T1721
 * @epic T1691
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared BEFORE importing the command under test.
// ---------------------------------------------------------------------------

const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
const mockDispatchFromCli = vi.fn().mockResolvedValue(undefined);
const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();
const mockRunConsolidation = vi.fn();
const mockTriggerManualDream = vi.fn();
const mockGetBrainDb = vi.fn();
const mockGetBrainNativeDb = vi.fn();
const mockRunObserver = vi.fn();
const mockRunReflector = vi.fn();

vi.mock('../../../cli/renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: (...args: unknown[]) => mockDispatchFromCli(...args),
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
}));

vi.mock('@cleocode/core/internal', () => ({
  getProjectRoot: () => '/mock/project',
  runConsolidation: (...args: unknown[]) => mockRunConsolidation(...args),
  triggerManualDream: (...args: unknown[]) => mockTriggerManualDream(...args),
  getBrainDb: (...args: unknown[]) => mockGetBrainDb(...args),
  getBrainNativeDb: (...args: unknown[]) => mockGetBrainNativeDb(...args),
  runObserver: (...args: unknown[]) => mockRunObserver(...args),
  runReflector: (...args: unknown[]) => mockRunReflector(...args),
}));

import type { CommandDef } from 'citty';
import { memoryCommand } from '../memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getMemorySubs(): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof memoryCommand.subCommands === 'function'
      ? await memoryCommand.subCommands()
      : memoryCommand.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

async function getNestedSubs(parent: CommandDef): Promise<Record<string, CommandDef>> {
  const resolved =
    typeof parent.subCommands === 'function' ? await parent.subCommands() : parent.subCommands;
  return (resolved ?? {}) as Record<string, CommandDef>;
}

async function runSub(cmd: CommandDef, args: Record<string, unknown>): Promise<void> {
  const resolved = typeof cmd === 'function' ? await cmd() : cmd;
  const runFn = (resolved as { run?: (ctx: unknown) => Promise<void> }).run;
  if (!runFn) throw new Error('Subcommand has no run function');
  await runFn({ args, rawArgs: [], cmd: resolved });
}

// ---------------------------------------------------------------------------
// 1. consolidate — cliOutput shape
// ---------------------------------------------------------------------------

describe('cleo memory consolidate — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliOutput with consolidation result on success', async () => {
    const mockResult = {
      deduplicated: 3,
      qualityRecomputed: 10,
      tierPromotions: { promoted: [], evicted: [] },
      contradictions: 0,
      softEvicted: 0,
      edgesStrengthened: 5,
      summariesGenerated: 2,
    };
    mockRunConsolidation.mockResolvedValueOnce(mockResult);

    const subs = await getMemorySubs();
    await runSub(subs['consolidate']!, {});

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data, opts] = mockCliOutput.mock.calls[0]!;
    expect(data).toEqual(mockResult);
    expect((opts as Record<string, string>).operation).toBe('memory.consolidate');
    expect((opts as Record<string, string>).command).toBe('memory-consolidate');
  });

  it('calls cliError on consolidation failure', async () => {
    mockRunConsolidation.mockRejectedValueOnce(new Error('db locked'));

    const subs = await getMemorySubs();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(subs['consolidate']!, {});

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('db locked');

    exitSpy.mockRestore();
  });

  it('consolidate command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const resolved =
      typeof subs['consolidate'] === 'function' ? await subs['consolidate']() : subs['consolidate'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });
});

// ---------------------------------------------------------------------------
// 2. dream — cliOutput shape
// ---------------------------------------------------------------------------

describe('cleo memory dream — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliOutput with dream result on success', async () => {
    const mockResult = {
      deduplicated: 1,
      qualityRecomputed: 5,
      tierPromotions: { promoted: [], evicted: [] },
      contradictions: 0,
      softEvicted: 0,
      edgesStrengthened: 2,
      summariesGenerated: 1,
    };
    mockTriggerManualDream.mockResolvedValueOnce(mockResult);

    const subs = await getMemorySubs();
    await runSub(subs['dream']!, {});

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data, opts] = mockCliOutput.mock.calls[0]!;
    expect(data).toEqual(mockResult);
    expect((opts as Record<string, string>).operation).toBe('memory.dream');
    expect((opts as Record<string, string>).command).toBe('memory-dream');
  });

  it('calls cliError on dream failure', async () => {
    mockTriggerManualDream.mockRejectedValueOnce(new Error('STDP failed'));

    const subs = await getMemorySubs();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(subs['dream']!, {});

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('STDP failed');

    exitSpy.mockRestore();
  });

  it('dream command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const resolved = typeof subs['dream'] === 'function' ? await subs['dream']() : subs['dream'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });
});

// ---------------------------------------------------------------------------
// 3. reflect — args check (no --json)
// ---------------------------------------------------------------------------

describe('cleo memory reflect — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reflect command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const resolved =
      typeof subs['reflect'] === 'function' ? await subs['reflect']() : subs['reflect'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });

  it('reflect command still accepts --session', async () => {
    const subs = await getMemorySubs();
    const resolved =
      typeof subs['reflect'] === 'function' ? await subs['reflect']() : subs['reflect'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).toHaveProperty('session');
  });

  it('calls cliOutput with observer + reflector data on success', async () => {
    mockRunObserver.mockResolvedValueOnce({ ran: true, stored: 2, compressedIds: ['O-1'] });
    mockRunReflector.mockResolvedValueOnce({
      ran: true,
      patternsStored: 1,
      learningsStored: 1,
      supersededIds: [],
    });

    const subs = await getMemorySubs();
    await runSub(subs['reflect']!, {});

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data, opts] = mockCliOutput.mock.calls[0]!;
    const typedData = data as { observer: { ran: boolean }; reflector: { ran: boolean } };
    expect(typedData.observer.ran).toBe(true);
    expect(typedData.reflector.ran).toBe(true);
    expect((opts as Record<string, string>).operation).toBe('memory.reflect');
  });
});

// ---------------------------------------------------------------------------
// 4. dedup-scan — cliOutput shape
// ---------------------------------------------------------------------------

describe('cleo memory dedup-scan — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetBrainDb.mockResolvedValue(undefined);
  });

  it('calls cliError when brain.db unavailable', async () => {
    mockGetBrainNativeDb.mockReturnValueOnce(null);

    const subs = await getMemorySubs();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(subs['dedup-scan']!, {});

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('brain.db');

    exitSpy.mockRestore();
  });

  it('dedup-scan command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const resolved =
      typeof subs['dedup-scan'] === 'function' ? await subs['dedup-scan']() : subs['dedup-scan'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });

  it('calls cliOutput with groups and totalDuplicateRows on success', async () => {
    const mockNativeDb = {
      prepare: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
      }),
    };
    mockGetBrainNativeDb.mockReturnValueOnce(mockNativeDb);

    const subs = await getMemorySubs();
    await runSub(subs['dedup-scan']!, {});

    expect(mockCliOutput).toHaveBeenCalledOnce();
    const [data, opts] = mockCliOutput.mock.calls[0]!;
    const typedData = data as { totalDuplicateRows: number; groups: unknown[]; applied: boolean };
    expect(typedData).toHaveProperty('totalDuplicateRows');
    expect(typedData).toHaveProperty('groups');
    expect(typedData.applied).toBe(false);
    expect((opts as Record<string, string>).operation).toBe('memory.dedup-scan');
  });
});

// ---------------------------------------------------------------------------
// 5. import — cliError for missing dir
// ---------------------------------------------------------------------------

describe('cleo memory import — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliError when source directory not found', async () => {
    const subs = await getMemorySubs();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(subs['import']!, { from: '/nonexistent/path/xyz' });

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg, code] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('Source directory not found');
    expect(String(code)).toBe('E_NOT_FOUND');

    exitSpy.mockRestore();
  });

  it('import command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const resolved = typeof subs['import'] === 'function' ? await subs['import']() : subs['import'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });
});

// ---------------------------------------------------------------------------
// 6. tier stats — no --json flag
// ---------------------------------------------------------------------------

describe('cleo memory tier stats — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tier stats command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const tierSub = subs['tier'] as CommandDef;
    const nested = await getNestedSubs(tierSub);
    const resolved =
      typeof nested['stats'] === 'function' ? await nested['stats']() : nested['stats'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });
});

// ---------------------------------------------------------------------------
// 7. tier promote — cliError for invalid tier
// ---------------------------------------------------------------------------

describe('cleo memory tier promote — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliError for invalid tier (validation error)', async () => {
    const subs = await getMemorySubs();
    const tierSub = subs['tier'] as CommandDef;
    const nested = await getNestedSubs(tierSub);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(nested['promote']!, { id: 'O-1', to: 'invalid-tier', reason: 'test' });

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg, code] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('Invalid target tier');
    expect(String(code)).toBe('E_VALIDATION');

    exitSpy.mockRestore();
  });

  it('tier promote command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const tierSub = subs['tier'] as CommandDef;
    const nested = await getNestedSubs(tierSub);
    const resolved =
      typeof nested['promote'] === 'function' ? await nested['promote']() : nested['promote'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });
});

// ---------------------------------------------------------------------------
// 8. tier demote — cliError for invalid tier
// ---------------------------------------------------------------------------

describe('cleo memory tier demote — cliOutput migration (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliError for invalid demote tier (validation error)', async () => {
    const subs = await getMemorySubs();
    const tierSub = subs['tier'] as CommandDef;
    const nested = await getNestedSubs(tierSub);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(nested['demote']!, { id: 'O-1', to: 'invalid-tier', reason: 'test' });

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg, code] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('Invalid target tier for demotion');
    expect(String(code)).toBe('E_VALIDATION');

    exitSpy.mockRestore();
  });

  it('tier demote command no longer accepts --json flag (removed per T1721)', async () => {
    const subs = await getMemorySubs();
    const tierSub = subs['tier'] as CommandDef;
    const nested = await getNestedSubs(tierSub);
    const resolved =
      typeof nested['demote'] === 'function' ? await nested['demote']() : nested['demote'];
    const cmdDef = resolved as { args?: Record<string, unknown> };
    expect(cmdDef.args).not.toHaveProperty('json');
  });
});

// ---------------------------------------------------------------------------
// 9. store command — cliError for unknown type
// ---------------------------------------------------------------------------

describe('cleo memory store — cliError for unknown type (T1721)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls cliError when memory type is not pattern or learning', async () => {
    const subs = await getMemorySubs();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await runSub(subs['store']!, { type: 'unknown-type', content: 'test content' });

    expect(mockCliError).toHaveBeenCalledOnce();
    const [msg, code] = mockCliError.mock.calls[0]!;
    expect(String(msg)).toContain('Unknown memory type');
    expect(String(code)).toBe('E_VALIDATION');

    exitSpy.mockRestore();
  });
});
