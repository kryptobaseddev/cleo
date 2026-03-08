/**
 * CLI init command - project initialization.
 *
 * Thin handler: parse args -> call core -> format output.
 * All business logic lives in src/core/init.ts (shared-core pattern).
 *
 * @task T4454
 * @task T4681
 * @task T4682
 * @task T4684
 * @task T4685
 * @task T4686
 * @task T4687
 * @task T4689
 * @task T4706
 * @task T4707
 * @epic T4663
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { CleoError } from '../../core/errors.js';
import { type InitOptions, initProject } from '../../core/init.js';
import { formatError } from '../../core/output.js';
import { cliOutput } from '../renderers/index.js';

/**
 * Load the gitignore template from the package's templates/ directory.
 * Falls back to embedded content if file not found.
 *
 * Kept as export for backward compatibility (used by upgrade.ts).
 * @task T4700
 */
export function getGitignoreTemplate(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const packageRoot = join(thisFile, '..', '..', '..', '..');
    const templatePath = join(packageRoot, 'templates', 'cleo-gitignore');

    if (existsSync(templatePath)) {
      return readFileSync(templatePath, 'utf-8');
    }
  } catch {
    // fallback
  }
  return '# CLEO Project Data - Selective Git Tracking\nagent-outputs/\n';
}

/**
 * Register the init command.
 * @task T4681
 * @epic T4663
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize CLEO in a project directory')
    .option('--name <name>', 'Project name')
    .option('--force', 'Overwrite existing files')
    .option('--detect', 'Auto-detect project configuration')
    .option('--refresh', 'Force re-detection of project type (alias for --detect)')
    .option('--update-docs', 'Update agent documentation injections')
    .argument('[projectName]', 'Project name (alternative to --name)')
    .action(async (projectName: string | undefined, opts: Record<string, unknown>) => {
      try {
        if (opts['refresh']) opts['detect'] = true;
        const initOpts: InitOptions = {
          name: (opts['name'] as string) || projectName || undefined,
          force: !!opts['force'],
          detect: !!opts['detect'],
          updateDocs: !!opts['updateDocs'],
        };

        const result = await initProject(initOpts);

        cliOutput(
          {
            initialized: result.initialized,
            directory: result.directory,
            created: result.created,
            skipped: result.skipped,
            ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
            ...(result.updateDocsOnly ? { updateDocsOnly: true } : {}),
          },
          { command: 'init' },
        );
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
