/**
 * skills check command - check for updates - LAFS-compliant with JSON-first output
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
import { checkSkillUpdate, getTrackedSkills } from '../../core/skills/lock.js';

/**
 * Registers the `skills check` subcommand for checking available skill updates.
 *
 * @remarks
 * Compares tracked skill versions against their remote sources and reports which skills
 * have updates available.
 *
 * @param parent - The parent `skills` Command to attach the check subcommand to
 *
 * @example
 * ```bash
 * caamp skills check --human
 * caamp skills check --json
 * ```
 *
 * @public
 */
export function registerSkillsCheck(parent: Command): void {
  parent
    .command('check')
    .description('Check for available skill updates')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(async (opts: { json?: boolean; human?: boolean }) => {
      const operation = 'skills.check';
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
            skills: [],
            outdated: 0,
            total: 0,
          });
        } else {
          console.log(pc.dim('No tracked skills.'));
        }
        return;
      }

      if (format === 'human') {
        console.log(pc.dim(`Checking ${entries.length} skill(s) for updates...\n`));
      }

      const skillResults = [];
      let updatesAvailable = 0;

      for (const [name, entry] of entries) {
        const update = await checkSkillUpdate(name);
        const hasUpdate = update.hasUpdate ?? false;

        if (hasUpdate) {
          updatesAvailable++;
        }

        skillResults.push({
          name,
          currentVersion: update.currentVersion ?? entry.version ?? 'unknown',
          latestVersion: update.latestVersion ?? 'unknown',
          hasUpdate,
          source: entry.source,
          agents: entry.agents,
        });
      }

      if (format === 'json') {
        outputSuccess(operation, mvi, {
          skills: skillResults.map((s) => ({
            name: s.name,
            currentVersion: s.currentVersion,
            latestVersion: s.latestVersion,
            hasUpdate: s.hasUpdate,
          })),
          outdated: updatesAvailable,
          total: entries.length,
        });
        return;
      }

      // Human-readable output
      for (const r of skillResults) {
        let statusLabel: string;
        if (r.hasUpdate) {
          statusLabel = pc.yellow('update available');
        } else if (r.currentVersion !== 'unknown') {
          statusLabel = pc.green('up to date');
        } else {
          statusLabel = pc.dim('unknown');
        }

        console.log(`  ${pc.bold(r.name.padEnd(30))} ${statusLabel}`);

        if (r.currentVersion !== 'unknown' || r.latestVersion !== 'unknown') {
          const current = r.currentVersion !== 'unknown' ? r.currentVersion.slice(0, 12) : '?';
          const latest = r.latestVersion !== 'unknown' ? r.latestVersion : '?';
          if (r.hasUpdate) {
            console.log(`  ${pc.dim('current:')} ${current}  ${pc.dim('->')}  ${pc.cyan(latest)}`);
          } else {
            console.log(`  ${pc.dim('version:')} ${current}`);
          }
        }

        console.log(`  ${pc.dim(`source: ${r.source}`)}`);
        console.log(`  ${pc.dim(`agents: ${r.agents.join(', ')}`)}`);
        console.log();
      }

      if (updatesAvailable > 0) {
        console.log(pc.yellow(`${updatesAvailable} update(s) available.`));
        console.log(pc.dim('Run `caamp skills update` to update all.'));
      } else {
        console.log(pc.green('All skills are up to date.'));
      }
    });
}
