/**
 * `harness` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9425).
 *
 * Captures which harness CLEO should consider "active" for spawn-prompt
 * resolution and status reporting. Two operator-visible values are
 * accepted today:
 *   - `'pi'`          — the native CLEO Pi binary harness (default for
 *                       headless installs and Docker tasks).
 *   - `'claude-code'` — Claude Code CLI as the harness (auto-injects
 *                       `AGENTS.md`, triggers tier-1 dedup).
 *
 * V2 additions (T9610):
 *   - `isConfigured()` — returns `true` when `harness.active` is set (HARN-6).
 *   - Pi URL prompt when `pi` is selected (HARN-3).
 *   - Claude Code note when `claude-code` is selected (HARN-4).
 *   - Section description printed before prompts (GEN-6).
 *
 * The wizard surfaces the *currently active* harness from `CLEO_HARNESS`
 * (falling back to `'unknown'` — mirrors `packages/core/src/status/index.ts`)
 * and then asks the operator to pick the canonical value. The selection
 * lands in the **global** config under `harness.active` via
 * {@link setConfigValue} — the same scope `identity` uses for `agent.name`
 * so the choice persists across projects without leaking into per-project
 * configs.
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.harness` →
 *     persist that value to global config; no prompts.
 *   - Missing `--harness` under `--non-interactive` →
 *     section short-circuits with error.
 *
 * @task T9425
 * @task T9610
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.5 (HARN-1 through HARN-6)
 * @see docs/plans/E-CONFIG-AUTH-UNIFY.md §5.3 T-E3-6
 */

import { getConfigValue, setConfigValue } from '../../config.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/**
 * Default Pi process URL (HARN-3).
 *
 * Used as the default when prompting for the Pi URL.
 */
const DEFAULT_PI_URL = 'http://localhost:7800';

/**
 * Allowed harness values the wizard offers + persists.
 *
 * Kept aligned with {@link CleoStatus.harness.active} so any value written
 * here round-trips cleanly through `cleo status`.
 */
const HARNESS_CHOICES = ['pi', 'claude-code'] as const;

/**
 * Surface-facing harness value.
 *
 * Wider than the internal `HarnessHint` union because the wizard only asks
 * about the operator's _intent_ (Pi vs. Claude Code). Plumbing `generic`/`bare`
 * remains a job for `cleo orchestrate spawn` and the harness-hint resolver.
 */
export type WizardHarness = (typeof HARNESS_CHOICES)[number];

/**
 * Validate a URL string is a valid HTTP(S) URL.
 *
 * Used for Pi URL validation per HARN-3.
 *
 * @param raw - String to validate.
 * @returns `true` when the string is a valid HTTP or HTTPS URL.
 * @internal
 */
function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build the `harness` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the harness section.
 * @task T9425
 * @task T9610
 */
export function createHarnessSection(): WizardSectionRunner {
  return {
    section: 'harness',
    title: 'Active harness (Pi vs Claude Code)',
    optional: true,

    /**
     * Returns `true` when `harness.active` is set in global config (HARN-6).
     *
     * @param options - Current invocation options (for `projectRoot`).
     * @returns `true` when already configured.
     */
    async isConfigured(options: WizardOptions): Promise<boolean> {
      const resolved = await getConfigValue<string>('harness.active', options.projectRoot);
      return typeof resolved.value === 'string' && resolved.value.trim().length > 0;
    },

    async run(io: WizardIO, options: WizardOptions) {
      // GEN-6: Section description.
      io.info(
        'Configures the active harness written to `harness.active` in the global config.\n' +
          'Pi harness is recommended for headless/Docker environments.\n' +
          'Claude Code harness auto-injects AGENTS.md and triggers tier-1 dedup.',
      );

      // GEN-7 / HARN-1: Display current harness.
      const current = readActiveHarness();
      io.info(`Current harness: ${current}`);

      let choice: WizardHarness | undefined;

      if (options.nonInteractive === true) {
        if (!options.harness) {
          throw new Error(
            'E_SETUP_MISSING_FLAG: --section harness --non-interactive requires --harness <pi|claude-code>',
          );
        }
        choice = options.harness;
      } else {
        choice = await io.select<WizardHarness>(
          'Pick the active harness (pi|claude-code)',
          HARNESS_CHOICES,
        );
      }

      await setConfigValue('harness.active', choice, options.projectRoot, { global: true });

      const fragments: string[] = [`set harness.active=${choice} (was ${current})`];

      // HARN-3: Pi URL prompt when pi is selected.
      if (choice === 'pi') {
        if (options.nonInteractive === true) {
          // Non-interactive: no URL prompt; use default.
          io.info(
            `Pi URL defaults to ${DEFAULT_PI_URL}. Set CLEO_PI_URL or run 'cleo setup --section harness' to change.`,
          );
        } else {
          const currentPiUrl = await getConfigValue<string>('harness.piUrl', options.projectRoot);
          const piUrlDefault =
            typeof currentPiUrl.value === 'string' && currentPiUrl.value.trim().length > 0
              ? currentPiUrl.value
              : DEFAULT_PI_URL;
          io.info(`Current Pi URL: ${piUrlDefault}`);

          const rawPiUrl = (await io.prompt(`Pi process URL [default: ${piUrlDefault}]:`)).trim();
          const piUrl = rawPiUrl === '' ? piUrlDefault : rawPiUrl;

          if (!isValidHttpUrl(piUrl)) {
            io.warn(
              `Invalid Pi URL '${piUrl}' — must be a valid HTTP(S) URL. Using default: ${piUrlDefault}`,
            );
            await setConfigValue('harness.piUrl', piUrlDefault, options.projectRoot, {
              global: true,
            });
            fragments.push(`set harness.piUrl=${piUrlDefault} (invalid input, used default)`);
          } else {
            await setConfigValue('harness.piUrl', piUrl, options.projectRoot, { global: true });
            fragments.push(`set harness.piUrl=${piUrl}`);
          }
        }
      }

      // HARN-4: Claude Code note when claude-code is selected.
      if (choice === 'claude-code') {
        io.info('Ensure `claude` is on your PATH. Run `cleo harness doctor` to verify.');
      }

      return {
        changed: true,
        summary: fragments.join(' + '),
      };
    },
  };
}

/**
 * Read the active harness for display purposes using the same layered chain as
 * {@link detectHarness} in `packages/core/src/status/index.ts`.
 *
 * Synchronous (reads env only; skips the async global-config layer) so the
 * wizard can call it without `await` before the prompt is shown.  The
 * full async chain runs at status-snapshot time via `cleo status`.
 *
 * Resolution order (first match wins):
 * 1. `CLEO_HARNESS` env var — explicit override.
 * 2. `CLAUDECODE=1` → `'claude-code'`.
 * 3. `CLEO_PI=1`    → `'pi'`.
 * 4. Fallback: `'unknown'`.
 *
 * @internal
 */
function readActiveHarness(): WizardHarness | 'unknown' {
  const raw = process.env['CLEO_HARNESS'];
  if (raw === 'pi' || raw === 'claude-code') return raw;
  if (process.env['CLAUDECODE'] === '1') return 'claude-code';
  if (process.env['CLEO_PI'] === '1') return 'pi';
  return 'unknown';
}
