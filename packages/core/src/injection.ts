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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { getAgentsHome, getCleoHome, getCleoTemplatesTildePath } from './paths.js';
import { getPackageRoot, stripCLEOBlocks } from './scaffold.js';
import { resolveBridgeMode } from './system/bridge-mode.js';

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

/**
 * Strip hardcoded `<!-- gitnexus:start -->...<!-- gitnexus:end -->` blocks
 * from AGENTS.md. These blocks are replaced by the `@.cleo/nexus-bridge.md`
 * reference which contains auto-generated code intelligence content (T552).
 *
 * Also strips any other known vendor marker blocks using the same pattern
 * (e.g. `<!-- gitnexus:start -->...<!-- gitnexus:end -->`).
 *
 * @param filePath - Absolute path to the file to strip
 * @returns True if the file was modified, false otherwise
 */
export async function stripGitNexusBlocks(filePath: string): Promise<boolean> {
  if (!existsSync(filePath)) return false;
  const content = await readFile(filePath, 'utf8');
  // Strip <!-- gitnexus:start --> ... <!-- gitnexus:end --> blocks (case-insensitive markers)
  const stripped = content.replace(
    /\n?<!--\s*gitnexus:start\s*-->[\s\S]*?<!--\s*gitnexus:end\s*-->\n?/gi,
    '',
  );
  if (stripped !== content) {
    await writeFile(filePath, stripped, 'utf8');
    return true;
  }
  return false;
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
 *   AGENTS.md -> @~/.agents/AGENTS.md + @.cleo/project-context.json + @.cleo/memory-bridge.md + @.cleo/nexus-bridge.md
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
  const actions: string[] = [];

  if (providers.length === 0) {
    actions.push('No providers detected (AGENTS.md created without provider injection)');
  } else {
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

    // Step 0b: Strip hardcoded gitnexus blocks from AGENTS.md (T552)
    // These are replaced by the @.cleo/nexus-bridge.md reference.
    const removedGitNexus = await stripGitNexusBlocks(join(projectRoot, 'AGENTS.md'));
    if (removedGitNexus) {
      actions.push('removed hardcoded gitnexus block from AGENTS.md');
    }

    // Step 1: Inject @AGENTS.md into all provider instruction files
    const injectionContent = buildInjectionContent({ references: ['@AGENTS.md'] });
    const results = await injectAll(providers, projectRoot, 'project', injectionContent);

    for (const [filePath, action] of results) {
      const fileName = basename(filePath);
      actions.push(`${fileName} (${action})`);
    }
  }

  // Step 2: Inject CLEO protocol content into AGENTS.md itself
  // Project AGENTS.md references the global hub, which loads CLEO-INJECTION.md
  const agentsMdPath = join(projectRoot, 'AGENTS.md');
  const agentsMdLines = ['@~/.agents/AGENTS.md'];

  const projectContextPath = join(projectRoot, '.cleo', 'project-context.json');
  if (existsSync(projectContextPath)) {
    agentsMdLines.push('@.cleo/project-context.json');
  }

  // Memory bridge + nexus bridge: gated by brain.memoryBridge.mode (T999)
  // mode='cli' (default): inject a CLI directive so agents query brain.db live
  // mode='file': legacy @-inject of auto-generated markdown files (backcompat)
  const bridgeMode = await resolveBridgeMode(projectRoot);
  if (bridgeMode === 'file') {
    const memoryBridgePath = join(projectRoot, '.cleo', 'memory-bridge.md');
    if (existsSync(memoryBridgePath)) {
      agentsMdLines.push('@.cleo/memory-bridge.md');
    }

    const nexusBridgePath = join(projectRoot, '.cleo', 'nexus-bridge.md');
    if (existsSync(nexusBridgePath)) {
      agentsMdLines.push('@.cleo/nexus-bridge.md');
    }
  } else {
    // cli mode: inject a directive instructing agents to query live context
    agentsMdLines.push('# Run: cleo memory digest --brief');
  }

  // Contributor project warning (ADR-029): inject dev-channel guidance when
  // this project IS the CLEO source repo, so agents use cleo-dev not @latest.
  const contributorBlock = buildContributorInjectionBlock(projectRoot);
  if (contributorBlock) {
    agentsMdLines.push(contributorBlock);
  }

  const agentsMdContent = agentsMdLines.join('\n');

  // Direct call — CAAMP 1.8.0 handles idempotency
  const agentsAction = await inject(agentsMdPath, agentsMdContent);
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

  // Step 4: Create global ~/.agents/AGENTS.md hub (idempotent)
  try {
    const globalAgentsDir = getAgentsHome();
    const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');
    const globalHubContent = `@${getCleoTemplatesTildePath()}/CLEO-INJECTION.md`;
    await mkdir(globalAgentsDir, { recursive: true });
    // Direct call — CAAMP 1.8.0 handles idempotency
    await inject(globalAgentsMd, globalHubContent);
  } catch {
    // Best-effort — don't fail if global hub creation fails
  }

  return {
    action: actions.length > 0 ? 'repaired' : 'created',
    path: agentsMdPath,
    details: actions.join('; '),
  };
}

// ── Contributor project injection block (ADR-029) ────────────────────

/**
 * Probe whether the dev CLI binary is on PATH and responsive.
 * Returns an object with availability and version (or error details).
 * Non-blocking best-effort: returns { available: false } on any failure.
 */
function probeDevCli(devCli: string): { available: boolean; version?: string; error?: string } {
  const pathDirs = (process.env['PATH'] ?? '').split(':').filter(Boolean);
  const onPath = pathDirs.some((dir) => existsSync(join(dir, devCli)));
  if (!onPath) return { available: false, error: 'not on PATH' };
  try {
    const version = execFileSync(devCli, ['--version'], { timeout: 5000 }).toString().trim();
    return { available: true, version };
  } catch (err) {
    return { available: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Build a smart, contextual contributor block for AGENTS.md injection.
 * Returns null if this is not a contributor project.
 *
 * The block is INFORMATIONAL, not prescriptive. It tells agents:
 *   - This is the CLEO source repo (contributor project)
 *   - cleo-dev is available (or not, with reason)
 *   - Prefer cleo-dev for unreleased features, but fall back to cleo if
 *     the dev build is broken or unavailable
 *
 * This avoids the trap where a hardcoded "ALWAYS use cleo-dev" instruction
 * sends agents into a loop when the dev build has compile errors.
 */
export function buildContributorInjectionBlock(projectRoot: string): string | null {
  const configPath = join(projectRoot, '.cleo', 'config.json');
  if (!existsSync(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf-8')) as {
      contributor?: { isContributorProject?: boolean; devCli?: string };
    };
    if (!config.contributor?.isContributorProject) return null;
    const devCli = config.contributor.devCli ?? 'cleo-dev';

    const probe = probeDevCli(devCli);

    const lines: string[] = [
      '',
      '# CLEO Contributor Project — Dev Channel Available',
      '',
      'This project IS the CLEO source repository. Two CLEO channels are available:',
      '',
      `- **\`${devCli}\`** (local dev build) — reflects the current branch, may include unreleased operations`,
      '- **`cleo`** (production `@cleocode/cleo@latest`) — stable published version',
      '',
    ];

    if (probe.available) {
      lines.push(
        `**Dev channel status**: healthy (\`${devCli} --version\`: ${probe.version})`,
        '',
        `Prefer \`${devCli}\` when working on unreleased features or testing new operations.`,
        'Fall back to `cleo` if the dev build is broken or returns errors.',
      );
    } else {
      lines.push(
        `**Dev channel status**: unavailable (${probe.error})`,
        '',
        'Use `cleo` (production) until the dev build is fixed.',
        `To install the dev channel: \`./install.sh --dev\``,
      );
    }

    return lines.join('\n');
  } catch {
    return null;
  }
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
      fix: 'cleo upgrade',
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
      fix: 'cleo upgrade',
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
      fix: 'cleo upgrade',
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
      const resolvedPath =
        rawPath.startsWith('~/') || rawPath.startsWith('~\\')
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
        fix: 'cleo upgrade',
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
          fix: 'cleo upgrade',
        };
      }

      if (cStartCount === 0) {
        return {
          id: 'injection_health',
          category: 'configuration',
          status: 'warning',
          message: 'CLAUDE.md has no CAAMP markers',
          details: { file: 'CLAUDE.md', hasCaampMarker: false },
          fix: 'cleo upgrade',
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
