/**
 * Tests for Anthropic OAuth client ID resolution in the builtin provider profile.
 *
 * Verifies:
 *   1. `CLEO_ANTHROPIC_OAUTH_CLIENT_ID` env var is honored when set.
 *   2. A warning is emitted to stderr when the placeholder is used.
 *   3. `ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER` exports the known placeholder value.
 *
 * Note: `anthropicProfile` is constructed at module load time, so tests must
 * reset the module cache between runs (via `vi.resetModules()`) to exercise
 * different env-var states.
 *
 * @task T9326
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

describe('ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER', () => {
  it('exports the Hermes-sourced placeholder value', async () => {
    delete process.env[ENV_KEY];
    const { ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER } = await loadAnthropicModule();
    expect(ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });
});

describe('anthropicProfile.oauth.clientId — env override', () => {
  it('uses CLEO_ANTHROPIC_OAUTH_CLIENT_ID when set', async () => {
    process.env[ENV_KEY] = 'my-real-client-id';
    const { anthropicProfile } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.clientId).toBe('my-real-client-id');
  });

  it('does NOT emit a stderr warning when env override is set', async () => {
    process.env[ENV_KEY] = 'my-real-client-id';
    await loadAnthropicModule();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

describe('anthropicProfile.oauth.clientId — placeholder fallback', () => {
  it('falls back to the placeholder when env var is absent', async () => {
    delete process.env[ENV_KEY];
    const { anthropicProfile, ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER } = await loadAnthropicModule();
    expect(anthropicProfile.oauth?.clientId).toBe(ANTHROPIC_OAUTH_CLIENT_ID_PLACEHOLDER);
  });

  it('emits a stderr warning that references T9341 when placeholder is used', async () => {
    delete process.env[ENV_KEY];
    await loadAnthropicModule();
    expect(stderrSpy).toHaveBeenCalledOnce();
    const [msg] = stderrSpy.mock.calls[0] as [string];
    expect(msg).toContain('[anthropic-oauth]');
    expect(msg).toContain('CLEO_ANTHROPIC_OAUTH_CLIENT_ID');
    expect(msg).toContain('T9341');
  });
});
