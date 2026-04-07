/**
 * instructions update command - LAFS-compliant with JSON-first output
 */

import type { Command } from 'commander';
import pc from 'picocolors';
import {
  getHarnessFor,
  type HarnessScope,
  resolveDefaultTargetProviders,
} from '../../core/harness/index.js';
import { checkAllInjections, injectAll } from '../../core/instructions/injector.js';
import { generateInjectionContent } from '../../core/instructions/templates.js';
import {
  ErrorCategories,
  ErrorCodes,
  emitJsonError,
  outputSuccess,
  resolveFormat,
} from '../../core/lafs.js';
import type { Provider } from '../../types.js';

/**
 * Registers the `instructions update` subcommand for refreshing all instruction file injections.
 *
 * @remarks
 * Re-generates and updates CAAMP injection blocks in all detected provider instruction files.
 * Checks for stale injections first and only updates those that have changed.
 *
 * @param parent - The parent `instructions` Command to attach the update subcommand to
 *
 * @example
 * ```bash
 * caamp instructions update --yes
 * caamp instructions update --global --json
 * ```
 *
 * @public
 */
export function registerInstructionsUpdate(parent: Command): void {
  parent
    .command('update')
    .description('Update all instruction file injections')
    .option('-g, --global', 'Update global instruction files')
    .option('-y, --yes', 'Skip confirmation')
    .option('--json', 'Output as JSON (default)')
    .option('--human', 'Output in human-readable format')
    .action(async (opts: { global?: boolean; yes?: boolean; json?: boolean; human?: boolean }) => {
      const operation = 'instructions.update';
      const mvi: import('../../core/lafs.js').MVILevel = 'standard';

      let format: 'json' | 'human';
      try {
        format = resolveFormat({
          jsonFlag: opts.json ?? false,
          humanFlag: opts.human ?? false,
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
      const scope = opts.global ? ('global' as const) : ('project' as const);
      const content = generateInjectionContent();

      // Split harness-backed providers from generic providers: harness
      // providers own their own instruction file lifecycle and are
      // unconditionally refreshed via `injectInstructions`; generic
      // providers still go through the shared marker-based injector.
      const harnessProviders: Provider[] = [];
      const genericProviders: Provider[] = [];
      for (const provider of providers) {
        if (getHarnessFor(provider) !== null) {
          harnessProviders.push(provider);
        } else {
          genericProviders.push(provider);
        }
      }

      // Check current state for generic providers only — the harness
      // injection path is idempotent and ownership-clean, so we always
      // refresh its block.
      const checks = await checkAllInjections(genericProviders, process.cwd(), scope, content);
      const needsUpdate = checks.filter((c) => c.status !== 'current');

      if (harnessProviders.length === 0 && needsUpdate.length === 0) {
        if (format === 'json') {
          outputSuccess(operation, mvi, {
            updated: [],
            failed: [],
            count: { updated: 0, failed: 0 },
          });
        } else {
          console.log(pc.green('All instruction files are up to date.'));
        }
        return;
      }

      if (format === 'human' && needsUpdate.length > 0) {
        console.log(pc.bold(`${needsUpdate.length} file(s) need updating:\n`));
        for (const c of needsUpdate) {
          console.log(`  ${c.file} (${c.status})`);
        }
      }

      // Filter generic providers to only those needing updates.
      const providerIds = new Set(needsUpdate.map((c) => c.provider));
      const toUpdate = genericProviders.filter((p) => providerIds.has(p.id));

      const results = await injectAll(toUpdate, process.cwd(), scope, content);

      // Refresh harness instruction blocks unconditionally.
      const harnessScope: HarnessScope =
        scope === 'global' ? { kind: 'global' } : { kind: 'project', projectDir: process.cwd() };
      const harnessFailures: Array<{ provider: string; error: string }> = [];
      for (const provider of harnessProviders) {
        const harness = getHarnessFor(provider);
        if (harness === null) continue;
        try {
          await harness.injectInstructions(content, harnessScope);
          results.set(`${provider.id}:AGENTS.md`, 'updated');
        } catch (err) {
          harnessFailures.push({
            provider: provider.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const updated: string[] = [];
      for (const [file] of results) {
        updated.push(file);
      }

      if (format === 'human') {
        console.log();
        for (const [file, action] of results) {
          console.log(`  ${pc.green('✓')} ${file} (${action})`);
        }
        for (const failure of harnessFailures) {
          console.log(`  ${pc.red('x')} ${failure.provider}: ${failure.error}`);
        }
        console.log(pc.bold(`\n${results.size} file(s) updated.`));
      }

      if (format === 'json') {
        outputSuccess(operation, mvi, {
          updated,
          failed: harnessFailures,
          count: { updated: updated.length, failed: harnessFailures.length },
        });
      }
    });
}
