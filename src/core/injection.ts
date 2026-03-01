/**
 * CAAMP injection management — manages agent instruction file injection.
 *
 * Extracted from init.ts to enable shared use across init, upgrade, and doctor.
 *
 * Handles:
 *   1. Injecting @AGENTS.md into provider instruction files (CLAUDE.md, GEMINI.md, etc.)
 *   2. Injecting CLEO protocol content into AGENTS.md itself
 *   3. Installing CLEO-INJECTION.md to global templates directory
 *   4. Creating global ~/.agents/AGENTS.md hub
 *   5. Stripping legacy CLEO blocks and removing deprecated files
 *   6. Checking injection health (CAAMP markers, @ reference resolution)
 *
 * @task T4682
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { getCleoHome } from './paths.js';
import { getPackageRoot, stripCLEOBlocks } from './scaffold.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  action: 'created' | 'repaired' | 'skipped';
  path: string;
  details?: string;
}

export interface InjectionCheckResult {
  id: string;
  category: string;
  status: 'passed' | 'failed' | 'warning' | 'info';
  message: string;
  details: Record<string, unknown>;
  fix: string | null;
}

// ── Template content ─────────────────────────────────────────────────

/**
 * Get the CLEO-INJECTION.md template content from the package templates/ directory.
 * Returns null if the template file is not found.
 */
export function getInjectionTemplateContent(): string | null {
  const packageRoot = getPackageRoot();
  const packageTemplatePath = join(packageRoot, 'templates', 'CLEO-INJECTION.md');
  if (existsSync(packageTemplatePath)) {
    return readFileSync(packageTemplatePath, 'utf-8');
  }
  return null;
}

// ── Legacy cleanup ───────────────────────────────────────────────────

/**
 * Remove deprecated .cleo/templates/AGENT-INJECTION.md if it exists.
 * This file was replaced by the global ~/.cleo/templates/CLEO-INJECTION.md
 * pattern in v0.75.0. Auto-cleaned during init and upgrade.
 */
async function removeStaleAgentInjection(projectRoot: string): Promise<boolean> {
  const stalePath = join(projectRoot, '.cleo', 'templates', 'AGENT-INJECTION.md');
  if (!existsSync(stalePath)) return false;
  await rm(stalePath, { force: true });
  return true;
}

// ── Ensure injection ─────────────────────────────────────────────────

/**
 * Full injection refresh: strip legacy blocks, inject CAAMP content,
 * install global template, create hub.
 *
 * Replaces initInjection from init.ts with a ScaffoldResult return type.
 *
 * Target architecture:
 *   CLAUDE.md/GEMINI.md -> @AGENTS.md (via injectAll)
 *   AGENTS.md -> @~/.cleo/templates/CLEO-INJECTION.md + @.cleo/project-context.json
 *
 * @task T4682
 */
export async function ensureInjection(projectRoot: string): Promise<ScaffoldResult> {
  // Dynamic import — @cleocode/caamp may not be installed
  let caamp: typeof import('@cleocode/caamp');
  try {
    caamp = await import('@cleocode/caamp');
  } catch {
    return {
      action: 'skipped',
      path: join(projectRoot, 'AGENTS.md'),
      details: '@cleocode/caamp not installed, skipping injection',
    };
  }

  const { getInstalledProviders, inject, injectAll, buildInjectionContent } = caamp;

  const providers = getInstalledProviders();
  if (providers.length === 0) {
    return {
      action: 'skipped',
      path: join(projectRoot, 'AGENTS.md'),
      details: 'No AI agent providers detected, skipping injection',
    };
  }

  const actions: string[] = [];

  // Step 0: Strip legacy CLEO blocks and remove deprecated AGENT-INJECTION.md
  for (const provider of providers) {
    const instructFile = join(projectRoot, provider.pathProject, provider.instructFile);
    await stripCLEOBlocks(instructFile);
  }
  await stripCLEOBlocks(join(projectRoot, 'AGENTS.md'));
  const removedStale = await removeStaleAgentInjection(projectRoot);
  if (removedStale) {
    actions.push('removed deprecated AGENT-INJECTION.md');
  }

  // Step 1: Inject @AGENTS.md into all provider instruction files
  const injectionContent = buildInjectionContent({ references: ['@AGENTS.md'] });
  const results = await injectAll(providers, projectRoot, 'project', injectionContent);

  for (const [filePath, action] of results) {
    const fileName = basename(filePath);
    actions.push(`${fileName} (${action})`);
  }

  // Step 2: Inject CLEO protocol content into AGENTS.md itself
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const agentsMdLines = ['@~/.cleo/templates/CLEO-INJECTION.md'];

  const projectContextPath = join(projectRoot, '.cleo', 'project-context.json');
  if (existsSync(projectContextPath)) {
    agentsMdLines.push('@.cleo/project-context.json');
  }

  const agentsAction = await inject(agentsMdPath, agentsMdLines.join('\n'));
  actions.push(`AGENTS.md CLEO content (${agentsAction})`);

  // Step 3: Install CLEO-INJECTION.md to global templates dir
  const content = getInjectionTemplateContent();
  if (content) {
    const globalTemplatesDir = join(getCleoHome(), 'templates');
    await mkdir(globalTemplatesDir, { recursive: true });
    const globalPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
    if (!existsSync(globalPath)) {
      await writeFile(globalPath, content);
      actions.push('installed global CLEO-INJECTION.md');
    }
  }

  // Step 4: Create global ~/.agents/AGENTS.md hub if it doesn't exist
  try {
    const globalAgentsDir = join(homedir(), '.agents');
    const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');
    await mkdir(globalAgentsDir, { recursive: true });
    await inject(globalAgentsMd, '@~/.cleo/templates/CLEO-INJECTION.md');
  } catch {
    // Best-effort — don't fail if global hub creation fails
  }

  return {
    action: actions.length > 0 ? 'repaired' : 'created',
    path: agentsMdPath,
    details: actions.join('; '),
  };
}

// ── Check injection health ───────────────────────────────────────────

/**
 * Verify injection health: AGENTS.md exists, has CAAMP markers,
 * markers are balanced, and @ references resolve.
 *
 * Combines logic from doctor/checks.ts checkAgentsMdHub,
 * checkCaampMarkerIntegrity, and checkAtReferenceTargetExists.
 */
export function checkInjection(projectRoot: string): InjectionCheckResult {
  const agentsMdPath = join(projectRoot, 'AGENTS.md');

  // Check 1: AGENTS.md exists
  if (!existsSync(agentsMdPath)) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md not found in project root',
      details: { path: agentsMdPath, exists: false },
      fix: 'cleo init --update-docs',
    };
  }

  // Check 2: AGENTS.md is readable
  let content: string;
  try {
    content = readFileSync(agentsMdPath, 'utf-8');
  } catch {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md exists but is not readable',
      details: { path: agentsMdPath, readable: false },
      fix: `chmod +r ${agentsMdPath}`,
    };
  }

  // Check 3: Has CAAMP markers
  const startCount = (content.match(/<!-- CAAMP:START -->/g) || []).length;
  const endCount = (content.match(/<!-- CAAMP:END -->/g) || []).length;

  if (startCount === 0) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: 'AGENTS.md exists but has no CAAMP markers',
      details: { path: agentsMdPath, hasCaampMarker: false },
      fix: 'cleo init --update-docs',
    };
  }

  // Check 4: Markers are balanced
  if (startCount !== endCount) {
    return {
      id: 'injection_health',
      category: 'configuration',
      status: 'warning',
      message: `CAAMP markers unbalanced: ${startCount} START vs ${endCount} END`,
      details: { path: agentsMdPath, startCount, endCount },
      fix: 'cleo init --update-docs',
    };
  }

  // Check 5: @ references resolve
  const caampMatch = content.match(/<!-- CAAMP:START -->([\s\S]*?)<!-- CAAMP:END -->/);
  if (caampMatch) {
    const block = caampMatch[1];
    const refs = block.match(/^@(.+)$/gm) || [];
    const missing: string[] = [];

    for (const ref of refs) {
      const rawPath = ref.slice(1).trim();
      const resolvedPath = rawPath.startsWith('~/')
        ? join(homedir(), rawPath.slice(2))
        : join(projectRoot, rawPath);

      if (!existsSync(resolvedPath)) {
        missing.push(rawPath);
      }
    }

    if (missing.length > 0) {
      return {
        id: 'injection_health',
        category: 'configuration',
        status: 'warning',
        message: `Missing @ reference targets: ${missing.join(', ')}`,
        details: { path: agentsMdPath, missing, totalRefs: refs.length },
        fix: 'cleo init --update-docs',
      };
    }
  }

  // Also check CLAUDE.md CAAMP marker integrity
  const claudeMdPath = join(projectRoot, 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      const claudeContent = readFileSync(claudeMdPath, 'utf-8');
      const cStartCount = (claudeContent.match(/<!-- CAAMP:START -->/g) || []).length;
      const cEndCount = (claudeContent.match(/<!-- CAAMP:END -->/g) || []).length;

      if (cStartCount !== cEndCount) {
        return {
          id: 'injection_health',
          category: 'configuration',
          status: 'warning',
          message: `CLAUDE.md CAAMP markers unbalanced: ${cStartCount} START vs ${cEndCount} END`,
          details: { file: 'CLAUDE.md', startCount: cStartCount, endCount: cEndCount },
          fix: 'cleo init --update-docs',
        };
      }

      if (cStartCount === 0) {
        return {
          id: 'injection_health',
          category: 'configuration',
          status: 'warning',
          message: 'CLAUDE.md has no CAAMP markers',
          details: { file: 'CLAUDE.md', hasCaampMarker: false },
          fix: 'cleo init --update-docs',
        };
      }
    } catch {
      // CLAUDE.md not readable — non-fatal
    }
  }

  return {
    id: 'injection_health',
    category: 'configuration',
    status: 'passed',
    message: 'CAAMP injection healthy: markers balanced, references resolve',
    details: { path: agentsMdPath, hasCaampMarker: true, markersBalanced: true },
    fix: null,
  };
}
