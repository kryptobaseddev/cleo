/**
 * Smoke tests for `parseClaudeCodeCredentials()` in @cleocode/contracts.
 *
 * Covers both OAuth-shaped and api-key-shaped JSON, plus edge cases
 * (malformed input, expired tokens, missing fields).
 *
 * @task T9307
 */

import { describe, expect, it } from 'vitest';
import { parseClaudeCodeCredentials } from '../credentials.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCreds(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat-test-token',
      expiresAt: Date.now() + 3_600_000,
      ...overrides,
    },
  });
}

// ---------------------------------------------------------------------------
// OAuth-shaped credentials
// ---------------------------------------------------------------------------

describe('OAuth-shaped credentials', () => {
  it('returns accessToken for valid OAuth JSON', () => {
    const result = parseClaudeCodeCredentials(makeCreds());
    expect(result).not.toBeNull();
    expect(result?.accessToken).toBe('sk-ant-oat-test-token');
  });

  it('returns expiresAt when present', () => {
    const expiresAt = Date.now() + 7_200_000;
    const result = parseClaudeCodeCredentials(makeCreds({ expiresAt }));
    expect(result?.expiresAt).toBe(expiresAt);
  });

  it('returns refreshToken when present', () => {
    const result = parseClaudeCodeCredentials(
      makeCreds({ refreshToken: 'sk-ant-ort-refresh-token' }),
    );
    expect(result?.refreshToken).toBe('sk-ant-ort-refresh-token');
  });

  it('returns null for expired token', () => {
    const result = parseClaudeCodeCredentials(makeCreds({ expiresAt: Date.now() - 1 }));
    expect(result).toBeNull();
  });

  it('omits expiresAt when not provided', () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'sk-ant-oat-no-expiry' },
    });
    const result = parseClaudeCodeCredentials(raw);
    expect(result?.accessToken).toBe('sk-ant-oat-no-expiry');
    expect(result?.expiresAt).toBeUndefined();
  });

  it('accepts a Buffer input', () => {
    const buf = Buffer.from(makeCreds(), 'utf-8');
    const result = parseClaudeCodeCredentials(buf);
    expect(result?.accessToken).toBe('sk-ant-oat-test-token');
  });
});

// ---------------------------------------------------------------------------
// Api-key-shaped / missing claudeAiOauth block
// ---------------------------------------------------------------------------

describe('Non-OAuth / missing block', () => {
  it('returns null when claudeAiOauth block is absent', () => {
    const raw = JSON.stringify({ someOtherKey: 'value' });
    expect(parseClaudeCodeCredentials(raw)).toBeNull();
  });

  it('returns null when accessToken is empty string', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: '' } });
    expect(parseClaudeCodeCredentials(raw)).toBeNull();
  });

  it('returns null when accessToken is whitespace only', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: '   ' } });
    expect(parseClaudeCodeCredentials(raw)).toBeNull();
  });

  it('returns null when accessToken field is missing', () => {
    const raw = JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 3600 } });
    expect(parseClaudeCodeCredentials(raw)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Malformed / edge-case input
// ---------------------------------------------------------------------------

describe('Malformed input', () => {
  it('returns null for empty string', () => {
    expect(parseClaudeCodeCredentials('')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseClaudeCodeCredentials('not-json')).toBeNull();
  });

  it('returns null for JSON null', () => {
    expect(parseClaudeCodeCredentials('null')).toBeNull();
  });

  it('returns null for JSON array', () => {
    expect(parseClaudeCodeCredentials('[]')).toBeNull();
  });

  it('returns null for empty Buffer', () => {
    expect(parseClaudeCodeCredentials(Buffer.alloc(0))).toBeNull();
  });
});
