/** Active CLI regressions for exact memory type and explicit historical retrieval. */
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatch, error } = vi.hoisted(() => ({
  dispatch: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
}));
vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchFromCli: dispatch,
  dispatchRaw: vi.fn(),
  handleRawError: vi.fn(),
}));
vi.mock('../../renderers/index.js', () => ({ cliOutput: vi.fn(), cliError: error }));

import { memoryCommand } from '../memory.js';

const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  process.exitCode = originalExitCode;
});

describe('memory find authority filters', () => {
  it('dispatches only decisions for --type decision', async () => {
    await runCommand(memoryCommand, { rawArgs: ['find', 'rush', '--type', 'decision'] });
    expect(dispatch).toHaveBeenCalledWith(
      'query',
      'memory',
      'find',
      expect.objectContaining({ tables: ['decisions'] }),
      expect.any(Object),
    );
  });
  it('forwards explicit historical access without broadening the type', async () => {
    await runCommand(memoryCommand, {
      rawArgs: ['find', 'rush', '--type', 'decision', '--history'],
    });
    expect(dispatch).toHaveBeenCalledWith(
      'query',
      'memory',
      'find',
      expect.objectContaining({ tables: ['decisions'], includeHistory: true }),
      expect.any(Object),
    );
  });
  it('rejects unsupported type values before dispatch', async () => {
    await runCommand(memoryCommand, { rawArgs: ['find', 'rush', '--type', 'decison'] });
    expect(dispatch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Unknown memory type'),
      'E_VALIDATION',
      expect.any(Object),
    );
    expect(process.exitCode).toBe(1);
  });
  it('rejects decision filtering combined with observation-only agent provenance', async () => {
    await runCommand(memoryCommand, {
      rawArgs: ['find', 'rush', '--type', 'decision', '--agent', 'coder'],
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('--agent'),
      'E_VALIDATION',
      expect.any(Object),
    );
  });
});
