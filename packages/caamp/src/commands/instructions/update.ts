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
import { syncGlobalInstructions } from '../../core/instructions/global-sync.js';
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

/** A file or provider the update could not refresh. */
interface UpdateFailure {
  provider: string;
  error: string;
}

/**
 * Global scope: regenerate every installed provider's global instruction file
 * through the single shared regenerator (T12377).
 *
 * Before T12377 this path injected the generic `generateInjectionContent()`
 * stub, and only into the default target provider — so with Pi installed it
 * overwrote Pi's embedded protocol with a 188-byte stub and never touched the
 * stale Claude/Codex/Gemini files that `check --global` reported.
 */
async function updateGlobal(format: 'json' | 'human'): Promise<void> {
  const operation = 'instructions.update';
  const mvi: import('../../core/lafs.js').MVILevel = 'standard';
  const result = await syncGlobalInstructions();

  const updated = result.files
    .filter((file) => file.action !== 'intact' && file.action !== 'failed')
    .map((file) => file.path);
  const failed: UpdateFailure[] = [
    ...result.files
      .filter((file) => file.action === 'failed')
      .map((file) => ({ provider: file.providers.join(','), error: file.error ?? 'unknown' })),
    ...result.findings.map((finding) => ({
      provider: 'hub',
      error: `${finding.kind}: ${finding.path} (${finding.reason})`,
    })),
  ];
  if (failed.length > 0) process.exitCode = 1;

  if (format === 'json') {
    outputSuccess(operation, mvi, {
      status: result.status,
      updated,
      failed,
      files: result.files,
      skippedProviders: result.skippedProviders,
      count: { updated: updated.length, failed: failed.length },
    });
    return;
  }

  if (result.status === 'no-providers') {
    console.log(pc.yellow('No provider installations detected.'));
    return;
  }
  for (const file of result.files) {
    const icon = file.action === 'failed' ? pc.red('x') : pc.green('✓');
    console.log(`  ${icon} ${file.path} (${file.action}${file.error ? `: ${file.error}` : ''})`);
  }
  for (const finding of result.findings) {
    console.log(`  ${pc.red('x')} ${finding.kind}: ${finding.path} — ${finding.reason}`);
  }
  console.log(pc.bold(`\n${updated.length} file(s) updated.`));
}

/**
 * Registers the `instructions update` subcommand for refreshing all instruction file injections.
 *
 * @remarks
 * `--global` regenerates every installed provider's global instruction file from
 * `~/.agents/AGENTS.md` through `syncGlobalInstructions` — the same implementation
 * `cleo install-global` uses — so it refreshes every file `check --global`
 * reports as stale and never replaces an embedded delivery with a stub.
 * Project scope refreshes the default target providers' CAAMP blocks; an
 * embedded project block is refused rather than downgraded and reported as failed.
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

      if (opts.global) {
        await updateGlobal(format);
        return;
      }

      const providers = resolveDefaultTargetProviders();
      const scope = 'project' as const;
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

      // One provider at a time so an embedded block that refuses a stub
      // (EmbeddedDeliveryDowngradeError) is reported without aborting the rest.
      const failures: UpdateFailure[] = [];
      const results = new Map<string, string>();
      for (const provider of toUpdate) {
        try {
          for (const [file, action] of await injectAll([provider], process.cwd(), scope, content)) {
            results.set(file, action);
          }
        } catch (err) {
          failures.push({
            provider: provider.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Refresh harness instruction blocks unconditionally.
      const harnessScope: HarnessScope = { kind: 'project', projectDir: process.cwd() };
      for (const provider of harnessProviders) {
        const harness = getHarnessFor(provider);
        if (harness === null) continue;
        try {
          await harness.injectInstructions(content, harnessScope);
          results.set(`${provider.id}:AGENTS.md`, 'updated');
        } catch (err) {
          failures.push({
            provider: provider.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const updated: string[] = [...results.keys()];

      if (format === 'human') {
        console.log();
        for (const [file, action] of results) {
          console.log(`  ${pc.green('✓')} ${file} (${action})`);
        }
        for (const failure of failures) {
          console.log(`  ${pc.red('x')} ${failure.provider}: ${failure.error}`);
        }
        console.log(pc.bold(`\n${results.size} file(s) updated.`));
      }

      if (format === 'json') {
        outputSuccess(operation, mvi, {
          updated,
          failed: failures,
          count: { updated: updated.length, failed: failures.length },
        });
      }
    });
}
