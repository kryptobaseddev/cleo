/**
 * `brain` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9425).
 *
 * Controls how BRAIN context is surfaced inside AGENTS.md by toggling
 * `brain.memoryBridge.mode` across three operator-visible values:
 *
 *   - `'digest'`   — AGENTS.md gets a `cleo memory digest --brief` directive
 *                    (no `.cleo/memory-bridge.md` written). Wire value stays
 *                    `'cli'` so existing project configs continue to resolve
 *                    correctly; the wizard label was renamed to "digest" to
 *                    match the user-facing CLI command.
 *   - `'file'`     — Legacy behaviour: write `.cleo/memory-bridge.md` and
 *                    `.cleo/nexus-bridge.md` so they get `@`-injected.
 *   - `'disabled'` — Suppress BRAIN-driven AGENTS.md augmentation entirely.
 *
 * The choice is persisted to the **global** config under
 * `brain.memoryBridge.mode` via {@link setConfigValue} so every project
 * picks it up unless overridden. `setConfigValue` is the same path the
 * other sections use (see `identity.ts`).
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.brainBridgeMode` →
 *     persist that value; no prompts.
 *   - Missing `--brain-bridge-mode` under `--non-interactive` →
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9425
 * @epic T9402
 * @see docs/plans/E-CONFIG-AUTH-UNIFY.md §5.3 T-E3-6
 */

import type { MemoryBridgeMode } from '@cleocode/contracts';
import { getConfigValue, setConfigValue } from '../../config.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/**
 * Operator-facing mode labels the wizard offers.
 *
 * `'digest'` is a label-only synonym for the on-disk `'cli'` mode — see the
 * file-level doc comment for the rationale. The wizard normalises every
 * answer through {@link toWireMode} before persisting.
 */
const WIZARD_MODE_CHOICES = ['digest', 'file', 'disabled'] as const;

/**
 * Surface-facing mode label.
 */
export type WizardBrainBridgeMode = (typeof WIZARD_MODE_CHOICES)[number];

/**
 * Translate an operator-facing label to the wire value persisted into
 * `brain.memoryBridge.mode`.
 *
 * Keeps existing project configs (which use `'cli'`) functioning unchanged
 * while exposing the more discoverable `'digest'` label to operators.
 *
 * @internal
 */
function toWireMode(label: WizardBrainBridgeMode): MemoryBridgeMode {
  switch (label) {
    case 'digest':
      return 'cli';
    case 'file':
      return 'file';
    case 'disabled':
      return 'disabled';
  }
}

/**
 * Translate the on-disk wire value back to its operator-facing label so
 * the wizard can echo the current state without confusing the user with
 * `'cli'`.
 *
 * @internal
 */
function fromWireMode(mode: MemoryBridgeMode | undefined): WizardBrainBridgeMode {
  switch (mode) {
    case 'file':
      return 'file';
    case 'disabled':
      return 'disabled';
    default:
      return 'digest';
  }
}

/**
 * Build the `brain` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the BRAIN section.
 * @task T9425
 */
export function createBrainSection(): WizardSectionRunner {
  return {
    section: 'brain',
    title: 'BRAIN memory bridge (digest|file|disabled)',
    optional: true,
    async run(io: WizardIO, options: WizardOptions) {
      const resolved = await getConfigValue<MemoryBridgeMode>(
        'brain.memoryBridge.mode',
        options.projectRoot,
      );
      const currentLabel = fromWireMode(resolved.value);
      io.info(`Current BRAIN bridge mode: ${currentLabel} (source: ${resolved.source})`);

      let choice: WizardBrainBridgeMode | undefined;

      if (options.nonInteractive === true) {
        if (!options.brainBridgeMode) {
          return {
            changed: false,
            summary: 'skipped (non-interactive: --brain-bridge-mode required)',
          };
        }
        choice = options.brainBridgeMode;
      } else {
        choice = await io.select<WizardBrainBridgeMode>(
          'Pick BRAIN memory bridge mode (digest|file|disabled)',
          WIZARD_MODE_CHOICES,
        );
      }

      const wire = toWireMode(choice);
      await setConfigValue('brain.memoryBridge.mode', wire, options.projectRoot, { global: true });

      return {
        changed: true,
        summary: `set brain.memoryBridge.mode=${choice} (was ${currentLabel})`,
      };
    },
  };
}
