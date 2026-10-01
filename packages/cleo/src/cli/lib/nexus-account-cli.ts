/**
 * Thin CLI glue shared by the Cleo Nexus account commands: `cleo login nexus`,
 * `cleo logout nexus`, `cleo project link`. The flows live in
 * `@cleocode/core/cloud/nexus-*.js`; this module only reads flags, wires the
 * device-code prompt to stderr, and emits results and failures.
 *
 * No function here receives or prints a token.
 *
 * @task T12712
 */

import type { NexusDeviceLogoutResult, NexusLoginResult } from '@cleocode/contracts';
import { cliError, cliOutput, humanLine, isHumanOutput } from '../renderers/index.js';
import {
  type DeviceCodePromptInfo,
  writeDeviceCodeApproved,
  writeDeviceCodeInterrupted,
  writeDeviceCodePending,
  writeDeviceCodePrompt,
} from './device-code-prompt.js';
import { negatedFlag } from './negated-flag.js';

/** Name shown in the device-code prompt. */
const SERVICE_NAME = 'Cleo Nexus';

/** Shared `--api-url` flag definition. */
export const NEXUS_API_URL_ARG = {
  type: 'string',
  description:
    'Cleo Nexus API URL (default: $CLEO_NEXUS_API_URL, else https://api.cleocode.dev; staging: https://api.staging.cleocode.dev).',
} as const;

/**
 * The `--api-url` value, or `undefined` for the default.
 *
 * @param args - Parsed citty args.
 * @returns The raw flag value.
 */
export function nexusApiUrlArg(args: Readonly<Record<string, unknown>>): string | undefined {
  const raw = args['api-url'];
  return typeof raw === 'string' && raw !== '' ? raw : undefined;
}

/**
 * Emit a Nexus flow failure (LAFS error envelope or a human line) and exit.
 * Invalid input exits 6; everything else exits 1.
 *
 * @param err - The thrown error.
 * @param operation - LAFS operation id.
 */
export function failNexus(err: unknown, operation: string): never {
  const code =
    err instanceof Error && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
  const fix =
    err instanceof Error && 'fix' in err && typeof err.fix === 'string' ? err.fix : undefined;
  const exitCode =
    code === 'E_NEXUS_INVALID_API_URL' ||
    code === 'E_NEXUS_INVALID_LABEL' ||
    code === 'E_NEXUS_DEVICE_REQUIRED' ||
    code === 'E_VALIDATION'
      ? 6
      : 1;
  // Structured, secret-free details some failures carry (e.g. `cleo cloud
  // status` offline: the local facts, contract §4.4).
  const details =
    err instanceof Error && 'details' in err && typeof err.details === 'object' && err.details
      ? err.details
      : undefined;
  cliError(
    err instanceof Error ? err.message : String(err),
    exitCode,
    {
      name: code ?? 'E_NEXUS_REQUEST_FAILED',
      ...(fix ? { fix } : {}),
      ...(details ? { details } : {}),
    },
    { operation },
  );
  process.exit(exitCode);
}

/**
 * Emit a result: one human line on a terminal, else the LAFS envelope.
 *
 * @param data - Result payload (secret-free).
 * @param summary - Human line.
 * @param command - Renderer command id.
 * @param operation - LAFS operation id.
 */
export function emitNexusResult(
  data: unknown,
  summary: string,
  command: string,
  operation: string,
): void {
  if (isHumanOutput()) humanLine(summary);
  else cliOutput(data, { command, operation });
}

/**
 * Run `cleo login nexus`: the core device-code engine with the shared stderr
 * prompt, opening the browser unless `--no-browser`.
 *
 * @param args - Parsed citty args (`--api-url`, `--no-browser`).
 * @param openBrowser - Browser opener (the one `cleo llm login` uses).
 * @returns The secret-free login result.
 */
export async function runNexusLogin(
  args: Readonly<Record<string, unknown>>,
  openBrowser: (url: string) => void,
): Promise<NexusLoginResult> {
  const { loginToNexus } = await import(
    /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-auth.js'
  );
  const { isNexusDeviceEnabled } = await import(
    /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-device.js'
  );
  const noBrowser = negatedFlag(args, 'browser');
  const hooks = {
    apiUrl: nexusApiUrlArg(args),
    onCode: (code: DeviceCodePromptInfo) => {
      writeDeviceCodePrompt(code, SERVICE_NAME);
      if (!noBrowser) openBrowser(code.verificationUriComplete ?? code.verificationUri);
    },
    onPending: writeDeviceCodePending,
  };
  const readOnly = args['read-only'] === true;
  const name = typeof args['name'] === 'string' && args['name'] !== '' ? args['name'] : undefined;
  if (readOnly && !isNexusDeviceEnabled()) {
    // Never fall back to a full-privilege session login when the user asked
    // for read-only (security review L1).
    throw Object.assign(
      new Error(
        '--read-only needs device credentials, which are not enabled; nothing was signed in',
      ),
      {
        code: 'E_NEXUS_DEVICE_REQUIRED',
        fix: 'unset CLEO_NEXUS_DEVICE (=0 turns device credentials off) to enrol a read-only device, or log in without --read-only',
      },
    );
  }
  try {
    let result: NexusLoginResult;
    if (isNexusDeviceEnabled()) {
      // Device credentials (T12868): enrol this machine; only the device
      // credential is stored.
      const { loginToNexusDevice } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-enrol.js'
      );
      result = await loginToNexusDevice({
        ...hooks,
        readOnly,
        ...(name !== undefined ? { name } : {}),
      });
    } else {
      if (name !== undefined) {
        process.stderr.write(
          'warning: --name needs device credentials, which CLEO_NEXUS_DEVICE=0 turns off; ignored\n',
        );
      }
      result = await loginToNexus(hooks);
    }
    writeDeviceCodeApproved(SERVICE_NAME);
    for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
    return result;
  } catch (err) {
    writeDeviceCodeInterrupted();
    throw err;
  }
}

/**
 * One human line for a login result.
 *
 * @param r - Login result.
 * @returns e.g. `Signed in to https://api.cleocode.dev as a@b.c (Personal).`
 */
export function nexusLoginSummary(r: NexusLoginResult): string {
  const who = r.user?.email ?? 'your account';
  const org = r.organization ? ` (${r.organization.name})` : '';
  const device = r.device
    ? ` This machine is device ${r.device.deviceId}${r.device.name ? ` (${r.device.name})` : ''}, profile ${r.device.profile ?? 'unknown'}.`
    : '';
  return `Signed in to ${r.apiUrl} as ${who}${org}.${device}`;
}

/**
 * One human line for a device logout: never claims a sign-out the server did
 * not confirm.
 *
 * @param r - Device logout result.
 * @returns e.g. `Signed out of https://api.cleocode.dev: 1 device confirmed.`
 */
export function nexusDeviceLogoutSummary(r: NexusDeviceLogoutResult): string {
  const count = (o: string): number => r.devices.filter((d) => d.outcome === o).length;
  const confirmed = count('confirmed');
  const open = r.devices.length - confirmed;
  const what = r.action === 'revoke' ? 'Revoke' : 'Sign-out';
  if (r.devices.length === 0 && r.session === null) {
    return r.warnings.length > 0
      ? `${what} on ${r.apiUrl}: nothing was sent (see warnings).`
      : `Not signed in to ${r.apiUrl}; nothing to do.`;
  }
  const parts: string[] = [];
  if (r.devices.length > 0)
    parts.push(`${confirmed} of ${r.devices.length} device request(s) confirmed`);
  if (open > 0) parts.push(`${open} NOT confirmed (see warnings)`);
  if (r.session !== null) parts.push(`9.24 session ${r.session.revocation}`);
  const notConfirmed =
    open > 0 || (r.devices.length > 0 && confirmed === 0) || r.session?.revocation === 'failed';
  const lead = notConfirmed ? `${what} NOT fully confirmed on` : `${what} confirmed on`;
  return `${lead} ${r.apiUrl}: ${parts.join('; ')}.`;
}

/**
 * Run `cleo logout nexus [--revoke]`, print warnings to stderr and emit the
 * result. It ends every stored device credential (sign-out, or revoke with
 * `--revoke`) and signs out a leftover 9.24 session, whatever
 * `CLEO_NEXUS_DEVICE` says.
 *
 * @param args - Parsed citty args (`--api-url`, `--revoke`).
 */
export async function runNexusDeviceLogout(args: Readonly<Record<string, unknown>>): Promise<void> {
  let result: NexusDeviceLogoutResult;
  try {
    const { logoutNexusDevice } = await import(
      /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-logout.js'
    );
    result = await logoutNexusDevice({
      apiUrl: nexusApiUrlArg(args),
      revoke: args['revoke'] === true,
    });
  } catch (err) {
    failNexus(err, 'logout.run');
  }
  for (const warning of result.warnings) process.stderr.write(`warning: ${warning}\n`);
  emitNexusResult(result, nexusDeviceLogoutSummary(result), 'logout', 'logout.run');
}
