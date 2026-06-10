/**
 * Unit tests for the shared onboarding front-door orchestrator (T11725 · M3).
 *
 * Exercises provider resolution, auth-method inference, the api_key vs oauth
 * acquisition split, and the unknown-provider deferral — all via the injectable
 * {@link FrontDoorDeps} seam so no real registry / engine / browser is touched.
 *
 * @task T11725
 * @epic T11671
 */

import type { OnboardingResult, ProviderProfile } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { FrontDoorDeps } from '../front-door.js';
import { resolveAuthMode, runFrontDoorLogin } from '../front-door.js';

const VALIDATED: OnboardingResult = {
  steps: [
    { step: 'connect', status: 'ok', detail: 'ok' },
    { step: 'select', status: 'ok', detail: 'ok' },
    { step: 'bind', status: 'ok', detail: 'ok' },
    { step: 'validate', status: 'ok', detail: 'ok' },
  ],
  provider: 'anthropic',
  accountLabel: 'oauth-login',
  authMode: 'oauth',
  modelId: 'm',
  profileName: 'default',
  validated: true,
};

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    name: 'anthropic',
    displayName: 'Anthropic',
    authTypes: ['oauth'],
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'm',
    // Default carries an oauth config so auth-mode inference resolves to 'oauth'.
    oauth: { mode: 'pkce' } as never,
    ...over,
  } as ProviderProfile;
}

function makeDeps(over: Partial<FrontDoorDeps> = {}): {
  deps: FrontDoorDeps;
  engine: ReturnType<typeof vi.fn>;
} {
  const engine = vi.fn(async (): Promise<OnboardingResult> => VALIDATED);
  const deps: FrontDoorDeps = {
    getProviderProfile: vi.fn(async () => profile()),
    runOnboardingLogin: engine,
    ...over,
  };
  return { deps, engine };
}

describe('runFrontDoorLogin (T11725)', () => {
  it('resolveAuthMode: override wins, else oauth when profile has oauth, else api_key', () => {
    expect(resolveAuthMode(profile(), 'api_key')).toBe('api_key');
    expect(resolveAuthMode(profile({ oauth: { mode: 'pkce' } as never }))).toBe('oauth');
    expect(resolveAuthMode(profile({ oauth: undefined }))).toBe('api_key');
  });

  it('api_key path: forwards the raw token to the engine, no acquirer invoked', async () => {
    const { deps, engine } = makeDeps({
      getProviderProfile: vi.fn(async () => profile({ oauth: undefined, authTypes: ['api_key'] })),
    });
    const acquirer = vi.fn();
    await runFrontDoorLogin('anthropic', { token: 'sk-test' }, acquirer, deps);

    expect(acquirer).not.toHaveBeenCalled();
    const [, opts] = engine.mock.calls[0] as [string, { token?: string; authMode?: string }];
    expect(opts.token).toBe('sk-test');
    expect(opts.authMode).toBe('api_key');
    expect(opts.credentialAlreadyStored).toBeUndefined();
  });

  it('oauth path: runs the acquirer (which stores), then the engine skips its connect write', async () => {
    const { deps, engine } = makeDeps();
    const acquirer = vi.fn(async () => ({ label: 'work', expiresIn: 3600 }));
    await runFrontDoorLogin('anthropic', {}, acquirer, deps);

    expect(acquirer).toHaveBeenCalledWith('anthropic');
    const [provider, opts] = engine.mock.calls[0] as [
      string,
      { authMode?: string; credentialAlreadyStored?: boolean; token?: string; label?: string },
    ];
    expect(provider).toBe('anthropic');
    expect(opts.authMode).toBe('oauth');
    expect(opts.credentialAlreadyStored).toBe(true);
    expect(opts.token).toBeUndefined();
    expect(opts.label).toBe('work');
  });

  it('oauth path without an acquirer throws (cannot complete non-interactively)', async () => {
    const { deps } = makeDeps();
    await expect(runFrontDoorLogin('anthropic', {}, undefined, deps)).rejects.toThrow(
      /interactive token acquirer/,
    );
  });

  it('unknown provider: defers to the engine (single source of the failure shape)', async () => {
    const failed: OnboardingResult = { ...VALIDATED, validated: false };
    const engine = vi.fn(async () => failed);
    const deps: FrontDoorDeps = {
      getProviderProfile: vi.fn(async () => undefined),
      runOnboardingLogin: engine,
    };
    const out = await runFrontDoorLogin('bogus', { token: 'k' }, undefined, deps);
    expect(out.validated).toBe(false);
    expect(engine).toHaveBeenCalledWith('bogus', expect.objectContaining({ token: 'k' }));
  });

  it('resolves the canonical provider name from the profile (alias → canonical)', async () => {
    const { deps, engine } = makeDeps({
      getProviderProfile: vi.fn(async () => profile({ name: 'openai', oauth: undefined })),
    });
    await runFrontDoorLogin('codex', { token: 'k' }, undefined, deps);
    const [provider] = engine.mock.calls[0] as [string];
    expect(provider).toBe('openai');
  });
});
