/**
 * `caamp pi prompts` command group.
 *
 * @remarks
 * Three verbs implementing ADR-035 §D1 + spec hook T266 for Pi prompts.
 *
 * - `install <sourceDir>` — copy a prompt directory (containing
 *   `prompt.md` + optional metadata) into the target tier. Errors on
 *   existing target unless `--force`.
 * - `list` — walk every tier and emit an array of {@link PromptEntry}.
 *   MUST read only directory listings — never prompt bodies — for
 *   token efficiency.
 * - `remove <name>` — delete a prompt directory from the target tier.
 *
 * @packageDocumentation
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { HarnessInstallOptions } from '../../core/harness/types.js';
import { LAFSCommandError, runLafsCommand } from '../advanced/lafs.js';
import {
  PI_ERROR_CODES,
  type PiCommandBaseOptions,
  parseScope,
  requirePiHarness,
  resolveProjectDir,
} from './common.js';

/**
 * Options accepted by `caamp pi prompts install`.
 *
 * @public
 */
export interface PiPromptsInstallOptions extends PiCommandBaseOptions {
  /** Override the inferred prompt directory name. */
  name?: string;
}

/**
 * Options accepted by `caamp pi prompts list`.
 *
 * @public
 */
export type PiPromptsListOptions = PiCommandBaseOptions;

/**
 * Options accepted by `caamp pi prompts remove`.
 *
 * @public
 */
export type PiPromptsRemoveOptions = PiCommandBaseOptions;

/**
 * Infer a prompt name from a source directory path by taking the
 * trailing path segment.
 *
 * @internal
 */
function inferPromptName(sourceDir: string): string {
  const normalized = resolve(sourceDir).replace(/[\\/]+$/, '');
  const base = normalized.split(/[\\/]/).pop();
  if (base === undefined || base.length === 0) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.VALIDATION,
      `Could not infer a prompt name from source: ${sourceDir}`,
      'Pass --name <name> to override the inferred name.',
      false,
    );
  }
  return base;
}

/**
 * Registers the `caamp pi prompts` command group.
 *
 * @param parent - The parent `pi` Command to attach the prompts group to.
 *
 * @example
 * ```bash
 * caamp pi prompts install ./prompts/my-prompt --scope user
 * caamp pi prompts list
 * caamp pi prompts remove my-prompt --scope user
 * ```
 *
 * @public
 */
export function registerPiPromptsCommands(parent: Command): void {
  const prompts = parent.command('prompts').description('Manage Pi prompts across tiers');

  prompts
    .command('install <source>')
    .description('Install a Pi prompt directory (contains prompt.md + optional metadata)')
    .option('--scope <tier>', 'Install tier: project|user|global (default: project)')
    .option('--name <name>', 'Override the inferred prompt name')
    .option('--force', 'Overwrite an existing prompt at the target tier')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (source: string, opts: PiPromptsInstallOptions) =>
      runLafsCommand('pi.prompts.install', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);

        const absSource = resolve(source);
        if (!existsSync(absSource)) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.NOT_FOUND,
            `Source directory does not exist: ${absSource}`,
            'Check the path and try again.',
            false,
          );
        }
        if (!existsSync(join(absSource, 'prompt.md'))) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.VALIDATION,
            `Source directory is missing prompt.md: ${absSource}`,
            'Add a prompt.md to the source directory and retry.',
            false,
          );
        }

        const name = opts.name ?? inferPromptName(absSource);
        const installOpts: HarnessInstallOptions = { force: opts.force ?? false };
        const result = await harness.installPrompt(absSource, name, tier, projectDir, installOpts);
        return {
          installed: {
            name,
            tier: result.tier,
            targetPath: result.targetPath,
            source: absSource,
          },
        };
      }),
    );

  prompts
    .command('list')
    .description('List Pi prompts across project, user, and global tiers')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (opts: PiPromptsListOptions) =>
      runLafsCommand('pi.prompts.list', 'standard', async () => {
        const harness = requirePiHarness();
        const projectDir = opts.projectDir ?? process.cwd();
        const entries = await harness.listPrompts(projectDir);
        return {
          count: entries.length,
          prompts: entries,
        };
      }),
    );

  prompts
    .command('remove <name>')
    .description('Remove a Pi prompt from the given tier')
    .option('--scope <tier>', 'Target tier: project|user|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (name: string, opts: PiPromptsRemoveOptions) =>
      runLafsCommand('pi.prompts.remove', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);
        const removed = await harness.removePrompt(name, tier, projectDir);
        return { name, tier, removed };
      }),
    );
}
