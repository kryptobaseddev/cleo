/**
 * Global install/refresh command - refresh global CLEO setup.
 *
 * Delegates to the shared bootstrap module in @cleocode/core so that
 * both postinstall and `cleo install-global` use the same logic.
 *
 * Equivalent to re-running the global steps from postinstall:
 *   - Refreshes ~/.cleo/templates/CLEO-INJECTION.md to latest bundled version
 *   - Creates/updates ~/.agents/AGENTS.md with CAAMP block
 *   - Injects @~/.agents/AGENTS.md into global provider files
 *   - Updates MCP server configs for each provider
 *   - Installs core skills globally
 *   - Installs provider adapters
 *
 * @task T4916
 */

import type { ShimCommand as Command } from '../commander-shim.js';
import { cliOutput } from '../renderers/index.js';

export function registerInstallGlobalCommand(program: Command): void {
  program
    .command('install-global')
    .description('Refresh global CLEO setup: provider files, MCP configs, templates')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (opts: Record<string, unknown>) => {
      const isDryRun = !!opts['dryRun'];

      try {
        const { bootstrapGlobalCleo } = await import('@cleocode/core/internal');

        // No packageRoot override — let bootstrap resolve templates from
        // @cleocode/core's getPackageRoot() (templates live in core, not cleo)
        const result = await bootstrapGlobalCleo({
          dryRun: isDryRun,
        });

        cliOutput(
          {
            success: true,
            dryRun: isDryRun,
            updated: result.created,
            warnings: result.warnings.length > 0 ? result.warnings : undefined,
          },
          {
            command: 'install-global',
            message: isDryRun
              ? `Dry run: ${result.created.length} items would be updated`
              : `Global CLEO setup refreshed (${result.created.length} items)`,
          },
        );
      } catch (err) {
        cliOutput({ success: false, error: String(err) }, { command: 'install-global' });
        process.exit(1);
      }
    });
}
