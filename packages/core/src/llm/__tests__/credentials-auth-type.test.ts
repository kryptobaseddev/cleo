/**
 * Tests for `CredentialResult.authType` and the `authHeaders()` helper.
 *
 * Covers Phase 1 of T-LLM-CRED-CENTRALIZATION: every Anthropic call-site needs
 * to send the correct auth scheme. Claude Code OAuth tokens require
 * `Authorization: Bearer …` + `anthropic-beta: oauth-2025-04-20`; API keys
 * require `x-api-key`. Sending the wrong scheme returns 401 from Anthropic.
 *
 * Filesystem isolation mirrors `credentials.test.ts`: a tmpdir XDG home plus
 * env restoration around every test.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authHeaders, clearAnthropicKeyCache, resolveCredentials } from '../credentials.js';

const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MOONSHOT_API_KEY',
  'XDG_DATA_HOME',
  'HOME',
  'CLEO_DIR',
];

function saveEnv(): void {
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
}

function clearEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

/**
 * Point HOME at a tmpdir and seed `~/.claude/.credentials.json` with an
 * OAuth token so tier 3 of the resolver picks it up.
 */
function seedClaudeOauth(accessToken: string): string {
  const home = join(tmpdir(), `cleo-authtype-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken, expiresAt: Date.now() + 60 * 60_000 },
    }),
    'utf-8',
  );
  process.env['HOME'] = home;
  return home;
}

beforeEach(() => {
  saveEnv();
  clearEnv();
  clearAnthropicKeyCache();
  // Isolate XDG so global config tier never reads developer credentials.
  process.env['XDG_DATA_HOME'] = join(
    tmpdir(),
    `cleo-authtype-xdg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  // Point HOME at an empty tmpdir so tier 3 (`~/.claude/.credentials.json`)
  // cannot pick up the developer's real Claude Code OAuth token. Deleting HOME
  // is not enough — Node's `os.homedir()` falls back to /etc/passwd. Tests that
  // need a Claude creds file override this via seedClaudeOauth().
  process.env['HOME'] = join(
    tmpdir(),
    `cleo-authtype-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
});

afterEach(() => {
  restoreEnv();
  clearAnthropicKeyCache();
});

describe('authType detection — anthropic', () => {
  it('marks Claude Code OAuth tokens (tier 3) as oauth', () => {
    seedClaudeOauth('sk-ant-oat-XXXXX');
    const cred = resolveCredentials('anthropic');
    expect(cred.apiKey).toBe('sk-ant-oat-XXXXX');
    expect(cred.source).toBe('claude-creds');
    expect(cred.authType).toBe('oauth');
  });

  it('marks env-var API keys (tier 2) as api_key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-XXXXX';
    const cred = resolveCredentials('anthropic');
    expect(cred.apiKey).toBe('sk-ant-api03-XXXXX');
    expect(cred.source).toBe('env');
    expect(cred.authType).toBe('api_key');
  });

  it('detects OAuth-prefixed tokens pasted into env as oauth', () => {
    // User pastes their Claude Code OAuth access token into ANTHROPIC_API_KEY.
    // The prefix heuristic should still route to the Bearer scheme.
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-oat-pasted-into-env';
    const cred = resolveCredentials('anthropic');
    expect(cred.source).toBe('env');
    expect(cred.authType).toBe('oauth');
  });

  it('returns authType=api_key with null token when no credential is available', () => {
    const cred = resolveCredentials('anthropic');
    expect(cred.apiKey).toBeNull();
    expect(cred.authType).toBe('api_key');
  });
});

describe('authType detection — non-anthropic providers', () => {
  it('always returns api_key for openai regardless of token shape', () => {
    process.env['OPENAI_API_KEY'] = 'sk-ant-oat-not-actually-anthropic';
    const cred = resolveCredentials('openai');
    expect(cred.authType).toBe('api_key');
  });

  it('always returns api_key for gemini', () => {
    process.env['GEMINI_API_KEY'] = 'AIza-XXXX';
    const cred = resolveCredentials('gemini');
    expect(cred.authType).toBe('api_key');
  });
});

describe('authHeaders()', () => {
  it('produces Bearer + anthropic-beta headers for anthropic oauth', () => {
    seedClaudeOauth('sk-ant-oat-XXXXX');
    const cred = resolveCredentials('anthropic');
    const headers = authHeaders(cred);
    expect(headers['Authorization']).toBe('Bearer sk-ant-oat-XXXXX');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('produces x-api-key header for anthropic api_key', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-api03-XXXXX';
    const cred = resolveCredentials('anthropic');
    const headers = authHeaders(cred);
    expect(headers['x-api-key']).toBe('sk-ant-api03-XXXXX');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('produces Bearer auth for openai api_key (no anthropic headers)', () => {
    process.env['OPENAI_API_KEY'] = 'sk-XXXXX';
    const cred = resolveCredentials('openai');
    const headers = authHeaders(cred);
    expect(headers['Authorization']).toBe('Bearer sk-XXXXX');
    expect(headers['x-api-key']).toBeUndefined();
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  it('returns an empty bag when the credential has no token', () => {
    const cred = resolveCredentials('anthropic');
    expect(cred.apiKey).toBeNull();
    expect(authHeaders(cred)).toEqual({});
  });
});

describe('registry imports with empty env', () => {
  it('does not throw when registry is imported with no credentials present', async () => {
    // Regression guard: prior to Phase 1 the registry's initDefaultClients() ran
    // at module load. This test confirms the import side-effect is still safe
    // when no environment keys are set.
    await expect(import('../registry.js')).resolves.toBeDefined();
  });
});
