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
import { CleoError, formatError, type InitOptions, initProject } from '@cleocode/core';
import { defineCommand } from 'citty';
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
    // Try package-local templates first, then monorepo root
    const localTemplatePath = join(packageRoot, 'templates', 'cleo-gitignore');
    const monorepoTemplatePath = join(packageRoot, '..', '..', 'templates', 'cleo-gitignore');
    const templatePath = existsSync(localTemplatePath) ? localTemplatePath : monorepoTemplatePath;

    if (existsSync(templatePath)) {
      return readFileSync(templatePath, 'utf-8');
    }
  } catch {
    // fallback
  }
  return '# CLEO Project Data - Selective Git Tracking\nagent-outputs/\n';
}

/**
 * Root init command — initialize CLEO in a project directory.
 *
 * Dispatches to `initProject` from core.
 * @task T4681
 * @epic T4663
 */
export const initCommand = defineCommand({
  meta: { name: 'init', description: 'Initialize CLEO in a project directory' },
  args: {
    projectName: {
      type: 'positional',
      description: 'Project name (alternative to --name)',
      required: false,
    },
    name: {
      type: 'string',
      description: 'Project name',
    },
    force: {
      type: 'boolean',
      description: 'Overwrite existing files',
      default: false,
    },
    detect: {
      type: 'boolean',
      description: 'Auto-detect project configuration',
      default: false,
    },
    'map-codebase': {
      type: 'boolean',
      description: 'Run codebase analysis and store findings to brain.db',
      default: false,
    },
    'install-seed-agents': {
      type: 'boolean',
      description: 'Install canonical CleoOS seed agent personas (.cant)',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const initOpts: InitOptions = {
        name: args.name || (args.projectName as string | undefined) || undefined,
        force: !!args.force,
        detect: !!args.detect,
        mapCodebase: !!args['map-codebase'],
        installSeedAgents: !!args['install-seed-agents'],
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
          // Phase 5 — greenfield/brownfield classification + LAFS nextSteps
          ...(result.classification ? { classification: result.classification } : {}),
          ...(result.nextSteps && result.nextSteps.length > 0
            ? { nextSteps: result.nextSteps }
            : {}),
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
  },
});
