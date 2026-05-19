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
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9425
 * @epic T9402
 * @see docs/plans/E-CONFIG-AUTH-UNIFY.md §5.3 T-E3-6
 */

import { setConfigValue } from '../../config.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

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
 * Build the `harness` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the harness section.
 * @task T9425
 */
export function createHarnessSection(): WizardSectionRunner {
  return {
    section: 'harness',
    title: 'Active harness (Pi vs Claude Code)',
    optional: true,
    async run(io: WizardIO, options: WizardOptions) {
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

      return {
        changed: true,
        summary: `set harness.active=${choice} (was ${current})`,
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
