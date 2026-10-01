/**
 * `nexus-account` setup wizard section: optionally sign in to a Cleo Nexus
 * account.
 *
 * Runs the SAME engine as `cleo login nexus`: device enrolment by default,
 * or {@link loginToNexus} with `CLEO_NEXUS_DEVICE=0` (both drive the shared
 * RFC 8628 device-code runner); only the I/O differs: the verification URL
 * and user code go through {@link WizardIO.info}.
 *
 * - Optional: skipping it leaves CLEO fully functional offline.
 * - Idempotent: `isConfigured()` is `true` once a device credential (or,
 *   with `CLEO_NEXUS_DEVICE=0`, a session) is stored for the default API
 *   origin, so a re-run skips it unless `--reset`.
 * - Non-interactive runs skip it: the device-code grant needs a person to
 *   approve the code in a browser.
 *
 * @task T12712
 * @epic T12322
 */

import type { NexusLoginResult } from '@cleocode/contracts';
import {
  loginToNexus,
  type NexusLoginOptions,
  resolveNexusApiUrl,
} from '../../cloud/nexus-auth.js';
import { FileNexusTokenStore, nexusOriginKey } from '../../cloud/nexus-credentials.js';
import {
  isNexusDeviceEnabled,
  NexusDeviceStore,
  SealedNexusDevice,
} from '../../cloud/nexus-device.js';
import type {
  WizardIO,
  WizardOptions,
  WizardSectionResult,
  WizardSectionRunner,
} from '../wizard.js';

/** Injectable dependencies (tests pass a stub login). */
export interface NexusAccountSectionDeps {
  /** Login engine; defaults to device enrolment, or {@link loginToNexus} with `CLEO_NEXUS_DEVICE=0`. */
  login?: typeof loginToNexus;
}

/**
 * The login `cleo login nexus` runs: device enrolment, unless
 * `CLEO_NEXUS_DEVICE=0` keeps the 9.24 session login (T12904).
 *
 * @param opts - Device-code hooks and test overrides.
 * @returns The secret-free login result.
 */
async function defaultLogin(opts: NexusLoginOptions = {}): Promise<NexusLoginResult> {
  if (!isNexusDeviceEnabled()) return loginToNexus(opts);
  const { loginToNexusDevice } = await import('../../cloud/nexus-enrol.js');
  return loginToNexusDevice({
    ...(opts.apiUrl !== undefined ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.store ? { store: opts.store } : {}),
    ...(opts.onCode ? { onCode: opts.onCode } : {}),
    ...(opts.onPending ? { onPending: opts.onPending } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.sleep ? { pollSleep: opts.sleep } : {}),
  });
}

/**
 * Build the `nexus-account` section runner.
 *
 * @param deps - Optional login override.
 * @returns A {@link WizardSectionRunner}.
 */
export function createNexusAccountSection(deps: NexusAccountSectionDeps = {}): WizardSectionRunner {
  const login = deps.login ?? defaultLogin;
  return {
    section: 'nexus-account',
    title: 'Cleo Nexus account (optional)',
    optional: true,

    async isConfigured(): Promise<boolean> {
      try {
        const apiUrl = resolveNexusApiUrl();
        // A stored device credential counts whatever CLEO_NEXUS_DEVICE says.
        const origin = nexusOriginKey(apiUrl);
        for (const d of await new NexusDeviceStore().list()) {
          if (d instanceof SealedNexusDevice && d.origin === origin && d.currentBearer()) {
            return true;
          }
        }
        return (await new FileNexusTokenStore().get(apiUrl)) !== null;
      } catch {
        return false;
      }
    },

    async run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult> {
      if (options.nonInteractive === true) {
        return {
          changed: false,
          summary: 'skipped (non-interactive; run `cleo login nexus` to sign in)',
        };
      }
      const wanted = await io.confirm(
        'Sign in to a Cleo Nexus account now? (sync and web access; you can do this later with `cleo login nexus`)',
        false,
      );
      if (!wanted) return { changed: false, summary: 'skipped' };

      const result = await login({
        onCode: (code) => {
          io.info(`Visit:      ${code.verificationUriComplete ?? code.verificationUri}`);
          io.info(`Enter code: ${code.userCode}`);
          io.info(`Waiting for approval (up to ${Math.round(code.expiresIn / 60)} min)...`);
        },
      });
      for (const warning of result.warnings) io.warn(warning);
      const who = result.user?.email ?? 'your account';
      return { changed: true, summary: `signed in to ${result.apiUrl} as ${who}` };
    },
  };
}
