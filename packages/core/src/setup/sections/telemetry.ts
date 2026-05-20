/**
 * `telemetry` setup wizard section (E-SKILLS-OWNER-CI / T9673).
 *
 * Anonymous skills-usage telemetry is **default-on for new installs**.
 * This section runs during `cleo setup` to:
 *   1. Surface the default-on contract to the operator (transparency).
 *   2. Allow the operator to opt-out interactively.
 *   3. Persist `telemetry.enabled`, `telemetry.period`, `telemetry.installId`
 *      to the global config.
 *
 * The opt-out path is the same single boolean used by `cleo telemetry disable`
 * (T9666) — the wizard step is convenience, NOT the only surface.
 *
 * Payload contract (LOCKED in T9666, enforced by the transport in ADR-074):
 *   { installId, period: 'monthly', skills: { canonicalSkillName, loadCount }[] }
 *   NEVER includes user identity, session IDs, paths, or skill content.
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` → consume `options.telemetryEnabled`
 *     when present; default to `true` (default-on contract) when absent so
 *     unattended setup runs match interactive defaults.
 *
 * @task T9673
 * @epic T9572
 * @see packages/cleo/src/cli/commands/telemetry.ts
 * @see .cleo/adrs/ADR-074-skills-telemetry-pr-diff-transport.md
 */

import { randomUUID } from 'node:crypto';
import { getConfigValue, setConfigValue } from '../../config.js';
import type {
  WizardIO,
  WizardOptions,
  WizardSectionResult,
  WizardSectionRunner,
} from '../wizard.js';

/**
 * Telemetry reporting period — locked to `monthly` in T9666.
 *
 * Future periods (weekly, on-demand) MUST be added as a discriminated
 * union in `packages/cleo/src/cli/commands/telemetry.ts` first; this
 * section consumes the canonical type rather than re-defining it.
 */
const TELEMETRY_PERIOD = 'monthly' as const;

/**
 * Build the `telemetry` section runner.
 *
 * Idempotent — `isConfigured()` returns `true` when `telemetry.enabled` has
 * been explicitly written to the global config. On a fresh install the key
 * is absent (not `false`); the wizard runs and writes `true` per the
 * default-on contract.
 *
 * @returns A {@link WizardSectionRunner} for the telemetry section.
 */
export function createTelemetrySection(): WizardSectionRunner {
  return {
    section: 'telemetry',
    title: 'Anonymous skills-usage telemetry',
    optional: true,

    /**
     * Returns `true` when `telemetry.enabled` is set in the global config
     * (regardless of value — the operator's choice has been recorded).
     *
     * @returns `true` when already configured.
     */
    async isConfigured(): Promise<boolean> {
      const resolved = await getConfigValue<boolean>('telemetry.enabled');
      return typeof resolved.value === 'boolean';
    },

    async run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult> {
      io.info(
        'CLEO ships anonymous skills-usage telemetry that surfaces the most-loaded\n' +
          'canonical skills back to the owner-CI top-N council (T9572 SG-CLEO-SKILLS).\n' +
          'Payload: { installId, period, skills: [{ canonicalSkillName, loadCount }] }.\n' +
          'NEVER includes user identity, session IDs, paths, or skill content.\n' +
          'Default: enabled. Opt-out anytime via `cleo telemetry disable`.',
      );

      let enabled: boolean;
      if (options.nonInteractive === true) {
        // Default-on contract: if the flag is omitted, the unattended path
        // matches the interactive default (true) rather than fall through
        // to a silent `false`.
        enabled = options.telemetryEnabled ?? true;
      } else {
        enabled = await io.confirm('Enable anonymous skills-usage telemetry?', true);
      }

      await setConfigValue('telemetry.enabled', enabled, undefined, { global: true });
      await setConfigValue('telemetry.period', TELEMETRY_PERIOD, undefined, { global: true });

      // Always ensure an installId exists so a future re-enable does not
      // need to re-prompt for identity bootstrapping. The ID is anonymous
      // (UUID v4) and survives disable so periodic submissions can be
      // deduplicated upstream without re-identifying the operator.
      const existingId = await getConfigValue<string>('telemetry.installId');
      if (typeof existingId.value !== 'string' || existingId.value.length === 0) {
        await setConfigValue('telemetry.installId', randomUUID(), undefined, { global: true });
      }

      return {
        changed: true,
        summary: `telemetry ${enabled ? 'enabled' : 'disabled'} (period=${TELEMETRY_PERIOD})`,
      };
    },
  };
}
