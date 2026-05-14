/**
 * Unit tests for the generic OAuth device-code flow runner.
 *
 * All network calls are intercepted by stubbing the global `fetch`. No
 * real HTTP requests are made. Vitest fake timers are used to advance past
 * polling intervals without wall-clock delays.
 *
 * @task T9266
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceCodeAuthError,
  type DeviceCodeConfig,
  DeviceCodeTimeoutError,
  pollForToken,
  startDeviceCodeFlow,
} from '../oauth/device-code.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A deterministic device-code config for tests (not real endpoints). */
const TEST_CONFIG: DeviceCodeConfig = {
  provider: 'test-provider',
  deviceCodeUrl: 'https://auth.example.test/oauth/device/code',
  tokenUrl: 'https://auth.example.test/oauth/token',
  clientId: 'test-client-id',
  scope: 'read write',
};

/** Build a minimal valid start-response. */
function makeStartResp(
  overrides?: Partial<{
    deviceCode: string;
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresIn: number;
    interval: number;
  }>,
) {
  return {
    deviceCode: overrides?.deviceCode ?? 'dev-code-abc',
    userCode: overrides?.userCode ?? 'ABCD-1234',
    verificationUri: overrides?.verificationUri ?? 'https://auth.example.test/activate',
    verificationUriComplete:
      overrides?.verificationUriComplete ??
      'https://auth.example.test/activate?user_code=ABCD-1234',
    expiresIn: overrides?.expiresIn ?? 300,
    interval: overrides?.interval ?? 5,
  };
}

/** Create a `Response` stub. */
function makeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// startDeviceCodeFlow
// ---------------------------------------------------------------------------

describe('startDeviceCodeFlow', () => {
  it('returns parsed DeviceCodeStartResponse on HTTP 200', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        device_code: 'dev-abc',
        user_code: 'XY12-ZW34',
        verification_uri: 'https://auth.example.test/activate',
        verification_uri_complete: 'https://auth.example.test/activate?user_code=XY12-ZW34',
        expires_in: 600,
        interval: 10,
      }),
    );

    const resp = await startDeviceCodeFlow(TEST_CONFIG);

    expect(resp.deviceCode).toBe('dev-abc');
    expect(resp.userCode).toBe('XY12-ZW34');
    expect(resp.verificationUri).toBe('https://auth.example.test/activate');
    expect(resp.verificationUriComplete).toBe(
      'https://auth.example.test/activate?user_code=XY12-ZW34',
    );
    expect(resp.expiresIn).toBe(600);
    expect(resp.interval).toBe(10);
  });

  it('sets verificationUriComplete to undefined when absent in response', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        device_code: 'dev-x',
        user_code: 'AAAA-1111',
        verification_uri: 'https://auth.example.test/activate',
        expires_in: 300,
        interval: 5,
        // no verification_uri_complete
      }),
    );

    const resp = await startDeviceCodeFlow(TEST_CONFIG);
    expect(resp.verificationUriComplete).toBeUndefined();
  });

  it('throws when the server returns HTTP 4xx', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(400, { error: 'invalid_client', error_description: 'Unknown client' }),
    );

    await expect(startDeviceCodeFlow(TEST_CONFIG)).rejects.toThrow('HTTP 400');
  });

  it('throws when required fields are missing from the response', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        device_code: 'dev-x',
        // user_code + verification_uri + expires_in + interval are missing
      }),
    );

    await expect(startDeviceCodeFlow(TEST_CONFIG)).rejects.toThrow('missing required fields');
  });

  it('POSTs to deviceCodeUrl with client_id and scope in the body', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        device_code: 'd',
        user_code: 'U',
        verification_uri: 'https://example.test',
        expires_in: 300,
        interval: 5,
      }),
    );

    await startDeviceCodeFlow(TEST_CONFIG);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(TEST_CONFIG.deviceCodeUrl);
    expect(init.method).toBe('POST');
    const bodyStr = String(init.body);
    expect(bodyStr).toContain('client_id=test-client-id');
    expect(bodyStr).toContain('scope=read+write');
  });
});

// ---------------------------------------------------------------------------
// pollForToken — success path
// ---------------------------------------------------------------------------

describe('pollForToken — success', () => {
  it('returns the token when the first poll succeeds', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'tok-abc',
        refresh_token: 'ref-xyz',
        expires_in: 3600,
        token_type: 'bearer',
      }),
    );

    const result = await pollForToken(TEST_CONFIG, makeStartResp({ interval: 1 }));

    expect(result.accessToken).toBe('tok-abc');
    expect(result.refreshToken).toBe('ref-xyz');
    expect(result.expiresIn).toBe(3600);
    expect(result.tokenType).toBe('bearer');
  });

  it('returns a token without a refresh_token when none is provided', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(200, {
        access_token: 'tok-no-refresh',
        token_type: 'bearer',
      }),
    );

    const result = await pollForToken(TEST_CONFIG, makeStartResp({ interval: 1 }));
    expect(result.accessToken).toBe('tok-no-refresh');
    expect(result.refreshToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// pollForToken — authorization_pending retry
// ---------------------------------------------------------------------------

describe('pollForToken — authorization_pending', () => {
  it('polls multiple times through authorization_pending before succeeding', async () => {
    // First two polls return authorization_pending; third returns the token.
    fetchSpy
      .mockResolvedValueOnce(makeResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(makeResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(
        makeResponse(200, {
          access_token: 'tok-after-pending',
          token_type: 'bearer',
        }),
      );

    // Use a short interval + advance fake timers to skip the sleeps.
    const startResp = makeStartResp({ interval: 1, expiresIn: 60 });
    let pendingCallCount = 0;

    const tokenPromise = pollForToken(TEST_CONFIG, startResp, {
      onPending: () => {
        pendingCallCount++;
        // Advance fake timer by interval after each pending callback.
        vi.advanceTimersByTime(1000);
      },
    });

    // Advance timers to cover all sleeps.
    await vi.runAllTimersAsync();

    const result = await tokenPromise;
    expect(result.accessToken).toBe('tok-after-pending');
    expect(pendingCallCount).toBe(2);
  });

  it('invokes onPending callback with elapsed seconds', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(makeResponse(200, { access_token: 'tok', token_type: 'bearer' }));

    const startResp = makeStartResp({ interval: 1, expiresIn: 60 });
    const pendingArgs: Array<[number, number]> = [];

    const tokenPromise = pollForToken(TEST_CONFIG, startResp, {
      onPending: (elapsed, expiresIn) => {
        pendingArgs.push([elapsed, expiresIn]);
        vi.advanceTimersByTime(1000);
      },
    });

    await vi.runAllTimersAsync();
    await tokenPromise;

    expect(pendingArgs.length).toBe(1);
    // expiresIn should match startResp.expiresIn
    expect(pendingArgs[0]![1]).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// pollForToken — timeout
// ---------------------------------------------------------------------------

describe('pollForToken — timeout', () => {
  it('throws DeviceCodeTimeoutError when expires_in is reached', async () => {
    // Every poll returns authorization_pending — the code expires.
    fetchSpy.mockResolvedValue(makeResponse(400, { error: 'authorization_pending' }));

    const startResp = makeStartResp({ interval: 1, expiresIn: 2 });

    const tokenPromise = pollForToken(TEST_CONFIG, startResp, {
      onPending: () => {
        // Advance past the deadline on first pending.
        vi.advanceTimersByTime(10_000);
      },
    });

    // Race the token promise against timer advancement so we capture
    // the rejection before vitest's global handler sees it.
    const result = await Promise.race([
      tokenPromise.then(
        (v) => ({ ok: true as const, value: v }),
        (e: unknown) => ({ ok: false as const, error: e }),
      ),
      vi.runAllTimersAsync().then(() => null),
    ]);
    // runAllTimersAsync resolves null; tokenPromise settles with an error.
    const settled = await tokenPromise.then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
    expect(settled.ok).toBe(false);
    expect((settled as { ok: false; error: unknown }).error).toBeInstanceOf(DeviceCodeTimeoutError);
    // Suppress unused variable lint.
    void result;
  });
});

// ---------------------------------------------------------------------------
// pollForToken — unrecoverable error
// ---------------------------------------------------------------------------

describe('pollForToken — unrecoverable error', () => {
  it('throws DeviceCodeAuthError on access_denied', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(400, {
        error: 'access_denied',
        error_description: 'The user denied the request',
      }),
    );

    await expect(pollForToken(TEST_CONFIG, makeStartResp({ interval: 1 }))).rejects.toBeInstanceOf(
      DeviceCodeAuthError,
    );
  });

  it('includes the error code in DeviceCodeAuthError', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeResponse(400, {
        error: 'expired_token',
        error_description: 'The device code has expired',
      }),
    );

    const err = await pollForToken(TEST_CONFIG, makeStartResp({ interval: 1 })).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DeviceCodeAuthError);
    expect((err as DeviceCodeAuthError).errorCode).toBe('expired_token');
  });
});

// ---------------------------------------------------------------------------
// pollForToken — network error retry
// ---------------------------------------------------------------------------

describe('pollForToken — network error retry', () => {
  it('retries on transient network errors then succeeds', async () => {
    const networkError = new TypeError('fetch failed');
    fetchSpy
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(
        makeResponse(200, { access_token: 'tok-after-retry', token_type: 'bearer' }),
      );

    const startResp = makeStartResp({ interval: 1, expiresIn: 60 });

    const tokenPromise = pollForToken(TEST_CONFIG, startResp);

    // Advance timers to skip retry sleep intervals.
    await vi.runAllTimersAsync();

    const result = await tokenPromise;
    expect(result.accessToken).toBe('tok-after-retry');
  });

  it('throws after exceeding MAX_NETWORK_RETRIES consecutive network errors', async () => {
    const networkError = new TypeError('fetch failed');
    // 4 rejections — one more than MAX_NETWORK_RETRIES (3).
    fetchSpy
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError);

    const startResp = makeStartResp({ interval: 1, expiresIn: 60 });

    // Capture the rejection immediately to avoid unhandled-rejection warnings.
    const settled = pollForToken(TEST_CONFIG, startResp).then(
      (v) => ({ ok: true as const, value: v }),
      (e: unknown) => ({ ok: false as const, error: e }),
    );
    await vi.runAllTimersAsync();

    const result = await settled;
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: unknown }).error).toBeInstanceOf(TypeError);
    expect(String((result as { ok: false; error: unknown }).error)).toContain('fetch failed');
  });
});
