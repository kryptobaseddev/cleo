/**
 * `cleo doctor worktree-stores` — list project stores stranded inside CLEO
 * worktrees, and whether each holds rows the parent store does not (T12460).
 *
 * Before T12460 a `cleo` command run inside an orchestrate worktree opened the
 * worktree's own `.cleo/cleo.db`, auto-recovered a full copy of the parent's
 * newest snapshot into it, and kept every later write there. Resolution now
 * maps worktrees to the parent store, but the copies made earlier are still on
 * disk and can hold the only record of those writes.
 *
 * Read-only. It never deletes, moves, or writes anything. To import rows a copy
 * holds that the parent lacks, review the report and run
 * `cleo doctor split-brain --source <copy>`.
 *
 * @task T12460
 */

import { scanWorktreeStores } from '@cleocode/core/doctor/worktree-stores.js';
import { getProjectRoot, resolveStoreOwnerRoot } from '@cleocode/core/paths.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/**
 * `cleo doctor worktree-stores` subcommand.
 *
 * Exits non-zero when at least one stranded copy holds rows the parent lacks,
 * so it can gate a salvage step in a script. Finding only covered copies, or
 * none, exits 0.
 *
 * @task T12460
 */
export const doctorWorktreeStoresCommand = defineCommand({
  meta: {
    name: 'worktree-stores',
    description:
      'List store files (.cleo/*.db, *.bak) stranded inside the project worktrees and report ' +
      'whether each holds rows newer than the parent store. Read-only — deletes nothing.',
  },
  args: {
    'skip-compare': {
      type: 'boolean',
      description: 'List files only; skip the per-table row comparison against the parent store',
    },
    json: { type: 'boolean', description: 'Output as JSON' },
    human: { type: 'boolean', description: 'Force human-readable output' },
    quiet: { type: 'boolean', description: 'Suppress non-essential output' },
  },
  async run({ args }) {
    // Inside a worktree the scope root is the worktree; the report is about its parent.
    const projectRoot = resolveStoreOwnerRoot(getProjectRoot());
    const result = scanWorktreeStores(projectRoot, { skipCompare: args['skip-compare'] === true });

    cliOutput(result, {
      command: 'doctor',
      operation: 'doctor.worktree-stores.run',
      message:
        `${result.strandedFileCount} stranded store file(s) in ${result.entries.length} worktree(s); ` +
        `${result.filesWithNewerRows.length} hold rows the parent store lacks.`,
    });

    if (
      result.filesWithNewerRows.length > 0 &&
      (process.exitCode === undefined || process.exitCode === 0)
    ) {
      process.exitCode = 1;
    }
  },
});
