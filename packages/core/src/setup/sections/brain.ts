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
 * V2 additions (T9610):
 *   - `isConfigured()` — returns `true` when `brain.memoryBridge.mode` is set (BRAIN-6).
 *   - Retention days prompt (BRAIN-3).
 *   - Embedding toggle prompt (BRAIN-4).
 *   - Displays current bridge mode, embedding state, and retention days (BRAIN-1).
 *   - Section description printed before prompts (GEN-6).
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.brainBridgeMode` →
 *     persist that value; no prompts.
 *   - Missing `--brain-bridge-mode` under `--non-interactive` →
 *     section short-circuits with error.
 *
 * @task T9425
 * @task T9610
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.6 (BRAIN-1 through BRAIN-6)
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
 * Parse retention days from a string input, returning the numeric value or
 * `null` if the input is invalid.
 *
 * Valid input: non-negative integer (0 = forever).
 *
 * @param raw - String to parse.
 * @returns Parsed non-negative integer or `null` on invalid input.
 * @internal
 */
function parseRetentionDays(raw: string): number | null {
  if (raw.trim() === '') return 0;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || !Number.isFinite(n)) return null;
  return n;
}

/**
 * Build the `brain` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the BRAIN section.
 * @task T9425
 * @task T9610
 */
export function createBrainSection(): WizardSectionRunner {
  return {
    section: 'brain',
    title: 'BRAIN memory bridge (digest|file|disabled)',
    optional: true,

    /**
     * Returns `true` when `brain.memoryBridge.mode` is set in global config (BRAIN-6).
     *
     * @param options - Current invocation options (for `projectRoot`).
     * @returns `true` when already configured.
     */
    async isConfigured(options: WizardOptions): Promise<boolean> {
      const resolved = await getConfigValue<MemoryBridgeMode>(
        'brain.memoryBridge.mode',
        options.projectRoot,
      );
      // Only "configured" if explicitly set (not from default source).
      return resolved.source !== 'default' && resolved.value !== undefined;
    },

    async run(io: WizardIO, options: WizardOptions) {
      // GEN-6: Section description.
      io.info(
        'Configures the BRAIN memory bridge mode, retention policy, and embedding index.\n' +
          'Settings are stored in the global config (~/.cleo/config.json).\n' +
          '"digest" mode injects a live memory digest; "file" mode writes static bridge files.',
      );

      // GEN-7 / BRAIN-1: Display current bridge mode, embedding, and retention.
      const resolved = await getConfigValue<MemoryBridgeMode>(
        'brain.memoryBridge.mode',
        options.projectRoot,
      );
      const currentLabel = fromWireMode(resolved.value);
      io.info(`Current BRAIN bridge mode: ${currentLabel} (source: ${resolved.source})`);

      const embeddingResolved = await getConfigValue<boolean>(
        'brain.embedding.enabled',
        options.projectRoot,
      );
      const embeddingEnabled = embeddingResolved.value ?? false;
      io.info(
        `Current BRAIN embedding index: ${embeddingEnabled ? 'enabled' : 'disabled'} (source: ${embeddingResolved.source})`,
      );

      const retentionResolved = await getConfigValue<number>(
        'brain.retention.days',
        options.projectRoot,
      );
      const retentionDays = retentionResolved.value ?? 0;
      io.info(
        `Current BRAIN retention: ${retentionDays === 0 ? 'forever (0)' : `${retentionDays} days`} (source: ${retentionResolved.source})`,
      );

      let choice: WizardBrainBridgeMode | undefined;
      let chosenRetentionDays: number | undefined;
      let chosenEmbeddingEnabled: boolean | undefined;

      if (options.nonInteractive === true) {
        if (!options.brainBridgeMode) {
          throw new Error(
            'E_SETUP_MISSING_FLAG: --section brain --non-interactive requires --brain-bridge-mode <digest|file|disabled>',
          );
        }
        choice = options.brainBridgeMode;
        // BRAIN-5: Apply optional non-interactive fields.
        if (options.brainRetentionDays !== undefined) {
          chosenRetentionDays = options.brainRetentionDays;
        }
        if (options.brainEmbeddingEnabled !== undefined) {
          chosenEmbeddingEnabled = options.brainEmbeddingEnabled;
        }
      } else {
        choice = await io.select<WizardBrainBridgeMode>(
          'Pick BRAIN memory bridge mode (digest|file|disabled)',
          WIZARD_MODE_CHOICES,
        );

        // BRAIN-3: Retention days prompt.
        let validRetention = false;
        while (!validRetention) {
          const rawDays = await io.prompt(
            'How long should BRAIN retain memory entries? [days, 0 = forever, default 0]',
          );
          const parsed = parseRetentionDays(rawDays);
          if (parsed === null) {
            io.warn(`Invalid value '${rawDays}' — must be a non-negative integer. Try again.`);
          } else {
            chosenRetentionDays = parsed;
            validRetention = true;
          }
        }

        // BRAIN-4: Embedding toggle prompt.
        chosenEmbeddingEnabled = await io.confirm(
          'Enable BRAIN embedding index (enables semantic search, requires local disk)?',
          true,
        );
      }

      const wire = toWireMode(choice);
      await setConfigValue('brain.memoryBridge.mode', wire, options.projectRoot, { global: true });

      const fragments: string[] = [`set brain.memoryBridge.mode=${choice} (was ${currentLabel})`];

      // BRAIN-3: Persist retention days.
      if (chosenRetentionDays !== undefined) {
        await setConfigValue('brain.retention.days', chosenRetentionDays, options.projectRoot, {
          global: true,
        });
        fragments.push(
          `set brain.retention.days=${chosenRetentionDays === 0 ? 'forever (0)' : chosenRetentionDays}`,
        );
      }

      // BRAIN-4: Persist embedding toggle.
      if (chosenEmbeddingEnabled !== undefined) {
        await setConfigValue(
          'brain.embedding.enabled',
          chosenEmbeddingEnabled,
          options.projectRoot,
          { global: true },
        );
        fragments.push(`set brain.embedding.enabled=${chosenEmbeddingEnabled}`);
      }

      return {
        changed: true,
        summary: fragments.join(' + '),
      };
    },
  };
}
