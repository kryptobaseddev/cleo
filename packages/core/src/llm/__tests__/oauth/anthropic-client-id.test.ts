/**
 * Tests for Anthropic OAuth client ID resolution in the builtin provider profile.
 *
 * Verifies:
 *   1. `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var is honored when set.
 *   2. The canonical public client_id is used by default (no stderr noise).
 *   3. `ANTHROPIC_OAUTH_CLIENT_ID` exports the documented Hermes-compatible value.
 *   4. The redirect URI points at the Anthropic-hosted callback (paste-back flow),
 *      matching the Hermes / Claude Code PKCE flow.
 *
 * Note: `anthropicProfile` is constructed at module load time, so tests must
 * bust the module cache between runs (via a query-suffixed dynamic import) to
 * exercise different env-var states.
 *
 * @task T9326
 * @task T9344
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENV_KEY = 'CLEO_ANTHROPIC_OAUTH_CLIENT_ID';

async function loadAnthropicModule() {
  const mod = await import(
    '../../provider-registry/builtin/anthropic.js?t=' + Date.now().toString()
  );
  return mod as typeof import('../../provider-registry/builtin/anthropic.js');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let savedEnv: string | undefined;
let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.resetModules();
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ANTHROPIC_OAUTH_CLIENT_ID', () => {
  it('exports the canonical public Anthropic OAuth client_id (matches Hermes)', async () => {
    delete process.env[ENV_KEY];
    const { ANTHROPIC_OAUTH_CLIENT_ID } = await loadAnthropicModule();
    expect(ANTHROPIC_OAUTH_CLIENT_ID).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });
});

describe('anthropicProfile.oauth.clientId — env override', () => {
  it('uses CLEO_ANTHROPIC_OAUTH_CLIENT_ID when set', async () => {
    process.env[ENV_KEY] = 'my-custom-client-id';
    const { anthropicProfile } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.clientId).toBe('my-custom-client-id');
  });

  it('does NOT emit a stderr warning when env override is set', async () => {
    process.env[ENV_KEY] = 'my-custom-client-id';
    await loadAnthropicModule();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('anthropicProfile.oauth.clientId — default (no env var)', () => {
  it('uses the canonical public client_id when env var is absent', async () => {
    delete process.env[ENV_KEY];
    const { anthropicProfile, ANTHROPIC_OAUTH_CLIENT_ID } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.clientId).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
  });

  it('does NOT emit any stderr warning in the default path', async () => {
    delete process.env[ENV_KEY];
    await loadAnthropicModule();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('anthropicProfile.oauth endpoints (T11958 / DHQ-075 regression)', () => {
  it('points the redirect at the platform.claude.com paste-back callback (matches pi-ai)', async () => {
    delete process.env[ENV_KEY];
    const { anthropicProfile } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.redirectUri).toBe(
      'https://platform.claude.com/oauth/code/callback',
    );
  });

  it('exchanges tokens against platform.claude.com — console.anthropic.com is retired', async () => {
    delete process.env[ENV_KEY];
    const { anthropicProfile } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.tokenEndpoint).toBe(
      'https://platform.claude.com/v1/oauth/token',
    );
    // The pre-migration host 400s the exchange (redirect_uri binding mismatch).
    expect(anthropicProfile.oauth?.tokenEndpoint).not.toContain('console.anthropic.com');
    expect(anthropicProfile.oauth?.redirectUri).not.toContain('console.anthropic.com');
  });

  it('authorizes at claude.ai with code=true so the hosted page displays the code', async () => {
    delete process.env[ENV_KEY];
    const { anthropicProfile } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.authorizationEndpoint).toBe('https://claude.ai/oauth/authorize');
    expect(anthropicProfile.oauth?.extraAuthParams).toEqual({ code: 'true' });
  });

  it('uses the JSON token-body format (Anthropic token endpoint is non-RFC)', async () => {
    delete process.env[ENV_KEY];
    const { anthropicProfile } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.tokenBodyFormat).toBe('json');
  });
});
