/**
 * Tests that `cleo find --label <name>` forwards the label param through
 * the dispatch boundary (T9904).
 *
 * Mirrors the structure of {@link ./find-urgent-flag.test.ts}.
 *
 * @task T9904
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();
const mockCliOutput = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
  maybeEmitDescribe: () => false,
  handleRawError: (...args: unknown[]) => mockHandleRawError(...args),
  dispatchFromCli: vi.fn(),
}));

vi.mock('../../renderers/index.js', () => ({
  cliOutput: (...args: unknown[]) => mockCliOutput(...args),
  cliError: vi.fn(),
  humanInfo: vi.fn(),
  humanWarn: vi.fn(),
}));

vi.mock('@cleocode/core', async () => {
  const actual = await vi.importActual<typeof import('@cleocode/core')>('@cleocode/core');
  return {
    ...actual,
    createPage: vi.fn(() => undefined),
  };
});

import { findCommand } from '../find.js';

describe('cleo find --label (T9904)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { results: [{ id: 'T-BUG' }], total: 1 },
    });
  });

  it('declares a --label string arg', () => {
    expect(findCommand.args).toBeDefined();
    const args = findCommand.args as Record<string, { type: string; description?: string }>;
    expect(args['label']).toBeDefined();
    expect(args['label']!.type).toBe('string');
    expect(args['label']!.description).toMatch(/label/i);
  });

  it('forwards --label=<name> to the dispatch boundary', async () => {
    await findCommand.run!({
      args: { label: 'bug', _: [] } as unknown as Record<string, unknown>,
      rawArgs: [],
      cmd: findCommand,
    } as unknown as Parameters<NonNullable<typeof findCommand.run>>[0]);

    expect(mockDispatchRaw).toHaveBeenCalled();
    const dispatchedParams = mockDispatchRaw.mock.calls[0]![3] as Record<string, unknown>;
    expect(dispatchedParams['label']).toBe('bug');
  });

  it('omits label from dispatch params when flag is absent', async () => {
    await findCommand.run!({
      args: { query: 'something', _: [] } as unknown as Record<string, unknown>,
      rawArgs: [],
      cmd: findCommand,
    } as unknown as Parameters<NonNullable<typeof findCommand.run>>[0]);

    expect(mockDispatchRaw).toHaveBeenCalled();
    const dispatchedParams = mockDispatchRaw.mock.calls[0]![3] as Record<string, unknown>;
    expect('label' in dispatchedParams).toBe(false);
  });
});
