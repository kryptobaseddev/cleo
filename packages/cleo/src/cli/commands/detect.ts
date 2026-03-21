/**
 * CLI detect command — re-detect project type and update project-context.json.
 *
 * Standalone lightweight command that runs project detection without
 * the full init or upgrade flow. Updates .cleo/project-context.json
 * with fresh detection results.
 */

import { ensureProjectContext, getProjectRoot } from '@cleocode/core/internal';
import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

export function registerDetectCommand(program: Command): void {
  program
    .command('detect')
    .description('Re-detect project type and update project-context.json')
    .action(async () => {
      const projectRoot = getProjectRoot();
      const result = await ensureProjectContext(projectRoot, { staleDays: 0 });

      cliOutput(
        {
          action: result.action,
          path: result.path,
          details: result.details,
        },
        { command: 'detect' },
      );
    });
}
