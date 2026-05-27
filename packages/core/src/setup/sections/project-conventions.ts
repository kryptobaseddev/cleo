/**
 * `project-conventions` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Applies one of CLEO's three strictness presets (`strict` / `standard` /
 * `minimal`) via the existing {@link applyStrictnessPreset} helper.
 * Project-scoped: the preset is written to the *project* config so each
 * repository can have its own enforcement tier.
 *
 * V2 additions (T9610):
 *   - `isConfigured()` — returns `true` when project config has at least one
 *     strictness-related key (PROJ-5).
 *   - Current values display before prompting (GEN-7 / PROJ-1).
 *   - AC enforcement mode override prompt (PROJ-3).
 *   - Session auto-start override prompt (PROJ-3).
 *   - Section description printed before prompts (GEN-6).
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.strictness` →
 *     apply that preset; no prompts.
 *   - `options.acEnforcementMode` and `options.sessionAutoStart` apply
 *     fine-grained overrides when present (PROJ-4).
 *   - Missing `--strictness` under `--non-interactive` →
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9420
 * @task T9610
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.7 (PROJ-1 through PROJ-5)
 */

import {
  applyStrictnessPreset,
  getConfigValue,
  type StrictnessPreset,
  setConfigValue,
} from '../../config.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

const PRESET_CHOICES = ['strict', 'standard', 'minimal'] as const;

/** AC enforcement mode choices for the override prompt. */
const AC_ENFORCEMENT_CHOICES = ['block', 'warn', 'off', 'keep-preset-default'] as const;
type AcEnforcementChoice = (typeof AC_ENFORCEMENT_CHOICES)[number];

/** Session auto-start choices for the override prompt. */
const SESSION_AUTO_START_CHOICES = ['yes', 'no', 'keep-preset-default'] as const;
type SessionAutoStartChoice = (typeof SESSION_AUTO_START_CHOICES)[number];

/**
 * Build the `project-conventions` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the conventions section.
 * @task T9420
 * @task T9610
 */
export function createProjectConventionsSection(): WizardSectionRunner {
  return {
    section: 'project-conventions',
    title: 'Project conventions (strictness preset)',
    optional: true,

    /**
     * Returns `true` when a project config file exists with at least one
     * strictness-related key (`enforcement.acceptance.mode` or
     * `session.requireNotes`) — per PROJ-5.
     *
     * @param options - Current invocation options (for `projectRoot`).
     * @returns `true` when already configured.
     */
    async isConfigured(options: WizardOptions): Promise<boolean> {
      const acMode = await getConfigValue<unknown>(
        'enforcement.acceptance.mode',
        options.projectRoot,
      );
      const requireNotes = await getConfigValue<unknown>(
        'session.requireNotes',
        options.projectRoot,
      );
      // Only count as configured if the value came from a project config file
      // (not 'default' source), meaning it was explicitly set.
      const acConfigured = acMode.source !== 'default' && acMode.value !== undefined;
      const notesConfigured = requireNotes.source !== 'default' && requireNotes.value !== undefined;
      return acConfigured || notesConfigured;
    },

    async run(io: WizardIO, options: WizardOptions) {
      // GEN-6: Section description.
      io.info(
        'Configures project-level enforcement conventions written to `.cleo/config.json`.\n' +
          'Presets (strict / standard / minimal) control AC enforcement, session policy, and lifecycle.\n' +
          'Fine-grained overrides can be applied after choosing a preset.',
      );

      // GEN-7 / PROJ-1: Display current values.
      const currentAcMode = await getConfigValue<string>(
        'enforcement.acceptance.mode',
        options.projectRoot,
      );
      const currentAutoStart = await getConfigValue<boolean>(
        'session.autoStart',
        options.projectRoot,
      );
      io.info(
        `Current AC enforcement mode: ${currentAcMode.value ?? '(not set)'} (source: ${currentAcMode.source})`,
      );
      io.info(
        `Current session auto-start: ${currentAutoStart.value ?? '(not set)'} (source: ${currentAutoStart.source})`,
      );

      let preset: StrictnessPreset | undefined;

      if (options.nonInteractive === true) {
        if (!options.strictness) {
          return {
            changed: false,
            summary: 'skipped (non-interactive: --strictness required)',
          };
        }
        preset = options.strictness;
      } else {
        preset = await io.select<StrictnessPreset>(
          'Pick a strictness preset (strict|standard|minimal)',
          PRESET_CHOICES,
        );
      }

      const result = await applyStrictnessPreset(preset, options.projectRoot, { global: false });
      const keyCount = Object.keys(result.applied).length;
      const fragments: string[] = [
        `applied '${result.preset}' preset (${keyCount} keys to ${result.scope} config)`,
      ];

      // PROJ-3 / PROJ-4: Fine-grained override for AC enforcement mode.
      let acOverride: string | undefined;
      if (options.nonInteractive === true) {
        if (options.acEnforcementMode !== undefined) {
          acOverride = options.acEnforcementMode;
        }
      } else {
        const acChoice = await io.select<AcEnforcementChoice>(
          'Override AC enforcement mode? [block / warn / off / keep-preset-default]',
          AC_ENFORCEMENT_CHOICES,
        );
        if (acChoice !== 'keep-preset-default') {
          acOverride = acChoice;
        }
      }

      if (acOverride !== undefined) {
        await setConfigValue('enforcement.acceptance.mode', acOverride, options.projectRoot, {
          global: false,
        });
        fragments.push(`set enforcement.acceptance.mode=${acOverride}`);
      }

      // PROJ-3 / PROJ-4: Fine-grained override for session auto-start.
      let sessionAutoStartOverride: boolean | undefined;
      if (options.nonInteractive === true) {
        if (options.sessionAutoStart !== undefined) {
          sessionAutoStartOverride = options.sessionAutoStart;
        }
      } else {
        const sessionChoice = await io.select<SessionAutoStartChoice>(
          'Override session auto-start? [yes / no / keep-preset-default]',
          SESSION_AUTO_START_CHOICES,
        );
        if (sessionChoice === 'yes') {
          sessionAutoStartOverride = true;
        } else if (sessionChoice === 'no') {
          sessionAutoStartOverride = false;
        }
      }

      if (sessionAutoStartOverride !== undefined) {
        await setConfigValue('session.autoStart', sessionAutoStartOverride, options.projectRoot, {
          global: false,
        });
        fragments.push(`set session.autoStart=${sessionAutoStartOverride}`);
      }

      return {
        changed: true,
        summary: fragments.join(' + '),
      };
    },
  };
}
