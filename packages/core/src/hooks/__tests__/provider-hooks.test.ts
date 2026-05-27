import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getProvidersByHookEventMock, getCommonHookEventsMock } = vi.hoisted(() => ({
  getProvidersByHookEventMock: vi.fn(),
  getCommonHookEventsMock: vi.fn(),
}));

vi.mock('@cleocode/caamp', () => ({
  getProvidersByHookEvent: getProvidersByHookEventMock,
  getCommonHookEvents: getCommonHookEventsMock,
}));

import { getHookCapableProviders, getSharedHookEvents } from '../provider-hooks.js';

describe('provider hook capability helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns no providers for CLEO-local coordination events', () => {
    const providers = getHookCapableProviders('onWorkAvailable');

    expect(providers).toEqual([]);
    expect(getProvidersByHookEventMock).not.toHaveBeenCalled();
  });

  it('delegates provider-backed hook events to CAAMP', () => {
    getProvidersByHookEventMock.mockReturnValue([{ id: 'claude-code' }, { id: 'opencode' }]);

    const providers = getHookCapableProviders('PreToolUse');

    expect(getProvidersByHookEventMock).toHaveBeenCalledWith('PreToolUse');
    expect(providers).toEqual(['claude-code', 'opencode']);
  });

  it('returns common provider hook events from CAAMP', () => {
    getCommonHookEventsMock.mockReturnValue(['SessionStart', 'PostToolUse']);

    const events = getSharedHookEvents(['claude-code', 'opencode']);

    expect(getCommonHookEventsMock).toHaveBeenCalledWith(['claude-code', 'opencode']);
    expect(events).toEqual(['SessionStart', 'PostToolUse']);
  });
});
