/**
 * `project-conventions` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Applies one of CLEO's three strictness presets (`strict` / `standard` /
 * `minimal`) via the existing {@link applyStrictnessPreset} helper.
 * Project-scoped: the preset is written to the *project* config so each
 * repository can have its own enforcement tier.
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.strictness` →
 *     apply that preset; no prompts.
 *   - Missing `--strictness` under `--non-interactive` →
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9420
 * @epic T9402
 */

import { applyStrictnessPreset, type StrictnessPreset } from '../../config.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

const PRESET_CHOICES = ['strict', 'standard', 'minimal'] as const;

/**
 * Build the `project-conventions` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the conventions section.
 * @task T9420
 */
export function createProjectConventionsSection(): WizardSectionRunner {
  return {
    section: 'project-conventions',
    title: 'Project conventions (strictness preset)',
    optional: true,
    async run(io: WizardIO, options: WizardOptions) {
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
      return {
        changed: true,
        summary: `applied '${result.preset}' preset (${keyCount} keys to ${result.scope} config)`,
      };
    },
  };
}
