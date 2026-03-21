/**
 * Shared global bootstrap logic for CLEO.
 *
 * Contains the shared functions used by BOTH:
 *   - `bin/postinstall.js` (npm postinstall hook)
 *   - `cleo install-global` CLI command
 *
 * This is the single source of truth for global setup operations.
 * Neither postinstall nor install-global should duplicate this logic.
 *
 * @task T5267
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentsHome, getCleoTemplatesDir } from './paths.js';
import { ensureGlobalHome, getPackageRoot } from './scaffold.js';

// ── Types ────────────────────────────────────────────────────────────

/** Result tracking arrays passed through each bootstrap step. */
export interface BootstrapContext {
  created: string[];
  warnings: string[];
  isDryRun: boolean;
}

/** Options for bootstrapGlobalCleo. */
export interface BootstrapOptions {
  /** Preview changes without applying. */
  dryRun?: boolean;
  /** Override package root for template/skill discovery. */
  packageRoot?: string;
}

// ── Step 1: Create ~/.cleo/ and install templates ────────────────────

/**
 * Bootstrap the global CLEO directory structure and install templates.
 *
 * Creates:
 *   - ~/.cleo/templates/CLEO-INJECTION.md (from bundled template or injection content)
 *   - ~/.agents/AGENTS.md with CAAMP injection block
 *
 * This is idempotent — safe to call multiple times.
 */
export async function bootstrapGlobalCleo(options?: BootstrapOptions): Promise<BootstrapContext> {
  const ctx: BootstrapContext = {
    created: [],
    warnings: [],
    isDryRun: options?.dryRun ?? false,
  };

  // Step 0: Ensure global home structure and clean stale artifacts
  try {
    await ensureGlobalHome();
  } catch {
    // Best-effort — don't fail bootstrap if cleanup fails
  }

  // Step 1: Ensure global templates
  await ensureGlobalTemplatesBootstrap(ctx, options?.packageRoot);

  // Step 2: CAAMP injection into ~/.agents/AGENTS.md
  await injectAgentsHub(ctx);

  // Step 3: Install MCP server to detected providers
  await installMcpToProviders(ctx);

  // Step 4: Install core skills globally
  await installSkillsGlobally(ctx);

  // Step 5: Install agent definition (cleo-subagent symlink)
  await installAgentDefinitionGlobally(ctx);

  // Step 6: Install provider adapters
  await installProviderAdapters(ctx, options?.packageRoot);

  return ctx;
}

// ── Step 1: Global templates ─────────────────────────────────────────

async function ensureGlobalTemplatesBootstrap(
  ctx: BootstrapContext,
  packageRootOverride?: string,
): Promise<void> {
  const globalTemplatesDir = getCleoTemplatesDir();

  if (!ctx.isDryRun) {
    await mkdir(globalTemplatesDir, { recursive: true });
  }

  try {
    const pkgRoot = packageRootOverride ?? getPackageRoot();
    const templatePath = join(pkgRoot, 'templates', 'CLEO-INJECTION.md');
    if (existsSync(templatePath)) {
      const content = readFileSync(templatePath, 'utf-8');
      const destPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
      if (!ctx.isDryRun) {
        await writeFile(destPath, content);
      }
      ctx.created.push(
        `~/.cleo/templates/CLEO-INJECTION.md (${ctx.isDryRun ? 'would refresh' : 'refreshed'})`,
      );
    } else {
      // Fallback: try using the injection content generator
      try {
        const { getInjectionTemplateContent } = await import('./injection.js');
        const content = getInjectionTemplateContent();
        if (content) {
          const destPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
          if (!ctx.isDryRun) {
            await writeFile(destPath, content);
          }
          ctx.created.push(
            `~/.cleo/templates/CLEO-INJECTION.md (${ctx.isDryRun ? 'would refresh' : 'refreshed'} from embedded)`,
          );
        }
      } catch {
        ctx.warnings.push('Could not refresh CLEO-INJECTION.md template');
      }
    }
  } catch {
    ctx.warnings.push('Could not refresh CLEO-INJECTION.md template');
  }
}

// ── Step 2: CAAMP injection into ~/.agents/AGENTS.md ─────────────────

async function injectAgentsHub(ctx: BootstrapContext): Promise<void> {
  const globalAgentsDir = getAgentsHome();
  const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');

  try {
    const { inject, getInstalledProviders, injectAll, buildInjectionContent } = await import(
      '@cleocode/caamp'
    );

    if (!ctx.isDryRun) {
      await mkdir(globalAgentsDir, { recursive: true });

      // Strip legacy CLEO blocks (versioned markers from pre-CAAMP era)
      if (existsSync(globalAgentsMd)) {
        const content = await readFile(globalAgentsMd, 'utf8');
        const stripped = content.replace(
          /\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g,
          '',
        );
        if (stripped !== content) {
          await writeFile(globalAgentsMd, stripped, 'utf8');
        }
      }

      // CAAMP 1.8.1: inject() is idempotent AND consolidates duplicates
      const expectedContent = '@~/.cleo/templates/CLEO-INJECTION.md';
      const action = await inject(globalAgentsMd, expectedContent);
      ctx.created.push(`~/.agents/AGENTS.md (${action})`);
    } else {
      ctx.created.push('~/.agents/AGENTS.md (would create/update CAAMP block)');
    }

    // Inject @~/.agents/AGENTS.md into detected global provider files
    const providers = getInstalledProviders();

    if (providers.length === 0) {
      ctx.warnings.push('No AI provider installations detected');
    } else {
      const injectionContent = buildInjectionContent({
        references: ['@~/.agents/AGENTS.md'],
      });

      if (!ctx.isDryRun) {
        // Strip legacy CLEO blocks from global provider files first
        // (handles bare and versioned markers, e.g. <!-- CLEO:START v0.53.4 -->)
        for (const provider of providers) {
          const instructFilePath = join(provider.pathGlobal, provider.instructFile);
          if (existsSync(instructFilePath)) {
            const fileContent = await readFile(instructFilePath, 'utf8');
            const stripped = fileContent.replace(
              /\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g,
              '',
            );
            if (stripped !== fileContent) {
              await writeFile(instructFilePath, stripped, 'utf8');
            }
          }
        }

        const results = await injectAll(providers, homedir(), 'global', injectionContent);
        for (const [filePath, action] of results) {
          const displayPath = filePath.replace(homedir(), '~');
          ctx.created.push(`${displayPath} (${action})`);
        }
      } else {
        for (const p of providers) {
          const displayPath = join(p.pathGlobal, p.instructFile).replace(homedir(), '~');
          ctx.created.push(`${displayPath} (would update CAAMP block)`);
        }
      }
    }
  } catch (err) {
    ctx.warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Step 3: MCP server installation ──────────────────────────────────

/**
 * Install the CLEO MCP server config to all detected providers.
 */
export async function installMcpToProviders(ctx: BootstrapContext): Promise<void> {
  try {
    const { detectEnvMode, generateMcpServerEntry, getMcpServerName } = await import(
      './mcp/index.js'
    );
    const { getInstalledProviders, installMcpServerToAll } = await import('@cleocode/caamp');
    type McpServerConfig = import('@cleocode/caamp').McpServerConfig;

    const env = detectEnvMode();
    const serverEntry = generateMcpServerEntry(env) as McpServerConfig;
    const serverName = getMcpServerName(env);
    const providers = getInstalledProviders();

    if (providers.length > 0) {
      if (!ctx.isDryRun) {
        const results = await installMcpServerToAll(
          providers,
          serverName,
          serverEntry,
          'global',
          homedir(),
        );
        const successes = results.filter((r: { success: boolean }) => r.success);
        if (successes.length > 0) {
          ctx.created.push(
            `MCP configs: ${successes.map((r: { provider: { id: string } }) => r.provider.id).join(', ')}`,
          );
        }
      } else {
        ctx.created.push('MCP configs (would update)');
      }
    }
  } catch {
    ctx.warnings.push('MCP config update skipped (non-critical)');
  }
}

// ── Step 4: Core skills installation ─────────────────────────────────

/**
 * Install CLEO core skills globally via CAAMP.
 */
export async function installSkillsGlobally(ctx: BootstrapContext): Promise<void> {
  try {
    if (!ctx.isDryRun) {
      const { initCoreSkills } = await import('./init.js');
      await initCoreSkills(ctx.created, ctx.warnings);
    } else {
      ctx.created.push('core skills (would install/update)');
    }
  } catch (err) {
    ctx.warnings.push(
      `Core skills installation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 5: Agent definition installation ────────────────────────────

/**
 * Install the cleo-subagent agent definition to ~/.agents/agents/.
 * Delegates to initAgentDefinition() in init.ts which handles require.resolve
 * fallback and symlink/copy logic.
 */
async function installAgentDefinitionGlobally(ctx: BootstrapContext): Promise<void> {
  try {
    if (!ctx.isDryRun) {
      const { initAgentDefinition } = await import('./init.js');
      await initAgentDefinition(ctx.created, ctx.warnings);
    } else {
      ctx.created.push('agent: cleo-subagent (would symlink)');
    }
  } catch (err) {
    ctx.warnings.push(
      `Agent definition install: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Step 6: Provider adapter installation ────────────────────────────

async function installProviderAdapters(
  ctx: BootstrapContext,
  packageRootOverride?: string,
): Promise<void> {
  try {
    const { AdapterManager } = await import('./adapters/index.js');
    const pkgRoot = packageRootOverride ?? getPackageRoot();
    const manager = AdapterManager.getInstance(pkgRoot);
    manager.discover();
    const detected = manager.detectActive();

    for (const adapterId of detected) {
      try {
        const adapter = await manager.activate(adapterId);
        if (adapter.install) {
          if (!ctx.isDryRun) {
            const installResult = await adapter.install.install({
              projectDir: process.cwd(),
            });
            if (installResult.success) {
              ctx.created.push(`${adapterId} adapter (installed)`);
            }
          } else {
            ctx.created.push(`${adapterId} adapter (would install)`);
          }
        }
      } catch (activateErr) {
        ctx.warnings.push(
          `Adapter ${adapterId} skipped: ${activateErr instanceof Error ? activateErr.message : String(activateErr)}`,
        );
      }
    }
  } catch (err) {
    ctx.warnings.push(
      `Adapter install skipped: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
