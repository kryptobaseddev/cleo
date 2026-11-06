/**
 * `cleo memory dream` never runs its destructive cycle by default (T14237).
 *
 * A bare run must refuse, exit non-zero and touch nothing: the dream cycle
 * (`triggerManualDream`) is the command's only writer, and the BRAIN store
 * handle is never opened. `--apply` runs the cycle and `--status` stays a
 * read-only liveness check. The help text names the destructive effects and
 * the flag instead of calling the command safe.
 *
 * @task T14237
 */

import type { CommandDef } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCliOutput = vi.fn();
const mockCliError = vi.fn();
const mockTriggerManualDream = vi.fn();
const mockGetDreamStatus = vi.fn();
const mockGetBrainDb = vi.fn();

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: (...args: unknown[]) => mockCliError(...args),
}));
vi.mock('@cleocode/core/memory/dream-cycle', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  triggerManualDream: (...args: unknown[]) => mockTriggerManualDream(...args),
  getDreamStatus: (...args: unknown[]) => mockGetDreamStatus(...args),
}));
vi.mock('@cleocode/core/store/memory-sqlite', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBrainDb: (...args: unknown[]) => mockGetBrainDb(...args),
}));
vi.mock('@cleocode/core/project-scope', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getProjectRoot: () => '/mock/project',
}));

import { memoryCommand } from '../memory.js';

async function dreamCommand(): Promise<CommandDef> {
  const subs =
    typeof memoryCommand.subCommands === 'function'
      ? await memoryCommand.subCommands()
      : memoryCommand.subCommands;
  const dream = (subs as Record<string, CommandDef | (() => Promise<CommandDef>)>)['dream'];
  if (!dream) throw new Error('dream subcommand missing');
  return typeof dream === 'function' ? await dream() : dream;
}

async function run(args: Record<string, unknown>): Promise<void> {
  const cmd = await dreamCommand();
  await cmd.run?.({ args, rawArgs: [], cmd } as Parameters<NonNullable<CommandDef['run']>>[0]);
}

describe('cleo memory dream refuses by default (T14237)', () => {
  let savedExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.clearAllMocks();
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
  });

  it('a bare run refuses, exits non-zero and leaves the store untouched', async () => {
    await run({});

    expect(mockTriggerManualDream).not.toHaveBeenCalled();
    expect(mockGetBrainDb).not.toHaveBeenCalled();
    expect(mockCliOutput).not.toHaveBeenCalled();
    expect(mockCliError).toHaveBeenCalledOnce();
    const [message, code] = mockCliError.mock.calls[0] ?? [];
    expect(String(message)).toContain('--apply');
    expect(String(message)).toContain('Nothing was run');
    expect(code).toBe('E_VALIDATION');
    expect(process.exitCode).toBe(1);
  });

  it('--apply runs the dream cycle', async () => {
    mockTriggerManualDream.mockResolvedValueOnce({ deduplicated: 0 });
    await run({ apply: true });

    expect(mockTriggerManualDream).toHaveBeenCalledWith('/mock/project');
    expect(mockCliOutput).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('--status stays read-only and never runs the cycle', async () => {
    mockGetDreamStatus.mockResolvedValueOnce({ isOverdue: false });
    await run({ status: true });

    expect(mockGetDreamStatus).toHaveBeenCalledWith('/mock/project');
    expect(mockTriggerManualDream).not.toHaveBeenCalled();
  });

  it('help names the destructive effects and --apply, and no longer calls the command safe', async () => {
    const cmd = await dreamCommand();
    const meta = typeof cmd.meta === 'function' ? await cmd.meta() : cmd.meta;
    const help = (meta as { description?: string } | undefined)?.description ?? '';

    expect(help).toContain('DESTRUCTIVE');
    expect(help).toMatch(/hard-delet/);
    expect(help).toContain('--apply');
    expect(help).not.toMatch(/safe to run/i);
    const args = typeof cmd.args === 'function' ? await cmd.args() : cmd.args;
    expect(args).toHaveProperty('apply');
  });
});
