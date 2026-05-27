/**
 * skills remove command - LAFS-compliant with JSON-first output
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  dispatchRemoveSkillAcrossProviders,
  resolveDefaultTargetProviders,
} from '../../core/harness/index.js';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import { listCanonicalSkills } from '../../core/skills/installer.js';
import { removeSkillFromLock } from '../../core/skills/lock.js';

/**
 * Registers the `skills remove` subcommand for removing installed skills.
 *
 * @remarks
 * Removes the canonical skill directory and all provider symlinks, then cleans up the lock file entry.
 * Supports interactive selection when no skill name is provided.
 *
 * @param parent - The parent `skills` Command to attach the remove subcommand to
 *
 * @example
 * ```bash
 * caamp skills remove my-skill
 * caamp skills remove --yes
 * ```
 *
 * @public
 */
export function registerSkillsRemove(parent: Command): void {
  parent
    .command('remove')
    .description('Remove installed skill(s)')
    .argument('[name]', 'Skill name to remove')
    .option('-g, --global', 'Remove from global scope')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(
      async (
        name: string | undefined,
        opts: { global?: boolean; yes?: boolean; json?: boolean; human?: boolean },
      ) => {
        const operation = 'skills.remove';
        const mvi: import('../../core/lafs.js').MVILevel = 'standard';

        let format: 'json' | 'human';
        try {
          format = resolveFormat({
            jsonFlag: opts.json ?? false,
            humanFlag: (opts.human ?? false) || isHuman(),
            projectDefault: 'json',
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          emitJsonError(
            operation,
            mvi,
            ErrorCodes.FORMAT_CONFLICT,
            message,
            ErrorCategories.VALIDATION,
          );
          process.exit(1);
        }

        const providers = resolveDefaultTargetProviders();

        if (name) {
          const result = await dispatchRemoveSkillAcrossProviders(
            name,
            providers,
            opts.global ?? false,
          );

          const removed = result.removed;
          const count = {
            removed: removed.length,
            total: providers.length,
          };

          if (format === 'json') {
            if (removed.length > 0) {
              await removeSkillFromLock(name);
            }

            const errors =
              result.errors.length > 0 ? result.errors.map((err) => ({ message: err })) : undefined;

            outputSuccess(operation, mvi, {
              removed,
              providers: providers.map((p) => p.id),
              count,
              ...(errors && { errors }),
            });
            return;
          }

          // Human-readable output
          if (removed.length > 0) {
            console.log(pc.green(`✓ Removed ${pc.bold(name)} from: ${removed.join(', ')}`));
            await removeSkillFromLock(name);
          } else {
            console.log(pc.yellow(`Skill ${name} not found in any provider.`));
          }

          if (result.errors.length > 0) {
            for (const err of result.errors) {
              console.log(pc.red(`  ${err}`));
            }
          }
        } else {
          // Interactive mode - list and select
          const skills = await listCanonicalSkills();
          if (skills.length === 0) {
            if (format === 'json') {
              outputSuccess(operation, mvi, {
                removed: [],
                providers: [],
                count: { removed: 0, total: 0 },
              });
            } else {
              console.log(pc.dim('No skills installed.'));
            }
            return;
          }

          if (format === 'json') {
            outputSuccess(operation, mvi, {
              removed: [],
              providers: [],
              count: { removed: 0, total: 0 },
              available: skills,
            });
            return;
          }

          // Human-readable output
          console.log(pc.bold('Installed skills:'));
          for (const s of skills) {
            console.log(`  ${s}`);
          }
          console.log(pc.dim('\nUse: caamp skills remove <name>'));
        }
      },
    );
}
