/** Thin entrypoint for copy-only project/global store recovery. */
import { getProjectRoot, isMissingProjectError } from '@cleocode/core/project-scope';
import { repairStoresFromDoctor } from '@cleocode/core/store/repair-store.js';
import { defineCommand } from '../lib/define-cli-command.js';
import { cliOutput } from '../renderers/index.js';

/** Recover readable rows onto a validated snapshot and atomically publish the result. */
export const doctorRepairStoreCommand = defineCommand({
  meta: {
    name: 'repair-store',
    description: 'Losslessly repair a damaged cleo.db, preserving originals and a recovery receipt',
  },
  args: {
    global: {
      type: 'boolean',
      description: 'Repair the global store instead of this project',
      default: false,
    },
    'dry-run': {
      type: 'boolean',
      description: 'Salvage and validate temporary copies without writing to .cleo',
      default: false,
    },
    'confirm-owner-store': {
      type: 'boolean',
      description: 'Allow a worktree invocation to repair its owning project store',
      default: false,
    },
  },
  async run({ args }): Promise<void> {
    let projectRoot = process.cwd();
    if (!args.global) {
      try {
        projectRoot = getProjectRoot();
      } catch (error) {
        if (!isMissingProjectError(error)) throw error;
      }
    }
    const stores = await repairStoresFromDoctor({
      projectRoot,
      cwd: process.cwd(),
      scope: args.global ? 'global' : 'project',
      dryRun: args['dry-run'] === true,
      confirmOwnerStore: args['confirm-owner-store'] === true,
    });
    cliOutput({ stores }, { command: 'doctor', operation: 'doctor.repair-store' });
  },
});
