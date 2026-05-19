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
 * Non-interactive contract:
 *   - `options.nonInteractive === true` → consume
 *     `options.sentientEnabled` / `options.tier2Enabled` when present;
 *     fields not supplied are left untouched.
 *
 * @task T9420
 * @epic T9402
 */

import { join } from 'node:path';
import { SENTIENT_STATE_FILE } from '../../sentient/daemon.js';
import { patchSentientState } from '../../sentient/state.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/**
 * Build the `sentient` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the sentient section.
 * @task T9420
 */
export function createSentientSection(): WizardSectionRunner {
  return {
    section: 'sentient',
    title: 'Sentient daemon + Tier-2 proposals',
    optional: true,
    async run(io: WizardIO, options: WizardOptions) {
      const statePath = join(options.projectRoot ?? process.cwd(), SENTIENT_STATE_FILE);

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
