/**
 * Unit tests for `runLlmLogin` — PKCE (anthropic) + device-code (kimi-code) flows.
 *
 * Mocks the OAuth helpers, provider registry, and credential store so no
 * network or filesystem I/O occurs. Covers:
 * - kimi-code device-code success + error paths (T9323 AC#1)
 * - anthropic PKCE headless success + error paths (T9302)
 * - unsupported provider returns E_NOT_IMPLEMENTED
 *
 * REGRESSION GUARD (T9579): node:child_process is mocked to prevent real
 * browser windows from opening during test runs. Every PKCE test asserts
 * that the spawn mock is NOT called.
 *
 * @task T9302
 * @task T9323
 * @task T9579
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — declared before imports so vi.mock hoisting works
// ---------------------------------------------------------------------------

// Prevent any real browser launch: mock node:child_process before the module
// under test is imported. Without this mock, _tryOpenBrowser calls
// spawn('xdg-open', [url], ...) and actually opens a browser window during
// test runs (regression fixed in T9579).
vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

const m = vi.hoisted(() => ({
  startDeviceCodeFlow: vi.fn(),
  pollForToken: vi.fn(),
  getKimiCodeDeviceCodeConfig: vi.fn(),
  DeviceCodeTimeoutError: class DeviceCodeTimeoutError extends Error {
    provider: string;
    elapsed: number;
    constructor(provider: string, elapsed: number) {
      super(`Device code timed out (${provider}, ${elapsed}s)`);
      this.name = 'DeviceCodeTimeoutError';
      this.provider = provider;
      this.elapsed = elapsed;
    }
  },
  DeviceCodeAuthError: class DeviceCodeAuthError extends Error {
    provider: string;
    errorCode: string;
    constructor(provider: string, errorCode: string, desc: string) {
      super(`Auth error (${provider}): ${errorCode} — ${desc}`);
      this.name = 'DeviceCodeAuthError';
      this.provider = provider;
      this.errorCode = errorCode;
    }
  },
  addCredential: vi.fn(),
  getKimiCodeMshHeaders: vi.fn(),
  getProviderProfile: vi.fn(),
  generatePkcePair: vi.fn(),
  buildAuthorizationUrl: vi.fn(),
  exchangePkceCode: vi.fn(),
  refreshPkceToken: vi.fn(),
}));

vi.mock('@cleocode/core/llm/oauth/device-code.js', () => ({
  startDeviceCodeFlow: m.startDeviceCodeFlow,
  pollForToken: m.pollForToken,
  getKimiCodeDeviceCodeConfig: m.getKimiCodeDeviceCodeConfig,
  DeviceCodeTimeoutError: m.DeviceCodeTimeoutError,
  DeviceCodeAuthError: m.DeviceCodeAuthError,
}));

vi.mock('@cleocode/core/llm/credentials-store.js', () => ({
  addCredential: m.addCredential,
}));

vi.mock('@cleocode/core/llm/provider-registry/builtin/kimi-code.js', () => ({
  getKimiCodeMshHeaders: m.getKimiCodeMshHeaders,
}));

vi.mock('@cleocode/core/llm/provider-registry/index.js', () => ({
  getProviderProfile: m.getProviderProfile,
}));

vi.mock('@cleocode/core/llm/oauth/pkce.js', () => ({
  generatePkcePair: m.generatePkcePair,
  buildAuthorizationUrl: m.buildAuthorizationUrl,
  exchangePkceCode: m.exchangePkceCode,
  refreshPkceToken: m.refreshPkceToken,
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { runLlmLogin } from '../llm-login.js';

// Typed reference to the mocked spawn for assertions.
const spawnMock = spawn as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KIMI_START_RESP = {
  deviceCode: 'dc-abc',
  userCode: 'KIMI-1234',
  verificationUri: 'https://auth.kimi.com/activate',
  verificationUriComplete: 'https://auth.kimi.com/activate?user_code=KIMI-1234',
  expiresIn: 300,
  interval: 5,
};

const KIMI_TOKEN_RESP = {
  accessToken: 'sk-kimi-access-token-xyz',
  refreshToken: 'kimi-refresh-token-abc',
  expiresIn: 900,
  tokenType: 'bearer',
};

const KIMI_CFG = {
  provider: 'kimi-code',
  deviceCodeUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
  tokenUrl: 'https://auth.kimi.com/api/oauth/token',
  clientId: '17e5f671-d194-4dfb-9706-5516cb48c098',
};

const MSH_HEADERS = {
  'X-Msh-Platform': 'cleo',
  'X-Msh-Version': '1',
  'X-Msh-Device-Name': 'cleo-cli',
  'X-Msh-Device-Model': 'cleo',
  'X-Msh-Os-Version': process.version,
  'X-Msh-Device-Id': 'test-device-id',
};

// Suppress stderr output in tests
let stderrSpy: ReturnType<typeof vi.spyOn>;

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

const ANTHROPIC_PROFILE = {
  name: 'anthropic',
  displayName: 'Anthropic Claude',
  authTypes: ['api_key', 'oauth'],
  baseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-haiku-4-5-20251001',
  oauth: {
    mode: 'pkce' as const,
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorizationEndpoint: 'https://claude.ai/oauth/authorize',
    tokenEndpoint: 'https://console.anthropic.com/v1/oauth/token',
    scope: 'org:create_api_key user:profile user:inference',
    redirectUri: 'http://localhost',
  },
};

const KIMI_PROFILE = {
  name: 'kimi-code',
  displayName: 'Kimi Code',
  authTypes: ['oauth'],
  baseUrl: 'https://api.kimi.com',
  defaultModel: 'kimi-latest',
  oauth: {
    mode: 'device-code' as const,
    clientId: '17e5f671',
    tokenEndpoint: 'https://auth.kimi.com/api/oauth/token',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // Reset the child_process spawn mock so each test starts clean.
  spawnMock.mockClear();
  spawnMock.mockReturnValue({ unref: vi.fn() });
  m.getKimiCodeDeviceCodeConfig.mockReturnValue(KIMI_CFG);
  m.getKimiCodeMshHeaders.mockReturnValue(MSH_HEADERS);
  m.addCredential.mockResolvedValue({ provider: 'kimi-code', label: 'oauth-login' });
  // Default: anthropic → PKCE profile, kimi-code → device-code profile
  m.getProviderProfile.mockImplementation(async (provider: string) => {
    if (provider === 'anthropic') return ANTHROPIC_PROFILE;
    if (provider === 'kimi-code') return KIMI_PROFILE;
    return undefined;
  });
  // PKCE helpers defaults
  m.generatePkcePair.mockResolvedValue({
    codeVerifier: 'test-verifier',
    codeChallenge: 'test-challenge',
  });
  m.buildAuthorizationUrl.mockReturnValue('https://claude.ai/oauth/authorize?code_challenge=test');
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Tests — kimi-code success path (AC#1)
// ---------------------------------------------------------------------------

describe('runLlmLogin — kimi-code success path', () => {
  it('returns success with provider=kimi-code on happy path', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue(KIMI_TOKEN_RESP);

    const result = await runLlmLogin('kimi-code', {});

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data?.provider).toBe('kimi-code');
    expect(result.data?.expiresIn).toBe(900);
    expect(result.data?.label).toBe('oauth-login');
  });

  it('calls startDeviceCodeFlow with kimi-code config', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue(KIMI_TOKEN_RESP);

    await runLlmLogin('kimi-code', {});

    expect(m.getKimiCodeDeviceCodeConfig).toHaveBeenCalledOnce();
    expect(m.startDeviceCodeFlow).toHaveBeenCalledWith(KIMI_CFG);
  });

  it('stores credential with correct provider, authType, extraHeaders', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue(KIMI_TOKEN_RESP);

    await runLlmLogin('kimi-code', {});

    expect(m.addCredential).toHaveBeenCalledOnce();
    const stored = m.addCredential.mock.calls[0]![0];
    expect(stored.provider).toBe('kimi-code');
    expect(stored.authType).toBe('oauth');
    expect(stored.accessToken).toBe('sk-kimi-access-token-xyz');
    expect(stored.refreshToken).toBe('kimi-refresh-token-abc');
    expect(stored.extraHeaders).toEqual(MSH_HEADERS);
    expect(stored.source).toBe('oauth-device-code');
  });

  it('uses --label option when provided', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue(KIMI_TOKEN_RESP);

    await runLlmLogin('kimi-code', { label: 'work-kimi' });

    const stored = m.addCredential.mock.calls[0]![0];
    expect(stored.label).toBe('work-kimi');
  });

  it('sets expiresAt from token expiresIn', async () => {
    const now = Date.now();
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue({ ...KIMI_TOKEN_RESP, expiresIn: 900 });

    await runLlmLogin('kimi-code', {});

    const stored = m.addCredential.mock.calls[0]![0];
    expect(stored.expiresAt).toBeGreaterThanOrEqual(now + 900_000 - 100);
    expect(stored.expiresAt).toBeLessThanOrEqual(now + 900_000 + 5_000);
  });

  it('does NOT call generatePkcePair for kimi-code (device-code path)', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue(KIMI_TOKEN_RESP);

    await runLlmLogin('kimi-code', {});

    expect(m.generatePkcePair).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — kimi-code error cases
// ---------------------------------------------------------------------------

describe('runLlmLogin — kimi-code error cases', () => {
  it('returns E_DEVICE_CODE_START_FAILED when startDeviceCodeFlow throws', async () => {
    m.startDeviceCodeFlow.mockRejectedValue(new Error('Network error'));

    const result = await runLlmLogin('kimi-code', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_DEVICE_CODE_START_FAILED');
    expect(result.error?.message).toContain('Kimi Code');
    expect(result.error?.message).toContain('Network error');
  });

  it('returns E_DEVICE_CODE_TIMEOUT on DeviceCodeTimeoutError', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockRejectedValue(new m.DeviceCodeTimeoutError('kimi-code', 300));

    const result = await runLlmLogin('kimi-code', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_DEVICE_CODE_TIMEOUT');
  });

  it('returns E_DEVICE_CODE_AUTH_FAILED on DeviceCodeAuthError', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockRejectedValue(
      new m.DeviceCodeAuthError('kimi-code', 'access_denied', 'User denied'),
    );

    const result = await runLlmLogin('kimi-code', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_DEVICE_CODE_AUTH_FAILED');
  });

  it('returns E_DEVICE_CODE_POLL_FAILED on generic poll error', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockRejectedValue(new Error('Connection reset'));

    const result = await runLlmLogin('kimi-code', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_DEVICE_CODE_POLL_FAILED');
    expect(result.error?.message).toContain('Kimi Code');
  });

  it('returns E_CREDENTIAL_STORE_FAILED when addCredential throws', async () => {
    m.startDeviceCodeFlow.mockResolvedValue(KIMI_START_RESP);
    m.pollForToken.mockResolvedValue(KIMI_TOKEN_RESP);
    m.addCredential.mockRejectedValue(new Error('Lock timeout'));

    const result = await runLlmLogin('kimi-code', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_CREDENTIAL_STORE_FAILED');
    expect(result.error?.message).toContain('Kimi Code');
  });
});

// ---------------------------------------------------------------------------
// Tests — unsupported providers
// ---------------------------------------------------------------------------

describe('runLlmLogin — E_NOT_IMPLEMENTED for unsupported providers', () => {
  it('returns E_NOT_IMPLEMENTED for openai', async () => {
    const result = await runLlmLogin('openai', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_NOT_IMPLEMENTED');
    expect(result.error?.message).toContain('anthropic');
    expect(result.error?.message).toContain('kimi-code');
  });

  it('returns E_NOT_IMPLEMENTED for gemini', async () => {
    const result = await runLlmLogin('gemini', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_NOT_IMPLEMENTED');
  });

  it('returns E_NOT_IMPLEMENTED for unknown provider', async () => {
    const result = await runLlmLogin('my-custom-llm', {});

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error?.code).toBe('E_NOT_IMPLEMENTED');
  });

  it('does NOT return E_NOT_IMPLEMENTED for anthropic (PKCE path)', async () => {
    // Anthropic has oauth.mode='pkce' → should dispatch to PKCE flow, not E_NOT_IMPLEMENTED.
    // Use headless: true + mock stdin to emit an invalid URL so _headlessPkceFlow
    // rejects quickly. The key assertion is that the error is NOT E_NOT_IMPLEMENTED.
    const stdinSpy = vi
      .spyOn(process.stdin, 'once')
      .mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          setTimeout(() => listener('not-a-valid-url'), 0);
        }
        return process.stdin;
      });

    const result = await runLlmLogin('anthropic', { headless: true }).catch((e: unknown) => ({
      success: false as const,
      error: { code: 'E_TEST_ERROR', codeName: 'E_TEST_ERROR', message: String(e) },
      meta: { operation: 'llm.login', timestamp: '' },
    }));

    stdinSpy.mockRestore();
    expect(result.error?.code).not.toBe('E_NOT_IMPLEMENTED');
  });
});

// ---------------------------------------------------------------------------
// Tests — anthropic PKCE path (T9302)
// ---------------------------------------------------------------------------

describe('runLlmLogin — anthropic PKCE success (headless + mocked exchange)', () => {
  it('calls generatePkcePair and buildAuthorizationUrl for anthropic', async () => {
    // Use headless mode so _headlessPkceFlow runs (stdin-based, no HTTP server,
    // no browser spawn). Mock stdin to emit an invalid URL so the flow exits
    // quickly. generatePkcePair + buildAuthorizationUrl are called before stdin.
    const stdinSpy = vi
      .spyOn(process.stdin, 'once')
      .mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          setTimeout(() => listener('not-a-valid-url'), 0);
        }
        return process.stdin;
      });

    m.exchangePkceCode.mockResolvedValue({
      accessToken: 'sk-ant-oat-new',
      expiresIn: 3600,
      tokenType: 'bearer',
    });
    m.addCredential.mockResolvedValue({ provider: 'anthropic', label: 'oauth-login' });

    const pairSpy = m.generatePkcePair;
    const urlSpy = m.buildAuthorizationUrl;

    await runLlmLogin('anthropic', { headless: true }).catch(() => {
      /* invalid stdin URL causes a rejection — expected */
    });

    stdinSpy.mockRestore();

    expect(pairSpy).toHaveBeenCalledOnce();
    expect(urlSpy).toHaveBeenCalledOnce();
    const urlCallArgs = urlSpy.mock.calls[0]![0] as Record<string, string>;
    expect(urlCallArgs.clientId).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(urlCallArgs.codeChallenge).toBe('test-challenge');
    expect(urlCallArgs.state).toBeTruthy();

    // Regression guard (T9579): headless path must NOT spawn a browser process.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('returns E_PKCE_EXCHANGE_FAILED when exchangePkceCode throws', async () => {
    // Use headless: true so _headlessPkceFlow reads from stdin (no HTTP server,
    // no browser spawn). Mock stdin to emit a redirect URL with a code.
    const stdinSpy = vi
      .spyOn(process.stdin, 'once')
      .mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          // Emit a fake redirect URL with code after a tick
          setTimeout(() => listener('http://localhost?code=test-auth-code&state='), 0);
        }
        return process.stdin;
      });

    m.exchangePkceCode.mockRejectedValue(new Error('invalid_grant'));
    m.addCredential.mockResolvedValue({ provider: 'anthropic', label: 'oauth-login' });

    const result = await runLlmLogin('anthropic', { headless: true });

    expect(result.success).toBe(false);
    if (result.success) {
      stdinSpy.mockRestore();
      return;
    }
    expect(result.error?.code).toBe('E_PKCE_EXCHANGE_FAILED');

    // Regression guard (T9579): headless path must NOT spawn a browser process.
    expect(spawnMock).not.toHaveBeenCalled();

    stdinSpy.mockRestore();
  });

  it('returns E_CREDENTIAL_STORE_FAILED when addCredential throws after PKCE exchange', async () => {
    const stdinSpy = vi
      .spyOn(process.stdin, 'once')
      .mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          setTimeout(() => listener('http://localhost?code=good-code&state='), 0);
        }
        return process.stdin;
      });

    m.exchangePkceCode.mockResolvedValue({
      accessToken: 'sk-ant-oat-new',
      expiresIn: 3600,
      tokenType: 'bearer',
    });
    m.addCredential.mockRejectedValue(new Error('lock timeout'));

    const result = await runLlmLogin('anthropic', { headless: true });

    expect(result.success).toBe(false);
    if (result.success) {
      stdinSpy.mockRestore();
      return;
    }
    expect(result.error?.code).toBe('E_CREDENTIAL_STORE_FAILED');

    // Regression guard (T9579): headless path must NOT spawn a browser process.
    expect(spawnMock).not.toHaveBeenCalled();

    stdinSpy.mockRestore();
  });

  it('returns success with provider=anthropic on happy PKCE path', async () => {
    const stdinSpy = vi
      .spyOn(process.stdin, 'once')
      .mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          setTimeout(() => listener('http://localhost?code=good-code&state='), 0);
        }
        return process.stdin;
      });

    m.exchangePkceCode.mockResolvedValue({
      accessToken: 'sk-ant-oat-success',
      refreshToken: 'sk-ant-oat-refresh',
      expiresIn: 3600,
      tokenType: 'bearer',
    });
    m.addCredential.mockResolvedValue({ provider: 'anthropic', label: 'oauth-login' });

    const result = await runLlmLogin('anthropic', { headless: true });

    expect(result.success).toBe(true);
    if (!result.success) {
      stdinSpy.mockRestore();
      return;
    }
    expect(result.data?.provider).toBe('anthropic');
    expect(result.data?.expiresIn).toBe(3600);
    expect(result.data?.label).toBe('oauth-login');

    // Verify credential was stored with source='oauth-pkce'
    expect(m.addCredential).toHaveBeenCalledOnce();
    const stored = m.addCredential.mock.calls[0]![0];
    expect(stored.source).toBe('oauth-pkce');
    expect(stored.authType).toBe('oauth');
    expect(stored.accessToken).toBe('sk-ant-oat-success');

    // Regression guard (T9579): headless path must NOT spawn a browser process.
    expect(spawnMock).not.toHaveBeenCalled();

    stdinSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Regression tests — T9579: no real browser spawn during test runs
// ---------------------------------------------------------------------------

describe('runLlmLogin — T9579 regression: no real browser spawn', () => {
  it('kimi-code device-code flow never calls spawn', async () => {
    m.startDeviceCodeFlow.mockResolvedValue({
      deviceCode: 'dc-abc',
      userCode: 'KIMI-1234',
      verificationUri: 'https://auth.kimi.com/activate',
      verificationUriComplete: 'https://auth.kimi.com/activate?user_code=KIMI-1234',
      expiresIn: 300,
      interval: 5,
    });
    m.pollForToken.mockResolvedValue({
      accessToken: 'sk-kimi-access-token',
      refreshToken: 'kimi-refresh-token',
      expiresIn: 900,
      tokenType: 'bearer',
    });
    m.addCredential.mockResolvedValue({ provider: 'kimi-code', label: 'oauth-login' });

    await runLlmLogin('kimi-code', {});

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('anthropic PKCE headless flow never calls spawn', async () => {
    const stdinSpy = vi
      .spyOn(process.stdin, 'once')
      .mockImplementation((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'data') {
          setTimeout(() => listener('http://localhost?code=no-browser-code&state='), 0);
        }
        return process.stdin;
      });

    m.exchangePkceCode.mockResolvedValue({
      accessToken: 'sk-ant-no-browser',
      expiresIn: 3600,
      tokenType: 'bearer',
    });
    m.addCredential.mockResolvedValue({ provider: 'anthropic', label: 'oauth-login' });

    await runLlmLogin('anthropic', { headless: true });

    // The core assertion: spawn (used by _tryOpenBrowser) must NOT be called
    // in headless mode. A regression here means tests would open real browser
    // windows pointing at the mock auth URL.
    expect(spawnMock).not.toHaveBeenCalled();

    stdinSpy.mockRestore();
  });
});
