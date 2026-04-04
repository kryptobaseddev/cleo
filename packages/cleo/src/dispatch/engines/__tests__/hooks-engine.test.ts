import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getProvidersByHookEventMock, getCommonHookEventsMock } = vi.hoisted(() => ({
  getProvidersByHookEventMock: vi.fn(),
  getCommonHookEventsMock: vi.fn(),
}));

vi.mock('@cleocode/caamp', () => ({
  getProvidersByHookEvent: getProvidersByHookEventMock,
  getCommonHookEvents: getCommonHookEventsMock,
}));

import { queryCommonHooks, queryHookProviders } from '../hooks-engine.js';

describe('hooks engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty provider list for CLEO-local hook events', async () => {
    const result = await queryHookProviders('onPatrol');

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      event: 'onPatrol',
      providers: [],
    });
    expect(getProvidersByHookEventMock).not.toHaveBeenCalled();
  });

  it('queries CAAMP for provider-backed hook events', async () => {
    getProvidersByHookEventMock.mockReturnValue([
      {
        id: 'claude-code',
        name: 'Claude Code',
        capabilities: { hooks: { supported: ['PreToolUse', 'PostToolUse'] } },
      },
    ]);

    const result = await queryHookProviders('PreToolUse');

    expect(result.success).toBe(true);
    expect(getProvidersByHookEventMock).toHaveBeenCalledWith('PreToolUse');
    expect(result.data).toEqual({
      event: 'PreToolUse',
      providers: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          supportedHooks: ['PreToolUse', 'PostToolUse'],
        },
      ],
    });
  });

  it('returns common CAAMP hook events', async () => {
    getCommonHookEventsMock.mockReturnValue(['SessionStart', 'SessionEnd']);

    const result = await queryCommonHooks(['claude-code']);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      providerIds: ['claude-code'],
      commonEvents: ['SessionStart', 'SessionEnd'],
    });
  });
});
