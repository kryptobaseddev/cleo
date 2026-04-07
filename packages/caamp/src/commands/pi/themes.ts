/**
 * `caamp pi themes` command group.
 *
 * @remarks
 * Three verbs implementing ADR-035 §D1 + spec hook T267 for Pi themes.
 *
 * - `install <sourceFile>` — copy a theme file (`.ts`, `.tsx`, `.mts`,
 *   or `.json`) into the target tier. Errors on existing target unless
 *   `--force`.
 * - `list` — walk every tier and emit an array of {@link ThemeEntry}
 *   with shadow flags and the file extension preserved so callers see
 *   whether each theme is TypeScript or JSON.
 * - `remove <name>` — delete a theme file from the target tier,
 *   handling both `.ts`/`.json` extensions.
 *
 * @packageDocumentation
 */

import { existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
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
 * Options accepted by `caamp pi themes install`.
 *
 * @public
 */
export interface PiThemesInstallOptions extends PiCommandBaseOptions {
  /** Override the inferred theme name. */
  name?: string;
}

/**
 * Options accepted by `caamp pi themes list`.
 *
 * @public
 */
export type PiThemesListOptions = PiCommandBaseOptions;

/**
 * Options accepted by `caamp pi themes remove`.
 *
 * @public
 */
export type PiThemesRemoveOptions = PiCommandBaseOptions;

/**
 * Infer a theme name from a source file path by taking the basename
 * and stripping the recognised theme file extension.
 *
 * @internal
 */
function inferThemeName(sourceFile: string): string {
  const base = resolve(sourceFile).split(/[\\/]/).pop();
  if (base === undefined || base.length === 0) {
    throw new LAFSCommandError(
      PI_ERROR_CODES.VALIDATION,
      `Could not infer a theme name from source: ${sourceFile}`,
      'Pass --name <name> to override the inferred name.',
      false,
    );
  }
  const ext = extname(base);
  if (ext === '') return base;
  return base.slice(0, -ext.length);
}

/**
 * Registers the `caamp pi themes` command group.
 *
 * @remarks
 * Wires the `install`, `list`, and `remove` subcommands into the
 * supplied `pi` parent Command. Delegates to the {@link PiHarness}
 * theme verbs for filesystem operations across the three-tier
 * hierarchy and accepts `.ts`/`.tsx`/`.mts`/`.json` theme files.
 *
 * @param parent - The parent `pi` Command to attach the themes group to.
 *
 * @example
 * ```bash
 * caamp pi themes install ./themes/my-theme.json --scope user
 * caamp pi themes list
 * caamp pi themes remove my-theme --scope user
 * ```
 *
 * @public
 */
export function registerPiThemesCommands(parent: Command): void {
  const themes = parent.command('themes').description('Manage Pi themes across tiers');

  themes
    .command('install <source>')
    .description('Install a Pi theme file (.ts/.tsx/.mts/.json)')
    .option('--scope <tier>', 'Install tier: project|user|global (default: project)')
    .option('--name <name>', 'Override the inferred theme name')
    .option('--force', 'Overwrite an existing theme at the target tier')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (source: string, opts: PiThemesInstallOptions) =>
      runLafsCommand('pi.themes.install', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);

        const absSource = resolve(source);
        if (!existsSync(absSource)) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.NOT_FOUND,
            `Source theme does not exist: ${absSource}`,
            'Check the path and try again.',
            false,
          );
        }
        const stats = statSync(absSource);
        if (!stats.isFile()) {
          throw new LAFSCommandError(
            PI_ERROR_CODES.VALIDATION,
            `Source theme is not a regular file: ${absSource}`,
            'Themes must be a single .ts/.tsx/.mts/.json file.',
            false,
          );
        }

        const name = opts.name ?? inferThemeName(absSource);
        const installOpts: HarnessInstallOptions = { force: opts.force ?? false };
        const result = await harness.installTheme(absSource, name, tier, projectDir, installOpts);
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

  themes
    .command('list')
    .description('List Pi themes across project, user, and global tiers')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (opts: PiThemesListOptions) =>
      runLafsCommand('pi.themes.list', 'standard', async () => {
        const harness = requirePiHarness();
        const projectDir = opts.projectDir ?? process.cwd();
        const entries = await harness.listThemes(projectDir);
        return {
          count: entries.length,
          themes: entries,
        };
      }),
    );

  themes
    .command('remove <name>')
    .description('Remove a Pi theme from the given tier')
    .option('--scope <tier>', 'Target tier: project|user|global (default: project)')
    .option('--project-dir <path>', 'Project directory for the project tier (default: cwd)')
    .action(async (name: string, opts: PiThemesRemoveOptions) =>
      runLafsCommand('pi.themes.remove', 'standard', async () => {
        const harness = requirePiHarness();
        const tier = parseScope(opts.scope, 'project');
        const projectDir = resolveProjectDir(tier, opts.projectDir);
        const removed = await harness.removeTheme(name, tier, projectDir);
        return { name, tier, removed };
      }),
    );
}
