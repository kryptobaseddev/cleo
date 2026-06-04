/**
 * `cleo doctor exodus-residue` — stranded legacy-DB residue check (T11777).
 *
 * Once a scope's exodus completion marker (`exodus-complete`) exists, every one
 * of the six legacy source DBs for that scope SHOULD have been archived into the
 * scope's `_archive/` directory. A source still present on disk is "stranded
 * residue" — it re-arms the `tasks_tasks=0` auto-recover / exodus-on-open
 * corruption trigger (DHQ-052 · T11662).
 *
 * Read-only by default; exits non-zero (`process.exitCode = 1`) when residue is
 * found so CI can gate on it. With `--fix`, archives every stranded DB (+ its
 * `-wal`/`-shm` sidecars) into `_archive/` via the SAME reversible archive
 * routine the on-open success path uses (move, never delete).
 *
 * @task T11777 (exodus archives all 6 legacy DBs + doctor stranded-residue check)
 * @epic T11249 (E6)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/exodus/archive.ts — the shared archive routine
 */

import {
  archiveStrandedResidue,
  buildExodusPlan,
  detectStrandedResidue,
} from '@cleocode/core/store/exodus/index.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput, humanInfo } from '../renderers/index.js';

/**
 * `cleo doctor exodus-residue` subcommand.
 *
 * @task T11777
 */
export const doctorExodusResidueCommand = defineCommand({
  meta: {
    name: 'exodus-residue',
    description:
      'Detect legacy exodus source DBs still present after a cutover (stranded residue that ' +
      're-arms the exodus-on-open corruption trigger). Use --fix to archive them into _archive/ ' +
      '(reversible move, never deletes).',
  },
  args: {
    fix: {
      type: 'boolean',
      description: 'Archive stranded legacy source DBs into _archive/ (move, never delete)',
      default: false,
    },
  },
  run({ args }) {
    const fix = args.fix === true;
    const cwd = process.cwd();
    const plan = buildExodusPlan(cwd);
    const stranded = detectStrandedResidue(plan.sources, cwd);

    if (stranded.length === 0) {
      cliOutput(
        {
          kind: 'generic',
          ok: true,
          strandedCount: 0,
          stranded: [],
          fixed: false,
        },
        {
          command: 'doctor exodus-residue',
          message: 'No stranded legacy exodus source DBs (clean cutover or pre-migration install).',
        },
      );
      return;
    }

    for (const entry of stranded) {
      humanInfo(`  STRANDED [${entry.scope}] ${entry.name} → ${entry.path}`);
    }

    if (!fix) {
      cliOutput(
        {
          kind: 'generic',
          ok: false,
          strandedCount: stranded.length,
          stranded: stranded.map((s) => ({ name: s.name, path: s.path, scope: s.scope })),
          fixed: false,
        },
        {
          command: 'doctor exodus-residue',
          message:
            `${stranded.length} stranded legacy source DB(s) found. ` +
            'Run `cleo doctor exodus-residue --fix` to archive them.',
        },
      );
      process.exitCode = 1;
      return;
    }

    const archived = archiveStrandedResidue(stranded, plan.sources, cwd);
    const movedCount = archived.filter((a) => a.action === 'archived').length;
    humanInfo(`  Archived ${movedCount} stranded source DB(s) → _archive/.`);

    cliOutput(
      {
        kind: 'generic',
        ok: true,
        strandedCount: stranded.length,
        stranded: stranded.map((s) => ({ name: s.name, path: s.path, scope: s.scope })),
        fixed: true,
        archived: archived.map((a) => ({
          name: a.name,
          action: a.action,
          archivedTo: a.archivedTo,
        })),
      },
      {
        command: 'doctor exodus-residue',
        message: `Archived ${movedCount} stranded legacy source DB(s) into _archive/.`,
      },
    );
  },
});
