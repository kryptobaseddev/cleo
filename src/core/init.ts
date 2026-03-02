/**
 * Core init logic - project initialization and maintenance.
 *
 * Single source of truth for all init operations. Both CLI and MCP
 * delegate here (shared-core pattern).
 *
 * Handles:
 *   1. .cleo/ directory structure creation
 *   2. Core data files (config.json, tasks.db)
 *   3. Schema file installation (~/.cleo/schemas/)
 *   4. Sequence counter (SQLite schema_meta)
 *   5. Project info (.cleo/project-info.json)
 *   6. CAAMP injection into agent instruction files (AGENTS.md hub pattern)
 *   7. MCP server installation to detected providers
 *   8. Agent definition installation (cleo-subagent)
 *   9. Core skill installation via CAAMP
 *  10. NEXUS project registration
 *  11. Project type detection (--detect)
 *  12. Injection refresh (--update-docs)
 *  13. Git hook installation (commit-msg, pre-commit)
 *
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

import { mkdir, copyFile, symlink, lstat, unlink } from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { readJson } from '../store/json.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { getCleoDirAbsolute, getProjectRoot } from './paths.js';
import { migrateAgentOutputs } from './migration/agent-outputs.js';

// Shared utility imports
import {
  ensureCleoStructure,
  ensureConfig,
  ensureGitignore,
  ensureProjectInfo,
  ensureProjectContext,
  ensureCleoGitRepo,
  removeCleoFromRootGitignore,
  getPackageRoot,
} from './scaffold.js';
import { ensureGitHooks } from './hooks.js';
import { ensureGlobalSchemas } from './schema-management.js';
import { ensureInjection } from './injection.js';

// ── Types ────────────────────────────────────────────────────────────

/** Options for the init operation. */
export interface InitOptions {
  /** Project name override. */
  name?: string;
  /** Overwrite existing files. */
  force?: boolean;
  /** Auto-detect project configuration. */
  detect?: boolean;
  /** Update agent documentation injections only. */
  updateDocs?: boolean;
}

/** Result of the init operation. */
export interface InitResult {
  initialized: boolean;
  directory: string;
  created: string[];
  skipped: string[];
  warnings: string[];
  updateDocsOnly?: boolean;
}

// ── Init-specific operations ─────────────────────────────────────────

/**
 * Install cleo-subagent agent definition to ~/.agents/agents/.
 * @task T4685
 */
export async function initAgentDefinition(
  created: string[],
  warnings: string[],
): Promise<void> {
  const packageRoot = getPackageRoot();
  const agentSourceDir = join(packageRoot, 'agents', 'cleo-subagent');

  if (!existsSync(agentSourceDir)) {
    warnings.push('agents/cleo-subagent/ not found in package, skipping agent definition install');
    return;
  }

  const globalAgentsDir = join(homedir(), '.agents', 'agents', 'cleo-subagent');
  await mkdir(dirname(globalAgentsDir), { recursive: true });

  try {
    // Check if symlink already exists
    try {
      const stat = await lstat(globalAgentsDir);
      if (stat.isSymbolicLink() || stat.isDirectory()) {
        // Already installed
        return;
      }
    } catch {
      // Doesn't exist, proceed to create
    }

    // Create symlink from ~/.agents/agents/cleo-subagent -> package agents/cleo-subagent/
    await symlink(agentSourceDir, globalAgentsDir, 'dir');
    created.push('agent: cleo-subagent (symlinked)');
  } catch (err) {
    // If symlink fails (e.g., permissions), try copying
    try {
      await mkdir(globalAgentsDir, { recursive: true });
      const files = readdirSync(agentSourceDir);
      for (const file of files) {
        await copyFile(join(agentSourceDir, file), join(globalAgentsDir, file));
      }
      created.push('agent: cleo-subagent (copied)');
    } catch (copyErr) {
      warnings.push(`Agent definition install: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
    }
  }
}

/**
 * Install MCP server config to all detected providers via CAAMP.
 * @task T4706
 */
export async function initMcpServer(
  projectRoot: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const { detectEnvMode, generateMcpServerEntry } = await import('./mcp/index.js');
    const {
      getInstalledProviders,
      installMcpServerToAll,
    } = await import('@cleocode/caamp');
    type McpServerConfig = import('@cleocode/caamp').McpServerConfig;

    const env = detectEnvMode();
    const serverEntry = generateMcpServerEntry(env) as McpServerConfig;
    const providers = getInstalledProviders();

    if (providers.length === 0) {
      return;
    }

    const results = await installMcpServerToAll(
      providers, 'cleo', serverEntry, 'project', projectRoot,
    );

    const successes = results.filter(r => r.success);
    const failures = results.filter(r => !r.success);

    if (successes.length > 0) {
      created.push(`MCP server: ${successes.map(r => r.provider.id).join(', ')}`);
    }

    for (const f of failures) {
      if (f.error) {
        warnings.push(`MCP install to ${f.provider.id}: ${f.error}`);
      }
    }
  } catch (err) {
    warnings.push(`MCP server install: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Install CLEO core skills to the canonical skills directory via CAAMP.
 * @task T4707
 * @task T4689
 */
export async function initCoreSkills(
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const { getInstalledProviders, installSkill, registerSkillLibraryFromPath } = await import('@cleocode/caamp');

    const providers = getInstalledProviders();
    if (providers.length === 0) {
      return;
    }

    // Find ct-skills package: bundled first, then node_modules fallback
    const packageRoot = getPackageRoot();
    let ctSkillsRoot: string | null = null;
    try {
      // Check bundled package first (packages/ct-skills/)
      const bundledPath = join(packageRoot, 'packages', 'ct-skills');
      if (existsSync(join(bundledPath, 'skills.json'))) {
        ctSkillsRoot = bundledPath;
      } else {
        // Fallback to node_modules
        const ctSkillsPath = join(packageRoot, 'node_modules', '@cleocode', 'ct-skills');
        if (existsSync(join(ctSkillsPath, 'skills.json'))) {
          ctSkillsRoot = ctSkillsPath;
        }
      }
    } catch {
      // not found
    }

    if (!ctSkillsRoot) {
      warnings.push('ct-skills package not found, skipping core skill installation');
      return;
    }

    // Register bundled skill library with CAAMP
    try {
      registerSkillLibraryFromPath(ctSkillsRoot);
    } catch {
      warnings.push('Failed to register skill library with CAAMP');
    }

    // Read the skills catalog to find core skills
    const catalogPath = join(ctSkillsRoot, 'skills.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    const skills: Array<{ name: string; path: string; core: boolean; category: string; tier: number }> = catalog.skills ?? [];

    // Install core and recommended skills (tier 0, 1, 2)
    const coreSkills = skills.filter(s => s.tier <= 2);

    const installed: string[] = [];
    for (const skill of coreSkills) {
      const skillSourceDir = dirname(join(ctSkillsRoot, skill.path));

      if (!existsSync(skillSourceDir)) {
        continue;
      }

      try {
        const result = await installSkill(skillSourceDir, skill.name, providers, true);
        if (result.success) {
          installed.push(skill.name);
        }
      } catch {
        // Skill may already be installed, continue
      }
    }

    if (installed.length > 0) {
      created.push(`skills: ${installed.length} core skills installed`);
    }
  } catch (err) {
    warnings.push(`Core skill install: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Register project with NEXUS.
 * @task T4684
 */
export async function initNexusRegistration(
  projectRoot: string,
  projectName: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const { nexusInit, nexusRegister } = await import('./nexus/registry.js');
    await nexusInit();
    await nexusRegister(projectRoot, projectName);
    created.push('NEXUS registration');
  } catch (err) {
    const errStr = String(err);
    if (!errStr.includes('already registered') && !errStr.includes('NEXUS_PROJECT_EXISTS')) {
      warnings.push(`NEXUS registration: ${err instanceof Error ? err.message : errStr}`);
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Run update-docs only: refresh all injections without reinitializing.
 * Re-injects CLEO-INJECTION.md into all detected agent instruction files.
 *
 * @task T4686
 */
export async function updateDocs(): Promise<InitResult> {
  const cleoDir = getCleoDirAbsolute();
  const projRoot = getProjectRoot();
  const created: string[] = [];
  const warnings: string[] = [];

  // Re-inject into all provider instruction files (and AGENTS.md hub)
  try {
    const result = await ensureInjection(projRoot);
    if (result.action !== 'skipped') {
      created.push(`injection: ${result.details ?? result.action}`);
    }
  } catch (err) {
    warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    initialized: true,
    directory: cleoDir,
    created,
    skipped: [],
    warnings,
    updateDocsOnly: true,
  };
}

/**
 * Run full project initialization.
 *
 * Creates the .cleo/ directory structure, installs schemas, templates,
 * agent definitions, MCP server configs, skills, and registers with NEXUS.
 *
 * @task T4681
 * @task T4682
 * @task T4684
 * @task T4685
 * @task T4686
 * @task T4687
 * @task T4689
 * @task T4706
 * @task T4707
 */
export async function initProject(opts: InitOptions = {}): Promise<InitResult> {
  // Handle --update-docs (T4686)
  if (opts.updateDocs) {
    return updateDocs();
  }

  const cleoDir = getCleoDirAbsolute();
  const projRoot = getProjectRoot();
  const projectName = opts.name ?? projRoot.split('/').pop() ?? 'My Project';
  const force = !!opts.force;

  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];

  // T4681: Create .cleo/ directory structure
  const structureResult = await ensureCleoStructure(projRoot);
  if (structureResult.action === 'created') {
    created.push('.cleo/ directory structure');
  }

  // T4681: Create config.json
  const configResult = await ensureConfig(projRoot, { force });
  if (configResult.action === 'skipped') {
    skipped.push('config.json');
  } else {
    created.push('config.json');
  }

  // Initialize SQLite database (tasks, sessions, archive, audit log all live here)
  try {
    const { getDb } = await import('../store/sqlite.js');
    await getDb(join(cleoDir, '..'));
    created.push('tasks.db');
  } catch (err) {
    // SQLite init failure is not fatal — will be created on first access
    created.push(`tasks.db (deferred: ${err instanceof Error ? err.message : String(err)})`);
  }

  // T4681: Create .cleo/.gitignore (respect force flag)
  if (force) {
    // When force is set, always overwrite — ensureGitignore does content-comparison only
    const gitignoreResult = await ensureGitignore(projRoot);
    if (gitignoreResult.action === 'skipped') {
      skipped.push('.gitignore');
    } else {
      created.push('.gitignore');
    }
  } else {
    const gitignorePath = join(cleoDir, '.gitignore');
    if (existsSync(gitignorePath)) {
      skipped.push('.gitignore');
    } else {
      const gitignoreResult = await ensureGitignore(projRoot);
      if (gitignoreResult.action !== 'skipped') {
        created.push('.gitignore');
      } else {
        skipped.push('.gitignore');
      }
    }
  }

  // Remove legacy sequence files if they exist (migration)
  const legacySequencePath = join(cleoDir, '.sequence');
  try { await unlink(legacySequencePath); } catch { /* ignore if absent */ }
  const legacySequenceJsonPath = join(cleoDir, '.sequence.json');
  try { await unlink(legacySequenceJsonPath); } catch { /* ignore if absent */ }

  // T4872: Isolated .cleo/.git checkpoint repository
  try {
    const gitRepoResult = await ensureCleoGitRepo(projRoot);
    if (gitRepoResult.action === 'created') {
      created.push('.cleo/.git (isolated checkpoint repository)');
    }
  } catch (err) {
    warnings.push(`Could not initialize .cleo/.git: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T4700: Migrate legacy agent-output directories before proceeding
  try {
    const migrationResult = migrateAgentOutputs(projRoot, cleoDir);
    if (migrationResult.migrated) {
      created.push(`agent-outputs migration: ${migrationResult.summary}`);
    }
  } catch {
    warnings.push('Agent-outputs migration failed (best-effort, run cleo upgrade to retry)');
  }

  // T4681: Schema files (~/.cleo/schemas/)
  try {
    const schemaResult = ensureGlobalSchemas({ force });
    const total = schemaResult.installed + schemaResult.updated;
    if (total > 0) {
      created.push(`schemas/ (${total} files)`);
    }
  } catch (err) {
    warnings.push(`Schema installation: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Git hooks (commit-msg, pre-commit)
  try {
    const hooksResult = await ensureGitHooks(projRoot, { force });
    if (hooksResult.action === 'created') {
      created.push(hooksResult.details ?? 'git hooks installed');
    } else if (hooksResult.action === 'skipped' && hooksResult.details?.includes('No .git/')) {
      warnings.push(hooksResult.details);
    } else if (hooksResult.action === 'skipped' && hooksResult.details?.includes('not found in package root')) {
      warnings.push(hooksResult.details);
    } else if (hooksResult.action === 'repaired' && hooksResult.details?.includes('error')) {
      // Hook errors reported via details in 'repaired' action
      const match = hooksResult.details.match(/Installed (\d+)/);
      if (match && parseInt(match[1]) > 0) {
        created.push(`git hooks (${match[1]} installed)`);
      }
      warnings.push(hooksResult.details);
    }
  } catch (err) {
    warnings.push(`Git hook installation: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T4684: Project info (.cleo/project-info.json)
  const projectInfoResult = await ensureProjectInfo(projRoot, { force });
  if (projectInfoResult.action === 'skipped') {
    skipped.push('project-info.json');
  } else {
    created.push('project-info.json');
  }

  // T4682: Inject into agent instruction files via CAAMP (AGENTS.md hub pattern)
  try {
    const injectionResult = await ensureInjection(projRoot);
    if (injectionResult.action !== 'skipped') {
      // Parse the details to get individual file actions for backward-compatible output
      if (injectionResult.details) {
        created.push(`injection: ${injectionResult.details}`);
      }
    } else if (injectionResult.details) {
      warnings.push(injectionResult.details);
    }
  } catch (err) {
    warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }

  // T4685: Agent definition (cleo-subagent)
  await initAgentDefinition(created, warnings);

  // T4706: MCP server installation
  await initMcpServer(projRoot, created, warnings);

  // T4707 + T4689: Core skills installation
  await initCoreSkills(created, warnings);

  // T4684: NEXUS registration
  await initNexusRegistration(projRoot, projectName, created, warnings);

  // Remove .cleo/ from root .gitignore if present
  const rootGitignoreResult = await removeCleoFromRootGitignore(projRoot);
  if (rootGitignoreResult.removed) {
    warnings.push('.cleo/ was found in root .gitignore and has been removed. CLEO uses .cleo/.gitignore for selective tracking.');
  }

  // T4687: Project detection (--detect flag)
  if (opts.detect) {
    try {
      const detectResult = await ensureProjectContext(projRoot, { force: true });
      if (detectResult.action !== 'skipped') {
        created.push('project-context.json');
      }
    } catch (err) {
      warnings.push(`Project detection failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    initialized: true,
    directory: cleoDir,
    created,
    skipped,
    warnings,
  };
}

/**
 * Check if auto-init is enabled via environment variable.
 * @task T4789
 */
export function isAutoInitEnabled(): boolean {
  return process.env.CLEO_AUTO_INIT === 'true';
}

/**
 * Check if a project is initialized and auto-init if configured.
 * Returns { initialized: true } if ready, throws otherwise.
 * @task T4789
 */
export async function ensureInitialized(projectRoot?: string): Promise<{ initialized: boolean }> {
  const root = projectRoot ?? getProjectRoot();
  const cleoDir = join(root, '.cleo');
  const isInit = existsSync(cleoDir) && (
    existsSync(join(cleoDir, 'tasks.db')) || existsSync(join(cleoDir, 'config.json'))
  );

  if (isInit) {
    return { initialized: true };
  }

  if (isAutoInitEnabled()) {
    await initProject({ name: basename(root) });
    return { initialized: true };
  }

  throw new Error('CLEO project not initialized. Run system.init or set CLEO_AUTO_INIT=true');
}

/**
 * Get the current CLEO/project version.
 * Checks VERSION file, then package.json.
 * @task T4789
 */
export async function getVersion(projectRoot?: string): Promise<{ version: string }> {
  const root = projectRoot ?? getProjectRoot();

  // Try VERSION file
  const versionPaths = [
    join(root, 'VERSION'),
    join(root, '..', 'VERSION'),
  ];

  for (const versionPath of versionPaths) {
    try {
      const content = await readFile(versionPath, 'utf-8');
      const version = content.trim();
      if (version) {
        return { version };
      }
    } catch {
      // Try next path
    }
  }

  // Fallback: package.json
  const pkg = await readJson<{ version: string }>(join(root, 'package.json'));
  if (pkg?.version) {
    return { version: pkg.version };
  }

  return { version: '0.0.0' };
}
