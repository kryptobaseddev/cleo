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

import type { NexusLoginResult } from '@cleocode/contracts';
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
    code === 'E_NEXUS_DEVICE_REQUIRED'
      ? 6
      : 1;
  cliError(
    err instanceof Error ? err.message : String(err),
    exitCode,
    { name: code ?? 'E_NEXUS_REQUEST_FAILED', ...(fix ? { fix } : {}) },
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
        fix: 'set CLEO_NEXUS_DEVICE=1 to enrol a read-only device, or log in without --read-only',
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
          'warning: --name needs device credentials (CLEO_NEXUS_DEVICE=1); ignored\n',
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
