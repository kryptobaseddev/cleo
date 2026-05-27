/**
 * Tests that `cleo find --urgent` forwards the urgent param through the
 * dispatch boundary (T9905).
 *
 * The CLI layer is intentionally thin — it should normalise the flag and
 * include it in the wire payload, never filter locally.
 *
 * @task T9905
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDispatchRaw = vi.fn();
const mockHandleRawError = vi.fn();
const mockCliOutput = vi.fn();

vi.mock('../../../dispatch/adapters/cli.js', () => ({
  dispatchRaw: (...args: unknown[]) => mockDispatchRaw(...args),
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

describe('cleo find --urgent (T9905)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchRaw.mockResolvedValue({
      success: true,
      data: { results: [{ id: 'T-CRIT' }], total: 1 },
    });
  });

  it('declares an --urgent boolean arg', () => {
    expect(findCommand.args).toBeDefined();
    const args = findCommand.args as Record<string, { type: string; description?: string }>;
    expect(args['urgent']).toBeDefined();
    expect(args['urgent']!.type).toBe('boolean');
    // Description must mention both axes so `--help` documents the dual-axis surface.
    expect(args['urgent']!.description).toMatch(/priority/i);
    expect(args['urgent']!.description).toMatch(/severity/i);
  });

  it('forwards --urgent=true to the dispatch boundary', async () => {
    // Citty's run signature for our tests — invoke with a synthetic args object.
    await findCommand.run!({
      args: { urgent: true, _: [] } as unknown as Record<string, unknown>,
      rawArgs: [],
      cmd: findCommand,
    } as unknown as Parameters<NonNullable<typeof findCommand.run>>[0]);

    expect(mockDispatchRaw).toHaveBeenCalled();
    const dispatchedParams = mockDispatchRaw.mock.calls[0]![3] as Record<string, unknown>;
    expect(dispatchedParams['urgent']).toBe(true);
  });

  it('omits urgent from dispatch params when flag is absent', async () => {
    await findCommand.run!({
      args: { query: 'something', _: [] } as unknown as Record<string, unknown>,
      rawArgs: [],
      cmd: findCommand,
    } as unknown as Parameters<NonNullable<typeof findCommand.run>>[0]);

    expect(mockDispatchRaw).toHaveBeenCalled();
    const dispatchedParams = mockDispatchRaw.mock.calls[0]![3] as Record<string, unknown>;
    expect('urgent' in dispatchedParams).toBe(false);
  });
});
