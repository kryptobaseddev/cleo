/**
 * Global install/refresh command - refresh global CLEO setup.
 *
 * Equivalent to re-running the global steps from install.sh:
 *   - Refreshes ~/.cleo/templates/CLEO-INJECTION.md to latest bundled version
 *   - Creates/updates ~/.agents/AGENTS.md with CAAMP block
 *   - Injects @~/.agents/AGENTS.md into global provider files (CLAUDE.md, GEMINI.md, etc.)
 *   - Updates MCP server configs for each provider
 *
 * @task T4916
 */
import { Command } from 'commander';
import { cliOutput } from '../renderers/index.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getCleoHome } from '../../core/paths.js';

export function registerInstallGlobalCommand(program: Command): void {
  program
    .command('install-global')
    .description('Refresh global CLEO setup: provider files, MCP configs, templates')
    .option('--dry-run', 'Preview changes without applying')
    .action(async (opts: Record<string, unknown>) => {
      const isDryRun = !!opts['dryRun'];
      const created: string[] = [];
      const warnings: string[] = [];

      try {
        const cleoHome = getCleoHome();
        const globalTemplatesDir = join(cleoHome, 'templates');

        if (!isDryRun) {
          await mkdir(globalTemplatesDir, { recursive: true });
        }

        // Step 1: Refresh ~/.cleo/templates/CLEO-INJECTION.md
        try {
          const thisFile = fileURLToPath(import.meta.url);
          const packageRoot = resolve(dirname(thisFile), '..', '..', '..');
          const templatePath = join(packageRoot, 'templates', 'CLEO-INJECTION.md');
          if (existsSync(templatePath)) {
            const content = readFileSync(templatePath, 'utf-8');
            const globalPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
            if (!isDryRun) {
              await writeFile(globalPath, content);
            }
            created.push(`~/.cleo/templates/CLEO-INJECTION.md (${isDryRun ? 'would refresh' : 'refreshed'})`);
          }
        } catch {
          warnings.push('Could not refresh CLEO-INJECTION.md template');
        }

        // Step 2: Create/refresh ~/.agents/AGENTS.md
        const globalAgentsDir = join(homedir(), '.agents');
        const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');

        try {
          const { inject, getInstalledProviders, injectAll, buildInjectionContent } = await import('@cleocode/caamp');

          if (!isDryRun) {
            await mkdir(globalAgentsDir, { recursive: true });

            // Strip any legacy CLEO blocks first
            if (existsSync(globalAgentsMd)) {
              const content = await readFile(globalAgentsMd, 'utf8');
              const stripped = content.replace(/\n?<!-- CLEO:START -->[\s\S]*?<!-- CLEO:END -->\n?/g, '');
              if (stripped !== content) {
                await writeFile(globalAgentsMd, stripped, 'utf8');
              }
            }

            const action = await inject(globalAgentsMd, '@~/.cleo/templates/CLEO-INJECTION.md');
            created.push(`~/.agents/AGENTS.md (${action})`);
          } else {
            created.push('~/.agents/AGENTS.md (would create/update CAAMP block)');
          }

          // Step 3: Inject @~/.agents/AGENTS.md into detected global provider files
          const providers = getInstalledProviders();

          if (providers.length === 0) {
            warnings.push('No AI provider installations detected');
          } else {
            const injectionContent = buildInjectionContent({ references: ['@~/.agents/AGENTS.md'] });

            if (!isDryRun) {
              // Strip legacy CLEO blocks from global provider files first
              for (const provider of providers) {
                const instructFilePath = join(provider.pathGlobal, provider.instructFile);
                if (existsSync(instructFilePath)) {
                  const fileContent = await readFile(instructFilePath, 'utf8');
                  const stripped = fileContent.replace(/\n?<!-- CLEO:START -->[\s\S]*?<!-- CLEO:END -->\n?/g, '');
                  if (stripped !== fileContent) {
                    await writeFile(instructFilePath, stripped, 'utf8');
                  }
                }
              }

              const results = await injectAll(providers, homedir(), 'global', injectionContent);
              for (const [filePath, action] of results) {
                const displayPath = filePath.replace(homedir(), '~');
                created.push(`${displayPath} (${action})`);
              }
            } else {
              for (const p of providers) {
                const displayPath = join(p.pathGlobal, p.instructFile).replace(homedir(), '~');
                created.push(`${displayPath} (would update CAAMP block)`);
              }
            }
          }
        } catch (err) {
          warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Step 4: Update MCP server configs
        try {
          const { detectEnvMode, generateMcpServerEntry } = await import('../../core/mcp/index.js');
          const { getInstalledProviders, installMcpServerToAll } = await import('@cleocode/caamp');
          type McpServerConfig = import('@cleocode/caamp').McpServerConfig;

          const env = detectEnvMode();
          const serverEntry = generateMcpServerEntry(env) as McpServerConfig;
          const providers = getInstalledProviders();

          if (providers.length > 0) {
            if (!isDryRun) {
              const results = await installMcpServerToAll(providers, 'cleo', serverEntry, 'global', homedir());
              const successes = results.filter(r => r.success);
              if (successes.length > 0) {
                created.push(`MCP configs: ${successes.map(r => r.provider.id).join(', ')}`);
              }
            } else {
              created.push('MCP configs (would update)');
            }
          }
        } catch {
          warnings.push('MCP config update skipped (non-critical)');
        }

        cliOutput(
          {
            success: true,
            dryRun: isDryRun,
            updated: created,
            warnings: warnings.length > 0 ? warnings : undefined,
          },
          {
            command: 'install-global',
            message: isDryRun
              ? `Dry run: ${created.length} items would be updated`
              : `Global CLEO setup refreshed (${created.length} items)`,
          },
        );
      } catch (err) {
        cliOutput({ success: false, error: String(err) }, { command: 'install-global' });
        process.exit(1);
      }
    });
}
