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
import { ExitCode } from '@cleocode/contracts';
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
 * Exit codes of the cloud vault refusals a script may want to branch on
 * (T12976): each is distinct from a plain failure (1) and from the others.
 */
const VAULT_REFUSAL_EXIT_CODES: Readonly<Record<string, number>> = {
  E_NEXUS_VAULT_LEASE_HELD: ExitCode.LOCK_TIMEOUT,
  E_NEXUS_VAULT_STORE_BUSY: ExitCode.LOCK_TIMEOUT,
  E_NEXUS_VAULT_BEHIND: ExitCode.VERSION_CONFLICT,
  E_NEXUS_VAULT_LOCAL_CHANGES: ExitCode.CONCURRENT_MODIFICATION,
  E_NEXUS_VAULT_VERIFY_FAILED: ExitCode.CHECKSUM_MISMATCH,
  E_NEXUS_VAULT_TARGET_OCCUPIED: ExitCode.ID_COLLISION,
  // `cleo cloud restore <name>` (T13102).
  E_NEXUS_PROJECT_NOT_FOUND: ExitCode.NOT_FOUND,
  E_NEXUS_PROJECT_AMBIGUOUS: ExitCode.VALIDATION_ERROR,
};

/**
 * Emit a Nexus flow failure (LAFS error envelope or a human line) and exit.
 * Invalid input exits 6; the vault refusals exit with their own codes
 * (lease held / store busy 7, behind 23, local changes 21, verify failed 20,
 * restore target holds another project 22; no project by that name 4,
 * a name several projects share 6); everything else exits 1.
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
      : (VAULT_REFUSAL_EXIT_CODES[code ?? ''] ?? 1);
  // Only an error that opts in with an explicit, secret-free `publicDetails`
  // (`cleo cloud status` offline: the local facts, contract §4.4) has its
  // details forwarded; an arbitrary error's `details` never reaches the envelope.
  const details =
    err instanceof Error &&
    'publicDetails' in err &&
    typeof err.publicDetails === 'object' &&
    err.publicDetails
      ? err.publicDetails
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
 * Print a Nexus flow's warnings to stderr, one `warning:` line each. They also
 * travel in the result envelope's `data.warnings`.
 *
 * @param warnings - Warnings from the result (secret-free).
 */
export function writeNexusWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);
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
  // A staging test-bearer login (CLEO_NEXUS_TEST_BEARER) shows no code.
  let codeShown = false;
  const hooks = {
    apiUrl: nexusApiUrlArg(args),
    onCode: (code: DeviceCodePromptInfo) => {
      codeShown = true;
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
      if (!readOnly) {
        // T12952: login is the only setup step, so it also attaches this
        // device's global store (the main brain) to the account.
        const { attachNexusGlobalStore } = await import(
          /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-home.js'
        );
        try {
          const global = await attachNexusGlobalStore({ apiUrl: hooks.apiUrl });
          result = { ...result, warnings: [...result.warnings, ...global.warnings] };
        } catch (err) {
          result = {
            ...result,
            warnings: [
              ...result.warnings,
              `signed in, but attaching this device's global store failed (${err instanceof Error ? err.message : String(err)}); run \`cleo login nexus\` again`,
            ],
          };
        }
      }
    } else {
      if (name !== undefined) {
        process.stderr.write(
          'warning: --name needs device credentials, which CLEO_NEXUS_DEVICE=0 turns off; ignored\n',
        );
      }
      const { NEXUS_TEST_BEARER_ENV, W_NEXUS_TEST_BEARER_IGNORED } = await import(
        /* webpackIgnore: true */ '@cleocode/core/cloud/nexus-enrol.js'
      );
      if ((process.env[NEXUS_TEST_BEARER_ENV]?.trim() ?? '') !== '') {
        // Names the variable only: its value is a secret.
        process.stderr.write(
          `warning: ${W_NEXUS_TEST_BEARER_IGNORED}: ${NEXUS_TEST_BEARER_ENV} needs device credentials, which CLEO_NEXUS_DEVICE turns off; ignored\n`,
        );
      }
      result = await loginToNexus(hooks);
    }
    if (codeShown) writeDeviceCodeApproved(SERVICE_NAME);
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
  return `Signed in to ${r.apiUrl} as ${who}${org}.${device}${nexusAccountSetupLine(r)}`;
}

/** The account-setup tail of {@link nexusLoginSummary} (T13100); the warnings carry the detail. */
function nexusAccountSetupLine(r: NexusLoginResult): string {
  const account = r.account;
  if (account === undefined) return '';
  switch (account.status) {
    case 'ready':
    case 'skipped':
      return ` ${account.summary}`;
    case 'unsupported':
      return ' Encrypted backups are not available on this server (see warnings).';
    case 'failed':
      return ` Encrypted backups are NOT set up: step ${account.step} failed (see warnings for the fix).`;
  }
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
