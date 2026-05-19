/**
 * `integrations` setup wizard section (E-CLEO-SETUP-V2 / T9608).
 *
 * Captures operator intent for three integration subsystems:
 *
 *   1. **SignalDock** — the cloud messaging transport.
 *      - `signaldock.enabled` (global config, boolean)
 *      - `signaldock.endpoint` (global config, string — defaults to
 *        `http://localhost:4000` when not supplied)
 *
 *   2. **Studio** — the local web UI.
 *      - `studio.enabled` (global config, boolean)
 *      - After enabling, the section emits: "Start Studio with `cleo studio start`."
 *
 *   3. **Conduit** — the local message-bus DB.
 *      - `conduit.dbPath` (project config, string — must be an absolute path)
 *      - Blank input ⇒ the built-in default is used; nothing is persisted.
 *
 * The section emits the current state of all three subsystems before
 * prompting so operators can confirm idempotently.
 *
 * No network calls are made inside this section — connectivity validation
 * is delegated to the `verification` section (T9594).
 *
 * Non-interactive contract (INTG-5):
 *   - `options.nonInteractive === true` → apply each of
 *     `signaldockEnabled`, `signaldockEndpoint`, `studioEnabled`, and
 *     `conduitPath` when present; fields not supplied are left untouched.
 *   - All four absent under non-interactive → short-circuit silently.
 *
 * `isConfigured()` (INTG-6):
 *   - Returns `true` when `signaldock.enabled` is **explicitly set** in
 *     the global config (even when the stored value is `false`), because
 *     an explicit `false` means the operator intentionally disabled it.
 *
 * @task T9608
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.8, §5.2 T9593
 */

import { getConfigValue, setConfigValue } from '../../config.js';
import type {
  WizardIO,
  WizardOptions,
  WizardSectionResult,
  WizardSectionRunner,
} from '../wizard.js';

/** Default SignalDock endpoint shown to the operator. */
const DEFAULT_SIGNALDOCK_ENDPOINT = 'http://localhost:4000';

/**
 * Validate that `url` is an HTTP or HTTPS URL.
 *
 * Used to guard the SignalDock endpoint prompt — the section MUST NOT
 * make network calls (INTG-7), so only syntactic validation is performed.
 *
 * @param url - Raw user input to validate.
 * @returns `true` when `url` is a valid HTTP(S) URL.
 * @internal
 */
function isValidHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate that `path` is an absolute filesystem path.
 *
 * @param p - Raw user input to validate.
 * @returns `true` when `p` starts with `/` (Unix absolute path).
 * @internal
 */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/');
}

/**
 * Build the `integrations` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the integrations section.
 * @task T9608
 */
export function createIntegrationsSection(): WizardSectionRunner {
  return {
    section: 'integrations',
    title: 'Integrations (SignalDock + Studio + Conduit)',
    optional: true,

    /**
     * Return `true` when `signaldock.enabled` is explicitly set in global
     * config (INTG-6). An explicit `false` still counts as "configured" —
     * it means the operator intentionally opted out.
     */
    async isConfigured(options: WizardOptions): Promise<boolean> {
      const resolved = await getConfigValue<boolean>('signaldock.enabled', options.projectRoot);
      // `resolved.source === 'default'` means the key has never been written;
      // any other source (global, project, env) means it was set explicitly.
      return resolved.source !== 'default' && resolved.value !== undefined;
    },

    async run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult> {
      // ── Emit current state (INTG-1) ──────────────────────────────────────
      const [sdEnabled, sdEndpoint, stEnabled] = await Promise.all([
        getConfigValue<boolean>('signaldock.enabled', options.projectRoot),
        getConfigValue<string>('signaldock.endpoint', options.projectRoot),
        getConfigValue<boolean>('studio.enabled', options.projectRoot),
      ]);

      const sdEnabledLabel = sdEnabled.value === undefined ? 'not set' : String(sdEnabled.value);
      const sdEndpointLabel = sdEndpoint.value ?? '(default)';
      const stEnabledLabel = stEnabled.value === undefined ? 'not set' : String(stEnabled.value);

      io.info(
        `Current integrations state:\n` +
          `  signaldock.enabled  = ${sdEnabledLabel} (source: ${sdEnabled.source})\n` +
          `  signaldock.endpoint = ${sdEndpointLabel} (source: ${sdEndpoint.source})\n` +
          `  studio.enabled      = ${stEnabledLabel} (source: ${stEnabled.source})`,
      );

      const fragments: string[] = [];

      if (options.nonInteractive === true) {
        // ── Non-interactive path (INTG-5) ──────────────────────────────────
        const { signaldockEnabled, signaldockEndpoint, studioEnabled, conduitPath } = options;

        if (
          signaldockEnabled === undefined &&
          signaldockEndpoint === undefined &&
          studioEnabled === undefined &&
          conduitPath === undefined
        ) {
          return {
            changed: false,
            summary: 'skipped (non-interactive: no integrations flags supplied)',
          };
        }

        if (signaldockEnabled !== undefined) {
          await setConfigValue('signaldock.enabled', signaldockEnabled, options.projectRoot, {
            global: true,
          });
          fragments.push(`signaldock.enabled=${signaldockEnabled}`);
        }

        if (signaldockEndpoint !== undefined) {
          if (!isValidHttpUrl(signaldockEndpoint)) {
            throw new Error(
              `E_SETUP_INVALID_VALUE: signaldockEndpoint '${signaldockEndpoint}' is not a valid HTTP(S) URL`,
            );
          }
          await setConfigValue('signaldock.endpoint', signaldockEndpoint, options.projectRoot, {
            global: true,
          });
          fragments.push(`signaldock.endpoint=${signaldockEndpoint}`);
        }

        if (studioEnabled !== undefined) {
          await setConfigValue('studio.enabled', studioEnabled, options.projectRoot, {
            global: true,
          });
          fragments.push(`studio.enabled=${studioEnabled}`);
          if (studioEnabled) {
            io.info('Start Studio with `cleo studio start`.');
          }
        }

        if (conduitPath !== undefined) {
          if (!isAbsolutePath(conduitPath)) {
            throw new Error(
              `E_SETUP_INVALID_VALUE: conduitPath '${conduitPath}' must be an absolute path`,
            );
          }
          await setConfigValue('conduit.dbPath', conduitPath, options.projectRoot, {
            global: false,
          });
          fragments.push(`conduit.dbPath=${conduitPath}`);
        }

        return {
          changed: fragments.length > 0,
          summary: fragments.length > 0 ? fragments.join(' + ') : 'no changes',
        };
      }

      // ── Interactive path (INTG-2, INTG-3, INTG-4) ────────────────────────

      // 1. SignalDock enable (INTG-2)
      const wantsSignalDock = await io.confirm('Enable SignalDock transport?', false);
      await setConfigValue('signaldock.enabled', wantsSignalDock, options.projectRoot, {
        global: true,
      });
      fragments.push(`signaldock.enabled=${wantsSignalDock}`);

      if (wantsSignalDock) {
        // Prompt for endpoint URL; keep re-prompting until a valid URL is entered.
        let endpoint = '';
        while (true) {
          const raw = (
            await io.prompt(`SignalDock endpoint URL [${DEFAULT_SIGNALDOCK_ENDPOINT}]:`)
          ).trim();
          endpoint = raw === '' ? DEFAULT_SIGNALDOCK_ENDPOINT : raw;
          if (isValidHttpUrl(endpoint)) break;
          io.warn(`'${endpoint}' is not a valid HTTP(S) URL — please try again.`);
        }
        await setConfigValue('signaldock.endpoint', endpoint, options.projectRoot, {
          global: true,
        });
        fragments.push(`signaldock.endpoint=${endpoint}`);
      }

      // 2. Studio enable (INTG-3)
      const wantsStudio = await io.confirm('Enable Studio web UI?', false);
      await setConfigValue('studio.enabled', wantsStudio, options.projectRoot, {
        global: true,
      });
      fragments.push(`studio.enabled=${wantsStudio}`);
      if (wantsStudio) {
        io.info('Start Studio with `cleo studio start`.');
      }

      // 3. Conduit DB path (INTG-4)
      let conduitWritten = false;
      while (true) {
        const raw = (
          await io.prompt('Custom Conduit DB path? [leave blank to use default]')
        ).trim();

        if (raw === '') {
          // Blank ⇒ use default; nothing persisted.
          break;
        }

        if (!isAbsolutePath(raw)) {
          io.warn(
            `'${raw}' is not an absolute path — please supply an absolute path or leave blank.`,
          );
          continue;
        }

        await setConfigValue('conduit.dbPath', raw, options.projectRoot, { global: false });
        fragments.push(`conduit.dbPath=${raw}`);
        conduitWritten = true;
        break;
      }

      if (!conduitWritten) {
        fragments.push('conduit.dbPath=default');
      }

      return {
        changed: true,
        summary: fragments.join(' + '),
      };
    },
  };
}
