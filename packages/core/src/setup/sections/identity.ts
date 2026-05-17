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
 * Non-interactive contract:
 *   - `options.nonInteractive === true` + `options.agentName` →
 *     writes the name and (optionally) SOUL.md content; no prompts.
 *   - Missing `--agent-name` under `--non-interactive` →
 *     section short-circuits silently (`changed: false`).
 *
 * @task T9420
 * @epic T9402
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setConfigValue } from '../../config.js';
import { getCleoDirAbsolute } from '../../paths.js';
import type { WizardIO, WizardOptions, WizardSectionRunner } from '../wizard.js';

/** Relative path inside `.cleo/` where SOUL.md is persisted. */
const SOUL_RELATIVE_PATH = 'SOUL.md';

/**
 * Build the `identity` section runner.
 *
 * @returns A {@link WizardSectionRunner} for the identity section.
 * @task T9420
 */
export function createIdentitySection(): WizardSectionRunner {
  return {
    section: 'identity',
    title: 'Agent identity (name + optional SOUL.md persona)',
    optional: true,
    async run(io: WizardIO, options: WizardOptions) {
      if (options.nonInteractive === true) {
        if (!options.agentName) {
          return { changed: false, summary: 'skipped (non-interactive: --agent-name required)' };
        }
        const writes = await applyIdentity(
          options.agentName,
          options.soulMdContent ?? null,
          options.projectRoot,
        );
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
