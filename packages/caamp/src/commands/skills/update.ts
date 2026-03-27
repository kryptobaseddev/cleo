/**
 * skills update command - LAFS-compliant with JSON-first output
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import { isHuman } from '../../core/logger.js';
import { getProvider } from '../../core/registry/providers.js';
import { installSkill } from '../../core/skills/installer.js';
import { checkSkillUpdate, getTrackedSkills, recordSkillInstall } from '../../core/skills/lock.js';
import { cloneRepo } from '../../core/sources/github.js';
import { cloneGitLabRepo } from '../../core/sources/gitlab.js';
import { parseSource } from '../../core/sources/parser.js';
import type { Provider } from '../../types.js';

/**
 * Registers the `skills update` subcommand for updating all outdated skills.
 *
 * @remarks
 * Checks each tracked skill for available updates and re-installs those with newer versions.
 * Updates the lock file with new version information after successful re-installation.
 *
 * @param parent - The parent `skills` Command to attach the update subcommand to
 *
 * @example
 * ```bash
 * caamp skills update --yes
 * caamp skills update --json
 * ```
 *
 * @public
 */
export function registerSkillsUpdate(parent: Command): void {
  parent
    .command('update')
    .description('Update all outdated skills')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(async (opts: { yes?: boolean; json?: boolean; human?: boolean }) => {
      const operation = 'skills.update';
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

      const tracked = await getTrackedSkills();
      const entries = Object.entries(tracked);

      if (entries.length === 0) {
        if (format === 'json') {
          outputSuccess(operation, mvi, {
            updated: [],
            failed: [],
            skipped: [],
            count: { updated: 0, failed: 0, skipped: 0 },
          });
        } else {
          console.log(pc.dim('No tracked skills to update.'));
        }
        return;
      }

      if (format === 'human') {
        console.log(pc.dim(`Checking ${entries.length} skill(s) for updates...`));
      }

      // Check all skills for updates
      const outdated: Array<{
        name: string;
        currentVersion?: string;
        latestVersion?: string;
      }> = [];

      for (const [name] of entries) {
        const result = await checkSkillUpdate(name);
        if (result.hasUpdate) {
          outdated.push({
            name,
            currentVersion: result.currentVersion,
            latestVersion: result.latestVersion,
          });
        }
      }

      if (outdated.length === 0) {
        if (format === 'json') {
          outputSuccess(operation, mvi, {
            updated: [],
            failed: [],
            skipped: [],
            count: { updated: 0, failed: 0, skipped: 0 },
          });
        } else {
          console.log(pc.green('\nAll skills are up to date.'));
        }
        return;
      }

      if (format === 'human') {
        console.log(pc.yellow(`\n${outdated.length} skill(s) have updates available:\n`));

        for (const skill of outdated) {
          const current = skill.currentVersion?.slice(0, 12) ?? '?';
          const latest = skill.latestVersion ?? '?';
          console.log(
            `  ${pc.bold(skill.name)}  ${pc.dim(current)}  ${pc.dim('->')}  ${pc.cyan(latest)}`,
          );
        }
      }

      // Confirm unless --yes
      if (!opts.yes && format === 'human') {
        const readline = await import('node:readline');
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise<string>((resolve) => {
          rl.question(pc.dim('\nProceed with update? [y/N] '), resolve);
        });
        rl.close();

        if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
          console.log(pc.dim('Update cancelled.'));
          return;
        }
      }

      if (format === 'human') {
        console.log();
      }

      // Track results for JSON output
      const updated: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      const skipped: string[] = [];

      // Update each outdated skill
      for (const skill of outdated) {
        const entry = tracked[skill.name];
        if (!entry) continue;

        if (format === 'human') {
          console.log(pc.dim(`Updating ${pc.bold(skill.name)}...`));
        }

        try {
          const parsed = parseSource(entry.source);
          let localPath: string;
          let cleanup: (() => Promise<void>) | undefined;

          if (parsed.type === 'github' && parsed.owner && parsed.repo) {
            const result = await cloneRepo(parsed.owner, parsed.repo, parsed.ref, parsed.path);
            localPath = result.localPath;
            cleanup = result.cleanup;
          } else if (parsed.type === 'gitlab' && parsed.owner && parsed.repo) {
            const result = await cloneGitLabRepo(
              parsed.owner,
              parsed.repo,
              parsed.ref,
              parsed.path,
            );
            localPath = result.localPath;
            cleanup = result.cleanup;
          } else {
            if (format === 'human') {
              console.log(
                pc.yellow(
                  `  Skipped ${skill.name}: source type "${parsed.type}" does not support auto-update`,
                ),
              );
            }
            skipped.push(skill.name);
            continue;
          }

          try {
            // Resolve providers from the lock entry's agent list
            const providers = entry.agents
              .map((a) => getProvider(a))
              .filter((p): p is Provider => p !== undefined);

            if (providers.length === 0) {
              if (format === 'human') {
                console.log(pc.yellow(`  Skipped ${skill.name}: no valid providers found`));
              }
              skipped.push(skill.name);
              continue;
            }

            const installResult = await installSkill(
              localPath,
              skill.name,
              providers,
              entry.isGlobal,
              entry.projectDir,
            );

            if (installResult.success) {
              // Record the updated version in the lock file
              await recordSkillInstall(
                skill.name,
                entry.scopedName,
                entry.source,
                entry.sourceType,
                installResult.linkedAgents,
                installResult.canonicalPath,
                entry.isGlobal,
                entry.projectDir,
                skill.latestVersion,
              );

              if (format === 'human') {
                console.log(pc.green(`  Updated ${pc.bold(skill.name)}`));
              }
              updated.push(skill.name);
            } else {
              if (format === 'human') {
                console.log(pc.red(`  Failed to update ${skill.name}: no agents linked`));
              }
              failed.push({ name: skill.name, error: 'no agents linked' });
            }

            if (installResult.errors.length > 0 && format === 'human') {
              for (const err of installResult.errors) {
                console.log(pc.yellow(`    ${err}`));
              }
            }
          } finally {
            if (cleanup) await cleanup();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (format === 'human') {
            console.log(pc.red(`  Failed to update ${skill.name}: ${msg}`));
          }
          failed.push({ name: skill.name, error: msg });
        }
      }

      if (format === 'json') {
        outputSuccess(operation, mvi, {
          updated,
          failed,
          skipped,
          count: {
            updated: updated.length,
            failed: failed.length,
            skipped: skipped.length,
          },
        });
        return;
      }

      // Human-readable output
      console.log();
      if (updated.length > 0) {
        console.log(pc.green(`Updated ${updated.length} skill(s).`));
      }
      if (failed.length > 0) {
        console.log(pc.red(`Failed to update ${failed.length} skill(s).`));
      }
    });
}
