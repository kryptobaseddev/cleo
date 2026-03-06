import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getProvidersByHookEventMock,
  getCommonHookEventsMock,
} = vi.hoisted(() => ({
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
        capabilities: { hooks: { supported: ['onToolStart', 'onToolComplete'] } },
      },
    ]);

    const result = await queryHookProviders('onToolStart');

    expect(result.success).toBe(true);
    expect(getProvidersByHookEventMock).toHaveBeenCalledWith('onToolStart');
    expect(result.data).toEqual({
      event: 'onToolStart',
      providers: [
        {
          id: 'claude-code',
          name: 'Claude Code',
          supportedHooks: ['onToolStart', 'onToolComplete'],
        },
      ],
    });
  });

  it('returns common CAAMP hook events', async () => {
    getCommonHookEventsMock.mockReturnValue(['onSessionStart', 'onSessionEnd']);

    const result = await queryCommonHooks(['claude-code']);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      providerIds: ['claude-code'],
      commonEvents: ['onSessionStart', 'onSessionEnd'],
    });
  });
});
