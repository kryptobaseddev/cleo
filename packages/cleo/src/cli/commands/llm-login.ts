/**
 * `cleo llm login <provider>` — OAuth login dispatcher.
 *
 * Dispatches to the appropriate OAuth flow based on the provider profile's
 * `oauth.mode` field:
 * - `'pkce'`        — RFC 7636 PKCE Authorization Code flow. Opens a browser
 *                     URL (or prints it in headless/CI mode) and exchanges the
 *                     returned authorization code for tokens.
 * - `'device-code'` — RFC 8628 Device Authorization Grant. Used by kimi-code.
 *
 * The dispatcher reads `profile.oauth.mode` from the provider registry so
 * the routing table stays in the profile, not duplicated here.
 *
 * ## Supported providers
 *
 * - `anthropic` — RFC 7636 PKCE via `claude.ai/oauth/authorize`.
 * - `kimi-code` — RFC 8628 device-code via `auth.kimi.com`.
 *
 * ## Security
 *
 * - Access tokens and refresh tokens are NEVER written to stdout or included
 *   in LAFS envelope responses.
 * - Credentials land in the pool via `addCredential()` which writes with
 *   0600 permissions and uses a file lock.
 *
 * ## Headless / CI mode
 *
 * When `CLEO_HEADLESS=1` or `--headless` is set, the authorization URL is
 * printed to stderr and the user is prompted to paste the full redirect URL
 * (including the `?code=…&state=…` parameters) back into the terminal.
 *
 * @module cli/commands/llm-login
 * @task T9266
 * @task T9302
 * @task T9323
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { ProviderOAuthConfig } from '@cleocode/contracts/llm/oauth.js';
import type { ModelTransport } from '@cleocode/contracts/operations/llm.js';
import { addCredential } from '@cleocode/core/llm/credentials-store.js';
import {
  DeviceCodeAuthError,
  DeviceCodeTimeoutError,
  getKimiCodeDeviceCodeConfig,
  pollForToken,
  startDeviceCodeFlow,
} from '@cleocode/core/llm/oauth/device-code.js';
import {
  buildAuthorizationUrl,
  exchangePkceCode,
  generatePkcePair,
  refreshPkceToken,
} from '@cleocode/core/llm/oauth/pkce.js';
import { getKimiCodeMshHeaders } from '@cleocode/core/llm/provider-registry/builtin/kimi-code.js';
import { getProviderProfile } from '@cleocode/core/llm/provider-registry/index.js';

// Re-export for tests that need to mock it.
export { refreshPkceToken };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the `cleo llm login` subcommand. */
interface LlmLoginOptions {
  /** Human-readable label stored alongside the credential. */
  label?: string;
  /** Force headless mode — print URL instead of opening browser. */
  headless?: boolean;
}

/** LAFS-shaped result returned from `runLlmLogin`. */
interface LlmLoginResult {
  success: boolean;
  data?: {
    provider: string;
    label: string;
    expiresIn: number | undefined;
  };
  error?: {
    code: string;
    codeName: string;
    message: string;
  };
  meta: {
    operation: string;
    timestamp: string;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run the `cleo llm login <provider>` subcommand.
 *
 * Reads `profile.oauth.mode` from the provider registry and dispatches to the
 * appropriate OAuth flow. Returns a LAFS-shaped result envelope.
 *
 * Supported providers: `'anthropic'` (PKCE), `'kimi-code'` (device-code).
 * All other providers return `E_NOT_IMPLEMENTED`.
 *
 * @param provider - Provider name passed on the CLI.
 * @param opts - Subcommand options (`--label`, `--headless`).
 * @returns LAFS-shaped success or error result.
 * @task T9302
 * @task T9323
 */
export async function runLlmLogin(
  provider: string,
  opts: LlmLoginOptions,
): Promise<LlmLoginResult> {
  const meta = { operation: 'llm.login', timestamp: new Date().toISOString() };

  const profile = await getProviderProfile(provider);
  const oauthMode = profile?.oauth?.mode;

  if (provider === 'kimi-code' || oauthMode === 'device-code') {
    return _runKimiCodeLogin(opts, meta);
  }

  if (oauthMode === 'pkce') {
    return _runPkceLogin(provider, profile!.oauth!, opts, meta);
  }

  return {
    success: false,
    error: {
      code: 'E_NOT_IMPLEMENTED',
      codeName: 'E_NOT_IMPLEMENTED',
      message:
        `OAuth login for '${provider}' is not yet wired. ` +
        `Supported providers: 'anthropic' (PKCE), 'kimi-code' (device-code). ` +
        `To add credentials for other providers use 'cleo llm add <provider> --api-key-stdin'.`,
    },
    meta,
  };
}

// ---------------------------------------------------------------------------
// PKCE flow (RFC 7636) — used by anthropic
// ---------------------------------------------------------------------------

/**
 * Execute the RFC 7636 PKCE Authorization Code flow for a provider.
 *
 * In interactive mode: opens a local HTTP callback server on a random port,
 * emits the authorization URL to stderr (and attempts to open it in the
 * default browser via `open` if available), waits for the redirect callback,
 * then exchanges the code for tokens.
 *
 * In headless mode (`CLEO_HEADLESS=1` or `opts.headless`): prints the
 * authorization URL to stderr and prompts the user to paste the full redirect
 * URL back via stdin. No browser dependency is required.
 *
 * @param provider   - Provider name (for error messages and credential storage).
 * @param oauthCfg   - OAuth configuration from `profile.oauth`.
 * @param opts       - Subcommand options.
 * @param meta       - LAFS meta block.
 * @returns LAFS result envelope.
 * @task T9302
 */
async function _runPkceLogin(
  provider: string,
  oauthCfg: ProviderOAuthConfig,
  opts: LlmLoginOptions,
  meta: LlmLoginResult['meta'],
): Promise<LlmLoginResult> {
  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = _generateState();
  const isHeadless = opts.headless || process.env['CLEO_HEADLESS'] === '1';

  // Determine redirect URI and port for the local callback server.
  const port = isHeadless ? 0 : await _findFreePort();
  const redirectUri = isHeadless
    ? (oauthCfg.redirectUri ?? 'http://localhost')
    : `http://localhost:${port}/callback`;

  const authUrl = buildAuthorizationUrl({
    authorizationEndpoint: oauthCfg.authorizationEndpoint ?? '',
    clientId: oauthCfg.clientId,
    redirectUri,
    scope: oauthCfg.scope ?? '',
    codeChallenge,
    state,
  });

  let code: string;

  if (isHeadless) {
    code = await _headlessPkceFlow(provider, authUrl);
  } else {
    const result = await _localCallbackPkceFlow(provider, authUrl, state, port);
    if ('error' in result) {
      return { success: false, error: result.error, meta };
    }
    code = result.code;
  }

  // Exchange the authorization code for tokens.
  let tokens: Awaited<ReturnType<typeof exchangePkceCode>>;
  try {
    tokens = await exchangePkceCode({
      provider,
      clientId: oauthCfg.clientId,
      code,
      codeVerifier,
      redirectUri,
      tokenEndpoint: oauthCfg.tokenEndpoint,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'E_PKCE_EXCHANGE_FAILED',
        codeName: 'E_PKCE_EXCHANGE_FAILED',
        message: `PKCE code exchange failed: ${msg}`,
      },
      meta,
    };
  }

  process.stderr.write('\r  Authorization approved.              \n\n');

  const label = opts.label ?? 'oauth-login';
  const expiresAt =
    typeof tokens.expiresIn === 'number' ? Date.now() + tokens.expiresIn * 1000 : undefined;

  try {
    await addCredential({
      provider: provider as ModelTransport,
      label,
      authType: 'oauth',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
      priority: 10,
      source: 'oauth-pkce',
      extraHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'E_CREDENTIAL_STORE_FAILED',
        codeName: 'E_CREDENTIAL_STORE_FAILED',
        message: `Failed to store credential in pool: ${msg}`,
      },
      meta,
    };
  }

  return {
    success: true,
    data: { provider, label, expiresIn: tokens.expiresIn },
    meta,
  };
}

/**
 * Headless PKCE flow: print URL to stderr, read redirect URL from stdin.
 *
 * The user opens the URL in a browser, approves access, and pastes the
 * full redirect URL (containing `?code=…&state=…`) back into the terminal.
 *
 * @returns Authorization code extracted from the pasted redirect URL.
 * @throws {Error} When the user input is missing a `code` parameter.
 * @internal
 */
async function _headlessPkceFlow(provider: string, authUrl: string): Promise<string> {
  process.stderr.write('\n');
  process.stderr.write(`  Provider: ${provider}\n`);
  process.stderr.write(`  Open this URL in your browser to authorize:\n\n`);
  process.stderr.write(`  ${authUrl}\n\n`);
  process.stderr.write(
    `  After approving, paste the full redirect URL (http://localhost?code=…&state=…):\n  `,
  );

  return new Promise<string>((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => {
      buf += String(chunk).trim();
      try {
        const url = new URL(buf);
        const code = url.searchParams.get('code');
        if (!code) {
          reject(new Error('Redirect URL is missing the "code" parameter'));
          return;
        }
        resolve(code);
      } catch {
        reject(new Error(`Invalid redirect URL: ${buf}`));
      }
    });
  });
}

/**
 * Interactive PKCE flow: spin up a local HTTP server, emit URL, wait for callback.
 *
 * @returns `{ code }` on success or `{ error }` on failure.
 * @internal
 */
async function _localCallbackPkceFlow(
  provider: string,
  authUrl: string,
  expectedState: string,
  port: number,
): Promise<{ code: string } | { error: LlmLoginResult['error'] }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (error) {
        res.end(`<h1>Authorization failed</h1><p>${error}</p><p>You may close this tab.</p>`);
        server.close();
        resolve({
          error: {
            code: 'E_PKCE_AUTH_DENIED',
            codeName: 'E_PKCE_AUTH_DENIED',
            message: `OAuth authorization denied for '${provider}': ${error}`,
          },
        });
        return;
      }

      if (!code || state !== expectedState) {
        res.end('<h1>Invalid callback</h1><p>You may close this tab.</p>');
        server.close();
        resolve({
          error: {
            code: 'E_PKCE_INVALID_CALLBACK',
            codeName: 'E_PKCE_INVALID_CALLBACK',
            message: 'OAuth callback received invalid code or state mismatch',
          },
        });
        return;
      }

      res.end('<h1>Authorized</h1><p>You may close this tab and return to your terminal.</p>');
      server.close();
      resolve({ code });
    });

    server.listen(port, 'localhost', () => {
      process.stderr.write('\n');
      process.stderr.write(`  Provider: ${provider}\n`);
      process.stderr.write(`  Open this URL to authorize (or it will open automatically):\n\n`);
      process.stderr.write(`  ${authUrl}\n\n`);
      process.stderr.write(`  Waiting for authorization callback...\n`);

      // Attempt to open the browser; silently skip if unavailable.
      _tryOpenBrowser(authUrl);
    });
  });
}

// ---------------------------------------------------------------------------
// Kimi Code device-code login (AC#1 — T9323)
// ---------------------------------------------------------------------------

/**
 * Internal implementation of the Kimi Code device-code OAuth flow.
 *
 * Separated from `runLlmLogin` to keep the routing table clean. Stores
 * the resulting access + refresh tokens in the credential pool with the six
 * mandatory `X-Msh-*` headers that Kimi Code requires on every request.
 *
 * Token lifecycle: access ~15 min, refresh ~30 days.
 *
 * @param opts - Subcommand options (`--label`).
 * @param meta - LAFS meta block (shared across login variants).
 * @returns LAFS-shaped success or error result.
 * @task T9323
 */
async function _runKimiCodeLogin(
  opts: LlmLoginOptions,
  meta: LlmLoginResult['meta'],
): Promise<LlmLoginResult> {
  const cfg = getKimiCodeDeviceCodeConfig();

  let startResp: Awaited<ReturnType<typeof startDeviceCodeFlow>>;
  try {
    startResp = await startDeviceCodeFlow(cfg);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'E_DEVICE_CODE_START_FAILED',
        codeName: 'E_DEVICE_CODE_START_FAILED',
        message: `Failed to initiate Kimi Code device-code OAuth flow: ${msg}`,
      },
      meta,
    };
  }

  process.stderr.write('\n');
  process.stderr.write(
    `  Visit:      ${startResp.verificationUriComplete ?? startResp.verificationUri}\n`,
  );
  process.stderr.write(`  Enter code: ${startResp.userCode}\n`);
  process.stderr.write('\n');
  process.stderr.write(
    `  Waiting for Kimi Code authorization (up to ${Math.round(startResp.expiresIn / 60)} min)...\n`,
  );

  let tokenResp: Awaited<ReturnType<typeof pollForToken>>;
  try {
    tokenResp = await pollForToken(cfg, startResp, {
      onPending: (elapsed: number) => {
        process.stderr.write(`\r  Polling... ${elapsed}s elapsed`);
      },
    });
  } catch (err: unknown) {
    process.stderr.write('\n');

    if (err instanceof DeviceCodeTimeoutError) {
      return {
        success: false,
        error: {
          code: 'E_DEVICE_CODE_TIMEOUT',
          codeName: 'E_DEVICE_CODE_TIMEOUT',
          message: err.message,
        },
        meta,
      };
    }
    if (err instanceof DeviceCodeAuthError) {
      return {
        success: false,
        error: {
          code: 'E_DEVICE_CODE_AUTH_FAILED',
          codeName: 'E_DEVICE_CODE_AUTH_FAILED',
          message: err.message,
        },
        meta,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'E_DEVICE_CODE_POLL_FAILED',
        codeName: 'E_DEVICE_CODE_POLL_FAILED',
        message: `Polling for Kimi Code device-code token failed: ${msg}`,
      },
      meta,
    };
  }

  process.stderr.write('\r  Kimi Code authorization approved.              \n\n');

  const label = opts.label ?? 'oauth-login';
  const expiresAt =
    typeof tokenResp.expiresIn === 'number' ? Date.now() + tokenResp.expiresIn * 1000 : undefined;

  try {
    await addCredential({
      provider: 'kimi-code',
      label,
      authType: 'oauth',
      accessToken: tokenResp.accessToken,
      refreshToken: tokenResp.refreshToken,
      expiresAt,
      priority: 10,
      source: 'oauth-device-code',
      // The six mandatory X-Msh-* headers must be carried alongside the token
      // so every transport that picks this credential sends them automatically.
      extraHeaders: getKimiCodeMshHeaders(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      error: {
        code: 'E_CREDENTIAL_STORE_FAILED',
        codeName: 'E_CREDENTIAL_STORE_FAILED',
        message: `Failed to store Kimi Code credential in pool: ${msg}`,
      },
      meta,
    };
  }

  return {
    success: true,
    data: {
      provider: 'kimi-code',
      label,
      expiresIn: tokenResp.expiresIn,
    },
    meta,
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically-random CSRF state parameter.
 *
 * @internal
 */
function _generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Find a free TCP port on localhost by binding to port 0.
 *
 * @internal
 */
function _findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, 'localhost', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Could not determine callback port'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Attempt to open a URL in the default browser using the OS `open` / `xdg-open`
 * command. Silently swallows errors — headless environments are expected to fail.
 *
 * Exported so tests can mock it via `vi.spyOn` to prevent real browser launches.
 *
 * @internal
 */
export function _tryOpenBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    /* silently ignore — user sees the URL on stderr */
  }
}
