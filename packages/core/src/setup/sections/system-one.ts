/**
 * `system-one` setup wizard section (T12713).
 *
 * Optional: CLEO works without a typed-decision provider (every decision site
 * falls back to its heuristic). The section asks first, then runs
 * {@link runDecideWizard} — provider (layahost recommended), URL for `jev`,
 * the API key through the hidden {@link WizardIO.secret} prompt, a models
 * probe, the model, and an optional smoke test.
 *
 * Non-interactive runs skip the section: the scripted path is
 * `printf %s "$KEY" | cleo decide config --provider layahost --key-stdin`.
 *
 * @task T12713
 * @epic T12486
 */

import { describeDecideCredentials } from '../../decide/credentials.js';
import { type DecideWizardOptions, runDecideWizard } from '../../decide/wizard.js';
import type {
  WizardIO,
  WizardOptions,
  WizardSectionResult,
  WizardSectionRunner,
} from '../wizard.js';

/**
 * Build the `system-one` section runner.
 *
 * `isConfigured()` is true when a valid provider URL and key are stored in
 * the decide credential store (read-only).
 *
 * @param deps - Injectable probe `fetch`, deadline and smoke runner (tests).
 * @returns A {@link WizardSectionRunner} for the System One section.
 */
export function createSystemOneSection(deps: DecideWizardOptions = {}): WizardSectionRunner {
  return {
    section: 'system-one',
    title: 'System One typed decisions (optional)',
    optional: true,

    async isConfigured(): Promise<boolean> {
      return describeDecideCredentials().configured;
    },

    async run(io: WizardIO, options: WizardOptions): Promise<WizardSectionResult> {
      if (options.nonInteractive) {
        return {
          changed: false,
          summary:
            'skipped (non-interactive; run `cleo decide config --provider layahost --key-stdin`)',
        };
      }
      const wanted = await io.confirm(
        'Set up System One typed decisions now? CLEO works without it (heuristics answer).',
        false,
      );
      if (!wanted) return { changed: false, summary: 'skipped (not now)' };
      const result = await runDecideWizard(io, {
        ...deps,
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      });
      return { changed: result.configured, summary: result.summary };
    },
  };
}
