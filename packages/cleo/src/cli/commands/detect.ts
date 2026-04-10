/**
 * CLI detect command — re-detect project type and update project-context.json.
 *
 * Standalone lightweight command that runs project detection without
 * the full init or upgrade flow. Updates .cleo/project-context.json
 * with fresh detection results.
 *
 * @task T480 — routes through dispatch (mutate admin detect) for consistency
 *              with the dispatch layer instead of calling core directly.
 */

import { dispatchFromCli } from '../../dispatch/adapters/cli.js';
import type { ShimCommand as Command } from '../commander-shim.js';

export function registerDetectCommand(program: Command): void {
  program
    .command('detect')
    .description('Re-detect project type and update project-context.json')
    .action(async () => {
      await dispatchFromCli(
        'mutate',
        'admin',
        'detect',
        {},
        { command: 'detect', operation: 'admin.detect' },
      );
    });
}
