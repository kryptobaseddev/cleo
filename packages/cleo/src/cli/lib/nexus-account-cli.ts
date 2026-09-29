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
  const exitCode = code === 'E_NEXUS_INVALID_API_URL' || code === 'E_NEXUS_INVALID_LABEL' ? 6 : 1;
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
  const noBrowser = negatedFlag(args, 'browser');
  try {
    const result = await loginToNexus({
      apiUrl: nexusApiUrlArg(args),
      onCode: (code) => {
        writeDeviceCodePrompt(code, SERVICE_NAME);
        if (!noBrowser) openBrowser(code.verificationUriComplete ?? code.verificationUri);
      },
      onPending: writeDeviceCodePending,
    });
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
  return `Signed in to ${r.apiUrl} as ${who}${org}.`;
}
