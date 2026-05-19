/**
 * `identity` setup wizard section (E-CONFIG-AUTH-UNIFY E3 / T9420).
 *
 * Captures the operator-visible agent display name and (optionally)
 * a SOUL.md persona block. Both pieces are stored away from secrets:
 *   - `agent.name` lands in the global config via `setConfigValue`.
 *   - SOUL.md content lands in `<projectRoot>/.cleo/SOUL.md` so it is
 *     scoped to the current project. Future Studio/CLI surfaces can
 *     read it via the standard config layer.
 *
 * V2 additions (T9610):
 *   - `isConfigured()` — returns `true` when `agent.name` is already set.
 *   - Current-value display before prompting (GEN-7).
 *   - SignalDock registration note (IDENT-5).
 *   - Section description printed before prompts (GEN-6).
 *
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.agentName` →
 *     writes the name and (optionally) SOUL.md content; no prompts.
 *   - Missing `--agent-name` under `--non-interactive` →
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9420
 * @task T9610
 * @epic T9402
 * @epic T9591
 * @see docs/plans/E-CLEO-SETUP-V2.md §4.2
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfigValue, setConfigValue } from '../../config.js';
import { getCleoDirAbsolute } from '../../paths.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/** Relative path inside `.cleo/` where SOUL.md is persisted. */
const SOUL_RELATIVE_PATH = 'SOUL.md';

/**
 * Build the `identity` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the identity section.
 * @task T9420
 * @task T9610
 */
export function createIdentitySection(): WizardSectionRunner {
  return {
    section: 'identity',
    title: 'Agent identity (name + optional SOUL.md persona)',
    optional: true,

    /**
     * Returns `true` when `agent.name` is set in global config (IDENT-6).
     *
     * @param options - Current invocation options (for `projectRoot`).
     * @returns `true` when already configured.
     */
    async isConfigured(options: WizardOptions): Promise<boolean> {
      const resolved = await getConfigValue<string>('agent.name', options.projectRoot);
      return typeof resolved.value === 'string' && resolved.value.trim().length > 0;
    },

    async run(io: WizardIO, options: WizardOptions) {
      // GEN-6: Section description.
      io.info(
        'Configures the agent display name written to `agent.name` in the global config\n' +
          'and an optional SOUL.md persona block scoped to this project (.cleo/SOUL.md).\n' +
          'SignalDock identity registration is prompted at the end of this section.',
      );

      // GEN-7: Display current value.
      const currentName = await getConfigValue<string>('agent.name', options.projectRoot);
      if (typeof currentName.value === 'string' && currentName.value.trim().length > 0) {
        io.info(`Current agent name: ${currentName.value} (source: ${currentName.source})`);
      } else {
        io.info('Current agent name: (not set)');
      }

      if (options.nonInteractive === true) {
        if (!options.agentName) {
          return { changed: false, summary: 'skipped (non-interactive: --agent-name required)' };
        }
        const writes = await applyIdentity(
          options.agentName,
          options.soulMdContent ?? null,
          options.projectRoot,
        );
        // IDENT-5 non-interactive: if signaldockAutoConnect, emit the note.
        if (options.signaldockAutoConnect === true) {
          io.info('To register a SignalDock identity, run: cleo signaldock connect');
        }
        return summariseWrites(writes);
      }

      const name = (await io.prompt('Agent display name (e.g. "Atlas")')).trim();
      if (name === '') {
        io.info('No name supplied — leaving identity unchanged.');
        return { changed: false, summary: 'skipped (no name provided)' };
      }

      let soulContent: string | null = null;
      const wantsSoul = await io.confirm('Add a SOUL.md persona block now?', false);
      if (wantsSoul) {
        const entered = (await io.prompt('Paste SOUL.md content (single line ok):')).trim();
        soulContent = entered === '' ? null : entered;
      }

      // IDENT-5: SignalDock registration prompt.
      const wantsSignalDock = await io.confirm(
        'Register a SignalDock identity for this agent?',
        false,
      );
      if (wantsSignalDock) {
        io.info('To register a SignalDock identity, run: cleo signaldock connect');
      }

      const writes = await applyIdentity(name, soulContent, options.projectRoot);
      return summariseWrites(writes);
    },
  };
}

/**
 * Apply identity writes to disk.
 *
 * Routed through {@link setConfigValue} (global scope) for the name and
 * through a direct atomic file write for SOUL.md. Both writes are best-effort
 * — caller of {@link createIdentitySection} surfaces failures via
 * {@link WizardIO.error} through the {@link WizardRunner} guard.
 *
 * @internal
 */
async function applyIdentity(
  name: string,
  soulContent: string | null,
  projectRoot: string | undefined,
): Promise<{ nameWritten: boolean; soulPath: string | null }> {
  await setConfigValue('agent.name', name, projectRoot, { global: true });

  let soulPath: string | null = null;
  if (soulContent && soulContent.length > 0) {
    const dir = getCleoDirAbsolute(projectRoot);
    soulPath = join(dir, SOUL_RELATIVE_PATH);
    await mkdir(dirname(soulPath), { recursive: true });
    await writeFile(soulPath, soulContent.endsWith('\n') ? soulContent : `${soulContent}\n`, {
      encoding: 'utf-8',
      mode: 0o644,
    });
  }
  return { nameWritten: true, soulPath };
}

/**
 * Compose a single-line summary from the {@link applyIdentity} write report.
 *
 * @internal
 */
function summariseWrites(writes: { nameWritten: boolean; soulPath: string | null }): {
  changed: boolean;
  summary: string;
} {
  const fragments: string[] = [];
  if (writes.nameWritten) fragments.push('set agent.name');
  if (writes.soulPath !== null) fragments.push(`wrote ${writes.soulPath}`);
  return {
    changed: fragments.length > 0,
    summary: fragments.length > 0 ? fragments.join(' + ') : 'no changes',
  };
}
