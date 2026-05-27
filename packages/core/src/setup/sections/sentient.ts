/**
 * `sentient` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Toggles the two operator-visible sentient knobs:
 *   1. The daemon kill-switch (`killSwitch: false` ⇒ daemon is allowed
 *      to run; `true` ⇒ paused).
 *   2. Tier-2 proposal generation (`tier2Enabled`).
 *
 * Both fields live in `<projectRoot>/.cleo/sentient-state.json` and are
 * mutated via {@link patchSentientState} so the on-disk shape matches
 * the format the daemon expects.
 *
 * V2 additions (T9610):
 *   - `isConfigured()` — returns `true` when `sentient-state.json` exists (SENT-5).
 *   - Current state display before prompting (GEN-7 / SENT-1).
 *   - Section description printed before prompts (GEN-6).
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` → consume
 *     `options.sentientEnabled` / `options.tier2Enabled` when present;
 *     fields not supplied are left untouched.
 *
 * @task T9420
 * @task T9610
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.4
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveOrCwd } from '../../paths.js';
import { SENTIENT_STATE_FILE } from '../../sentient/daemon.js';
import { patchSentientState, readSentientState } from '../../sentient/state.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/**
 * Build the `sentient` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the sentient section.
 * @task T9420
 * @task T9610
 */
export function createSentientSection(): WizardSectionRunner {
  return {
    section: 'sentient',
    title: 'Sentient daemon + Tier-2 proposals',
    optional: true,

    /**
     * Returns `true` when `sentient-state.json` exists in the project root (SENT-5).
     *
     * @param options - Current invocation options (for `projectRoot`).
     * @returns `true` when already configured.
     */
    async isConfigured(options: WizardOptions): Promise<boolean> {
      const statePath = join(resolveOrCwd(options.projectRoot), SENTIENT_STATE_FILE);
      return existsSync(statePath);
    },

    async run(io: WizardIO, options: WizardOptions) {
      const statePath = join(resolveOrCwd(options.projectRoot), SENTIENT_STATE_FILE);

      // GEN-6: Section description.
      io.info(
        'Configures the CLEO sentient daemon and Tier-2 autonomous proposal generation.\n' +
          'State is stored in `.cleo/sentient-state.json` in the project root.\n' +
          'Tier-2 proposals are disabled by default for safety.',
      );

      // GEN-7 / SENT-1: Display current state.
      if (existsSync(statePath)) {
        try {
          const state = await readSentientState(statePath);
          const daemonActive = !state.killSwitch;
          const t2Active = state.tier2Enabled ?? false;
          const lastTick =
            state.lastTickAt != null ? new Date(state.lastTickAt).toISOString() : 'never';
          io.info(
            `Current sentient state: daemon=${daemonActive ? 'enabled' : 'disabled'}, tier2=${t2Active ? 'enabled' : 'disabled'}, last-tick=${lastTick}`,
          );
        } catch {
          io.info('Current sentient state: (could not read state file)');
        }
      } else {
        io.info('Current sentient state: (not configured — state file does not exist)');
      }

      let daemonEnabled: boolean | undefined;
      let tier2Enabled: boolean | undefined;

      if (options.nonInteractive === true) {
        daemonEnabled = options.sentientEnabled;
        tier2Enabled = options.tier2Enabled;
        if (daemonEnabled === undefined && tier2Enabled === undefined) {
          throw new Error(
            'E_SETUP_MISSING_FLAG: --section sentient --non-interactive requires --sentient <on|off> or --tier2 <on|off>',
          );
        }
      } else {
        daemonEnabled = await io.confirm(
          'Enable the sentient daemon (auto-tick reconciler)?',
          false,
        );
        tier2Enabled = await io.confirm(
          'Enable Tier-2 autonomous proposals (off by default)?',
          false,
        );
      }

      const patch: Parameters<typeof patchSentientState>[1] = {};
      if (daemonEnabled !== undefined) {
        // Daemon "enabled" maps to kill-switch FALSE.
        patch.killSwitch = !daemonEnabled;
        patch.killSwitchReason = daemonEnabled ? undefined : 'cleo setup: operator disabled';
      }
      if (tier2Enabled !== undefined) {
        patch.tier2Enabled = tier2Enabled;
      }

      await patchSentientState(statePath, patch);

      const fragments: string[] = [];
      if (daemonEnabled !== undefined) {
        fragments.push(`daemon ${daemonEnabled ? 'enabled' : 'disabled'}`);
      }
      if (tier2Enabled !== undefined) {
        fragments.push(`tier2 ${tier2Enabled ? 'enabled' : 'disabled'}`);
      }
      return { changed: true, summary: fragments.join(' + ') };
    },
  };
}
