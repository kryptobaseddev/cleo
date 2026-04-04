/**
 * Shared global bootstrap logic for CLEO.
 *
 * Contains the shared functions used by BOTH:
 *   - `bin/postinstall.js` (npm postinstall hook)
 *   - `cleo install-global` CLI command
 *
 * This is the single source of truth for global setup operations.
 * This is the SSoT — postinstall and self-update both delegate here.
 *
 * @task T5267
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getAgentsHome, getCleoTemplatesDir, getCleoTemplatesTildePath } from './paths.js';
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
 *   - ~/.local/share/cleo/templates/CLEO-INJECTION.md (XDG primary)
 *   - ~/.cleo/templates/CLEO-INJECTION.md (legacy sync)
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

  // Step 1: Ensure global templates (XDG + legacy sync)
  await ensureGlobalTemplatesBootstrap(ctx, options?.packageRoot);

  // Step 2: CAAMP injection into ~/.agents/AGENTS.md
  await injectAgentsHub(ctx);

  // Step 3: (removed)

  // Step 4: Install core skills globally
  await installSkillsGlobally(ctx);

  // Step 5: Install agent definition (cleo-subagent symlink)
  await installAgentDefinitionGlobally(ctx);

  // Step 6: Install provider adapters
  await installProviderAdapters(ctx, options?.packageRoot);

  // Step 7: Verify injection chain health
  await verifyBootstrapHealth(ctx);

  return ctx;
}

// ── Step 1: Global templates ─────────────────────────────────────────

/**
 * Write template content to a destination path, creating parent dirs as needed.
 * Returns true if written, false if dry-run.
 */
async function writeTemplateTo(
  content: string,
  destPath: string,
  isDryRun: boolean,
): Promise<boolean> {
  if (isDryRun) return false;
  const { dirname } = await import('node:path');
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, content);
  return true;
}

async function ensureGlobalTemplatesBootstrap(
  ctx: BootstrapContext,
  packageRootOverride?: string,
): Promise<void> {
  const globalTemplatesDir = getCleoTemplatesDir();

  if (!ctx.isDryRun) {
    await mkdir(globalTemplatesDir, { recursive: true });
  }

  // Resolve template content from bundled file or embedded fallback
  let templateContent: string | null = null;

  try {
    const pkgRoot = packageRootOverride ?? getPackageRoot();
    const templatePath = join(pkgRoot, 'templates', 'CLEO-INJECTION.md');
    if (existsSync(templatePath)) {
      templateContent = readFileSync(templatePath, 'utf-8');
    }
  } catch {
    // Fall through to embedded fallback
  }

  if (!templateContent) {
    try {
      const { getInjectionTemplateContent } = await import('./injection.js');
      templateContent = getInjectionTemplateContent() ?? null;
    } catch {
      ctx.warnings.push('Could not refresh CLEO-INJECTION.md template');
      return;
    }
  }

  if (!templateContent) {
    ctx.warnings.push('Could not refresh CLEO-INJECTION.md template');
    return;
  }

  // Write to XDG primary path
  const xdgDest = join(globalTemplatesDir, 'CLEO-INJECTION.md');
  const xdgWritten = await writeTemplateTo(templateContent, xdgDest, ctx.isDryRun);
  ctx.created.push(
    `${getCleoTemplatesTildePath()}/CLEO-INJECTION.md (${xdgWritten ? 'refreshed' : 'would refresh'})`,
  );

  // Sync to legacy ~/.cleo/templates/ if it exists (backward compat for
  // project AGENTS.md files that still reference the old path)
  const home = homedir();
  const legacyTemplatesDir = join(home, '.cleo', 'templates');
  if (legacyTemplatesDir !== globalTemplatesDir && existsSync(join(home, '.cleo'))) {
    const legacyDest = join(legacyTemplatesDir, 'CLEO-INJECTION.md');
    const legacyWritten = await writeTemplateTo(templateContent, legacyDest, ctx.isDryRun);
    if (legacyWritten) {
      ctx.created.push('~/.cleo/templates/CLEO-INJECTION.md (legacy sync)');
    }
  }
}

// ── Step 2: CAAMP injection into ~/.agents/AGENTS.md ─────────────────

/**
 * Sanitize a CAAMP-managed file by removing orphaned content outside
 * CAAMP blocks. This fixes corruption from failed CAAMP consolidation
 * (e.g. partial old block removal leaving `TION.md` fragments).
 *
 * Strategy: keep ONLY content inside valid CAAMP blocks + any non-CAAMP
 * user content that doesn't look like an orphaned reference fragment.
 */
function sanitizeCaampFile(content: string): string {
  // Remove any duplicate <!-- CAAMP:END --> markers
  let cleaned = content.replace(/(<!-- CAAMP:END -->)\s*(<!-- CAAMP:END -->)/g, '$1');

  // Remove orphaned content between CAAMP:END and the next CAAMP:START (or EOF)
  // that looks like a fragment of a CLEO reference (e.g. "TION.md", "INJECTION.md")
  cleaned = cleaned.replace(
    /<!-- CAAMP:END -->\s*[A-Z][A-Za-z-]*\.md\s*(?:<!-- CAAMP:END -->)?/g,
    '<!-- CAAMP:END -->',
  );

  // Remove any lines that are just orphaned .md filename fragments
  // (leftover from partial CAAMP block removal)
  cleaned = cleaned.replace(/^[A-Z][A-Za-z-]*\.md\s*$/gm, '');

  // Collapse multiple blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned.trim() + '\n';
}

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
      // AND sanitize CAAMP corruption (orphaned fragments from bad consolidation)
      if (existsSync(globalAgentsMd)) {
        const content = await readFile(globalAgentsMd, 'utf8');

        // Step A: Remove legacy <!-- CLEO:START -->...<!-- CLEO:END --> blocks
        const stripped = content.replace(
          /\n?<!-- CLEO:START[^>]*-->[\s\S]*?<!-- CLEO:END -->\n?/g,
          '',
        );

        // Step B: Sanitize CAAMP corruption (orphaned fragments, duplicate markers)
        const sanitized = sanitizeCaampFile(stripped);

        if (sanitized !== content) {
          await writeFile(globalAgentsMd, sanitized, 'utf8');
          ctx.created.push('~/.agents/AGENTS.md (sanitized CAAMP corruption)');
        }
      }

      // CAAMP inject() is idempotent — writes the current XDG template reference
      const templateRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
      const action = await inject(globalAgentsMd, templateRef);
      ctx.created.push(`~/.agents/AGENTS.md (${action})`);

      // Post-inject validation: verify the file is clean
      const postContent = await readFile(globalAgentsMd, 'utf8');
      const caampBlocks = postContent.match(/<!-- CAAMP:START -->/g);
      const caampEnds = postContent.match(/<!-- CAAMP:END -->/g);
      if (caampBlocks && caampEnds && caampBlocks.length !== caampEnds.length) {
        ctx.warnings.push(
          `~/.agents/AGENTS.md has mismatched CAAMP markers (${caampBlocks.length} START vs ${caampEnds.length} END)`,
        );
      }
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

// ── Step 3: (removed) ───────────────────────────────────────────────

/**
 * No-op. Kept for API compatibility.
 */
export async function installMcpToProviders(_ctx: BootstrapContext): Promise<void> {
  // No-op: removed
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

// ── Step 7: Post-bootstrap health verification ───────────────────────

/**
 * Verify the injection chain is intact after bootstrap.
 * Checks:
 *   1. XDG template exists and has a version header
 *   2. Legacy template (if present) matches XDG version
 *   3. ~/.agents/AGENTS.md references the correct template path
 *   4. No orphaned content in AGENTS.md
 */
async function verifyBootstrapHealth(ctx: BootstrapContext): Promise<void> {
  if (ctx.isDryRun) return;

  try {
    const xdgTemplatePath = join(getCleoTemplatesDir(), 'CLEO-INJECTION.md');
    const agentsMd = join(getAgentsHome(), 'AGENTS.md');

    // Check 1: XDG template exists
    if (!existsSync(xdgTemplatePath)) {
      ctx.warnings.push('Health: XDG template missing after bootstrap');
      return;
    }

    const xdgContent = await readFile(xdgTemplatePath, 'utf8');
    const xdgVersion = xdgContent.match(/^Version:\s*(.+)$/m)?.[1]?.trim();

    // Check 2: Legacy template version sync
    const home = homedir();
    const legacyTemplatePath = join(home, '.cleo', 'templates', 'CLEO-INJECTION.md');
    if (existsSync(legacyTemplatePath)) {
      const legacyContent = await readFile(legacyTemplatePath, 'utf8');
      const legacyVersion = legacyContent.match(/^Version:\s*(.+)$/m)?.[1]?.trim();
      if (legacyVersion !== xdgVersion) {
        ctx.warnings.push(
          `Health: Legacy template version (${legacyVersion}) != XDG version (${xdgVersion})`,
        );
      }
    }

    // Check 3: AGENTS.md references the correct path
    if (existsSync(agentsMd)) {
      const agentsContent = await readFile(agentsMd, 'utf8');
      const expectedRef = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
      if (!agentsContent.includes(expectedRef)) {
        ctx.warnings.push(`Health: ~/.agents/AGENTS.md does not reference ${expectedRef}`);
      }

      // Check 4: No orphaned .md fragments outside CAAMP blocks
      const outsideCaamp = agentsContent.replace(
        /<!-- CAAMP:START -->[\s\S]*?<!-- CAAMP:END -->/g,
        '',
      );
      if (/[A-Z][A-Za-z-]*\.md/.test(outsideCaamp)) {
        ctx.warnings.push('Health: ~/.agents/AGENTS.md has orphaned content outside CAAMP blocks');
      }
    }
  } catch {
    // Health check is non-critical — don't fail bootstrap
  }
}
