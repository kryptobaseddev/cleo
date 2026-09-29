/**
 * `nexus-account` setup wizard section: optionally sign in to a Cleo Nexus
 * account.
 *
 * Runs the SAME engine as `cleo login nexus` ({@link loginToNexus}, which
 * drives the shared RFC 8628 device-code runner); only the I/O differs: the
 * verification URL and user code go through {@link WizardIO.info}.
 *
 * - Optional: skipping it leaves CLEO fully functional offline.
 * - Idempotent: `isConfigured()` is `true` once a session is stored for the
 *   default API origin, so a re-run skips it unless `--reset`.
 * - Non-interactive runs skip it: the device-code grant needs a person to
 *   approve the code in a browser.
 *
 * @task T12712
 * @epic T12322
 */

import { loginToNexus, resolveNexusApiUrl } from '../../cloud/nexus-auth.js';
import { FileNexusTokenStore } from '../../cloud/nexus-credentials.js';
import type {
  WizardIO,
  WizardOptions,
  WizardSectionResult,
  WizardSectionRunner,
} from '../wizard.js';

/** Injectable dependencies (tests pass a stub login). */
export interface NexusAccountSectionDeps {
  /** Login engine; defaults to {@link loginToNexus}. */
  login?: typeof loginToNexus;
}

/**
 * Build the `nexus-account` section runner.
 *
 * @param deps - Optional login override.
 * @returns A {@link WizardSectionRunner}.
 */
export function createNexusAccountSection(deps: NexusAccountSectionDeps = {}): WizardSectionRunner {
  const login = deps.login ?? loginToNexus;
  return {
    section: 'nexus-account',
    title: 'Cleo Nexus account (optional)',
    optional: true,

    async isConfigured(): Promise<boolean> {
      try {
        return (await new FileNexusTokenStore().get(resolveNexusApiUrl())) !== null;
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
