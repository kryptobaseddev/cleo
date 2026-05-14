/**
 * `cleo llm login <provider>` — OAuth device-code login subcommand.
 *
 * Runs the RFC 8628 device-code OAuth flow for supported providers and
 * stores the resulting access token (and optional refresh token) in the
 * CLEO multi-credential pool (`~/.cleo/llm-credentials.json`).
 *
 * ## Supported providers (MVP)
 *
 * - `anthropic` — best-effort device-code flow. See the module-level TODO
 *   in `@cleocode/core/llm/oauth/device-code.ts` for the endpoint
 *   verification requirement. If Anthropic does not expose a public
 *   device-code endpoint, this subcommand will fail at the network level
 *   and the user should fall back to `cleo llm add anthropic --api-key-stdin`.
 *
 * ## Security
 *
 * - Access tokens and refresh tokens are NEVER written to stdout or included
 *   in LAFS envelope responses.
 * - Credentials land in the pool via `addCredential()` which writes with
 *   0600 permissions and uses a file lock.
 *
 * @module cli/commands/llm-login
 * @task T9266
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { addCredential } from '@cleocode/core/llm/credentials-store.js';
import {
  DeviceCodeAuthError,
  DeviceCodeTimeoutError,
  getAnthropicDeviceCodeConfig,
  pollForToken,
  startDeviceCodeFlow,
} from '@cleocode/core/llm/oauth/device-code.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for the `cleo llm login` subcommand. */
interface LlmLoginOptions {
  /** Human-readable label stored alongside the credential. */
  label?: string;
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
 * Initiates the device-code OAuth flow, waits for user authorization, and
 * stores the resulting credential in the CLEO pool. Returns a LAFS-shaped
 * result envelope — callers are responsible for printing it.
 *
 * Only `'anthropic'` is supported in the MVP. All other providers return an
 * `E_NOT_IMPLEMENTED` error envelope.
 *
 * @param provider - Provider name passed on the CLI (`anthropic`, etc.).
 * @param opts - Subcommand options (`--label`).
 * @returns LAFS-shaped success or error result.
 * @task T9266
 */
export async function runLlmLogin(
  provider: string,
  opts: LlmLoginOptions,
): Promise<LlmLoginResult> {
  const meta = { operation: 'llm.login', timestamp: new Date().toISOString() };

  if (provider !== 'anthropic') {
    return {
      success: false,
      error: {
        code: 'E_NOT_IMPLEMENTED',
        codeName: 'E_NOT_IMPLEMENTED',
        message:
          `OAuth device-code login for '${provider}' is not yet wired. ` +
          `'anthropic' is the only supported provider in the current MVP. ` +
          `To add credentials for other providers use 'cleo llm add <provider> --api-key-stdin'.`,
      },
      meta,
    };
  }

  const cfg = getAnthropicDeviceCodeConfig();

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
        message: `Failed to initiate device-code OAuth flow: ${msg}`,
      },
      meta,
    };
  }

  // Print instructions to stderr so they don't pollute stdout JSON output.
  process.stderr.write('\n');
  process.stderr.write(
    `  Visit:      ${startResp.verificationUriComplete ?? startResp.verificationUri}\n`,
  );
  process.stderr.write(`  Enter code: ${startResp.userCode}\n`);
  process.stderr.write('\n');
  process.stderr.write(
    `  Waiting for authorization (up to ${Math.round(startResp.expiresIn / 60)} min)...\n`,
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
        message: `Polling for device code token failed: ${msg}`,
      },
      meta,
    };
  }

  process.stderr.write('\r  Authorization approved.              \n\n');

  const label = opts.label ?? 'oauth-login';
  const expiresAt =
    typeof tokenResp.expiresIn === 'number' ? Date.now() + tokenResp.expiresIn * 1000 : undefined;

  try {
    await addCredential({
      provider: 'anthropic',
      label,
      authType: 'oauth',
      accessToken: tokenResp.accessToken,
      refreshToken: tokenResp.refreshToken,
      expiresAt,
      priority: 10,
      source: 'oauth-device-code',
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
    data: {
      provider: 'anthropic',
      label,
      expiresIn: tokenResp.expiresIn,
    },
    meta,
  };
}
