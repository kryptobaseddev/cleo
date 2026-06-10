/**
 * Unit tests for the inline OAuth path of the `llm` wizard section (T11727).
 *
 * Asserts that the legacy "OAuth login deferred to 'cleo llm login …'" message
 * is GONE (AC1), and that the OAuth path now runs the inline onboarding engine
 * via the injected front-door orchestrator. When no acquirer is wired the path
 * points the user at `cleo login` rather than printing the dead deferral.
 *
 * @task T11727
 * @epic T11671
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { OnboardingResult } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — keep the section off the real pool / config / catalog.
// ---------------------------------------------------------------------------

vi.mock('../../../config.js', () => ({
  setConfigValue: vi.fn(async () => undefined),
}));

vi.mock('../../../llm/credential-pool.js', () => ({
  getCredentialPool: () => ({ list: async () => [] }),
}));

vi.mock('../../../llm/credentials-store.js', () => ({
  addCredential: vi.fn(async () => undefined),
}));

import { StubWizardIO } from '../../wizard.js';
import { createLlmSection } from '../llm.js';

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
  modelId: 'claude-test',
  profileName: 'default',
  validated: true,
};

describe('llm wizard section — inline OAuth (T11727)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC1 — the legacy "OAuth login deferred" string is gone from the source', () => {
    const src = readFileSync(fileURLToPath(new URL('../llm.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('OAuth login deferred');
  });

  it('AC1 — OAuth path runs the inline onboarding engine when an acquirer is wired', async () => {
    const acquirer = vi.fn(async () => ({ label: 'oauth-login' }));
    const frontDoor = vi.fn(async (): Promise<OnboardingResult> => VALIDATED);
    const section = createLlmSection({
      oauthAcquirer: acquirer,
      runFrontDoorLogin: frontDoor,
    });

    // provider select → 'anthropic', auth select → 'oauth_login'.
    const io = new StubWizardIO({ selects: ['anthropic', 'oauth_login'] });
    const result = await section.run(io, {});

    expect(frontDoor).toHaveBeenCalledTimes(1);
    const [provider, opts] = frontDoor.mock.calls[0] as [string, { authMode?: string }];
    expect(provider).toBe('anthropic');
    expect(opts.authMode).toBe('oauth');
    expect(result.changed).toBe(true);
    expect(result.summary).toMatch(/oauth login complete/);
    // The info line reflects a completed login, never a deferral.
    expect(io.infos.join('\n')).not.toContain('deferred');
  });

  it('OAuth path points at `cleo login` when no acquirer is available', async () => {
    const frontDoor = vi.fn(async (): Promise<OnboardingResult> => VALIDATED);
    const section = createLlmSection({ runFrontDoorLogin: frontDoor });
    const io = new StubWizardIO({ selects: ['anthropic', 'oauth_login'] });
    const result = await section.run(io, {});

    expect(frontDoor).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(io.infos.join('\n')).toContain('cleo login');
  });
});
