/**
 * Core init logic - project initialization and maintenance.
 *
 * Single source of truth for all init operations. Both CLI and MCP
 * delegate here (shared-core pattern).
 *
 * Handles:
 *   1. .cleo/ directory structure creation
 *   2. Core data files (config.json, tasks.db)
 *   3. Schema file installation (.cleo/schemas/)
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

import { chmod, mkdir, access, writeFile, readFile, copyFile, symlink, lstat, unlink } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { readJson } from '../store/json.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { saveJson } from '../store/json.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getCleoDirAbsolute, getConfigPath, getProjectRoot, getCleoHome } from './paths.js';
import { migrateAgentOutputs } from './migration/agent-outputs.js';

const execFileAsync = promisify(execFile);

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

// ── Internal helpers ─────────────────────────────────────────────────

/**
 * Check if a file exists and is readable.
 * @task T4681
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strip legacy <!-- CLEO:START -->...<!-- CLEO:END --> blocks from a file.
 * Called before CAAMP injection to prevent competing blocks.
 * @task T4916
 */
async function stripCLEOBlocks(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  const content = await readFile(filePath, 'utf8');
  const stripped = content.replace(
    /\n?<!-- CLEO:START -->[\s\S]*?<!-- CLEO:END -->\n?/g, ''
  );
  if (stripped !== content) await writeFile(filePath, stripped, 'utf8');
}


/**
 * Create default config.json content.
 * @task T4681
 */
function createDefaultConfig(): Record<string, unknown> {
  return {
    version: '2.10.0',
    output: {
      defaultFormat: 'json',
      showColor: true,
      showUnicode: true,
      dateFormat: 'relative',
    },
    backup: {
      maxOperationalBackups: 10,
      maxSafetyBackups: 5,
    },
    hierarchy: {
      maxDepth: 3,
      maxSiblings: 0,
    },
    session: {
      autoStart: false,
      multiSession: false,
    },
    lifecycle: {
      mode: 'strict',
    },
  };
}


/**
 * Resolve the package root directory (where schemas/ and templates/ live).
 * @task T4681
 */
function getPackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // src/core/init.ts -> 3 levels up to package root
  return resolve(dirname(thisFile), '..', '..');
}

/**
 * Load the gitignore template from the package's templates/ directory.
 * Falls back to embedded content if file not found.
 * @task T4700
 */
function getGitignoreContent(): string {
  try {
    const packageRoot = getPackageRoot();
    const templatePath = join(packageRoot, 'templates', 'cleo-gitignore');
    if (existsSync(templatePath)) {
      return readFileSync(templatePath, 'utf-8');
    }
  } catch {
    // fallback
  }
  return CLEO_GITIGNORE_FALLBACK;
}

/** Embedded fallback for .cleo/.gitignore content (deny-by-default). */
const CLEO_GITIGNORE_FALLBACK = `# .cleo/.gitignore — Deny-by-default for CLEO project data
# Ignore everything, then explicitly allow only tracked files.

# Step 1: Ignore everything
*

# Allow list
!.gitignore
!config.json
!project-context.json
!project-info.json
!setup-otel.sh
!DATA-SAFETY-IMPLEMENTATION-SUMMARY.md
!schemas/
!schemas/**
!templates/
!templates/**
!adrs/
!adrs/**
!consensus/
!consensus/**
!rcasd/
!rcasd/**
!contributions/
!contributions/**
!agent-outputs/
!agent-outputs/**

# Explicit deny safety net
*.db
*.db-shm
*.db-wal
*.db-journal
log.json
tasks-log.jsonl
todo-log.jsonl
bypass-log.json
qa-log.json
.deps-cache/
.context-alert-state.json
.context-state*.json
context-states/
.git-checkpoint-state
.migration-state.json
migrations.json
sync/
metrics/
.backups/
backups/
`;

/**
 * Remove .cleo/ or .cleo entries from the project root .gitignore.
 * @task T4641
 */
async function removeCleoFromRootGitignore(projectRoot: string): Promise<boolean> {
  const rootGitignorePath = join(projectRoot, '.gitignore');
  if (!(await fileExists(rootGitignorePath))) {
    return false;
  }
  const content = await readFile(rootGitignorePath, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
  });
  if (filtered.length === lines.length) {
    return false;
  }
  await writeFile(rootGitignorePath, filtered.join('\n'));
  return true;
}

/**
 * Generate a 12-character hex hash from a project path.
 * @task T4684
 */
function generateProjectHash(projectPath: string): string {
  return createHash('sha256').update(projectPath).digest('hex').substring(0, 12);
}

/**
 * Read CLEO version from package.json.
 * @task T4684
 */
function getCleoVersion(): string {
  try {
    const pkgPath = join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Get the CLEO-INJECTION.md template content.
 * Looks in the package templates/ directory first, then falls back
 * to the project .cleo/templates/ directory.
 * @task T4682
 */
function getInjectionTemplateContent(): string | null {
  // First check package templates/
  const packageRoot = getPackageRoot();
  const packageTemplatePath = join(packageRoot, 'templates', 'CLEO-INJECTION.md');
  if (existsSync(packageTemplatePath)) {
    return readFileSync(packageTemplatePath, 'utf-8');
  }
  return null;
}

// ── Core init operations ─────────────────────────────────────────────

/**
 * Create core .cleo/ directory structure and data files.
 * @task T4681
 */
async function initCoreFiles(
  cleoDir: string,
  _projectName: string,
  force: boolean,
  created: string[],
  skipped: string[],
): Promise<void> {
  // Create .cleo directory
  await mkdir(cleoDir, { recursive: true });

  // Create config.json (human-editable settings — ADR-006 exception)
  const configPath = getConfigPath();
  if (await fileExists(configPath) && !force) {
    skipped.push('config.json');
  } else {
    await saveJson(configPath, createDefaultConfig());
    created.push('config.json');
  }

  // Remove legacy sequence files if they exist (migration)
  const legacySequencePath = join(cleoDir, '.sequence');
  try { await unlink(legacySequencePath); } catch { /* ignore if absent */ }
  const legacySequenceJsonPath = join(cleoDir, '.sequence.json');
  try { await unlink(legacySequenceJsonPath); } catch { /* ignore if absent */ }

  // Create backup directories
  const backupDir = join(cleoDir, 'backups');
  await mkdir(join(backupDir, 'operational'), { recursive: true });
  await mkdir(join(backupDir, 'safety'), { recursive: true });

  // Initialize SQLite database (tasks, sessions, archive, audit log all live here)
  try {
    const { getDb } = await import('../store/sqlite.js');
    await getDb(join(cleoDir, '..'));
    created.push('tasks.db');
  } catch (err) {
    // SQLite init failure is not fatal — will be created on first access
    // but we should note it
    created.push(`tasks.db (deferred: ${err instanceof Error ? err.message : String(err)})`);
  }

  // Create .cleo/.gitignore
  const gitignorePath = join(cleoDir, '.gitignore');
  if (await fileExists(gitignorePath) && !force) {
    skipped.push('.gitignore');
  } else {
    await writeFile(gitignorePath, getGitignoreContent());
    created.push('.gitignore');
  }
}

/**
 * Initialize the isolated .cleo/.git checkpoint repository.
 * Idempotent — skips if .cleo/.git already exists.
 * @task T4872
 */
async function initCleoGitRepo(
  cleoDir: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  const cleoGitDir = join(cleoDir, '.git');
  if (existsSync(cleoGitDir)) {
    return; // already initialized — idempotent
  }
  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: cleoGitDir,
    GIT_WORK_TREE: cleoDir,
  };
  try {
    await execFileAsync('git', ['init', '--quiet'], { cwd: cleoDir, env: gitEnv });
    await execFileAsync('git', ['config', 'user.email', 'cleo@local'], { cwd: cleoDir, env: gitEnv });
    await execFileAsync('git', ['config', 'user.name', 'CLEO'], { cwd: cleoDir, env: gitEnv });
    created.push('.cleo/.git (isolated checkpoint repository)');
  } catch (err) {
    warnings.push(`Could not initialize .cleo/.git: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Copy JSON schema files from the package schemas/ directory to .cleo/schemas/.
 * @task T4681
 */
async function initSchemas(
  cleoDir: string,
  force: boolean,
  created: string[],
  warnings: string[],
): Promise<void> {
  const schemasDir = join(cleoDir, 'schemas');
  await mkdir(schemasDir, { recursive: true });

  const packageRoot = getPackageRoot();
  const sourceSchemaDir = join(packageRoot, 'schemas');

  if (!existsSync(sourceSchemaDir)) {
    warnings.push('schemas/ directory not found in package root, skipping schema installation');
    return;
  }

  // Core schemas to copy (only config-file schemas — task/session/archive/log are in SQLite)
  const coreSchemas = [
    'config.schema.json',
    'project-info.schema.json',
    'project-context.schema.json',
  ];

  let copiedCount = 0;
  for (const schemaFile of coreSchemas) {
    const sourcePath = join(sourceSchemaDir, schemaFile);
    const destPath = join(schemasDir, schemaFile);

    if (!existsSync(sourcePath)) {
      continue;
    }

    if (await fileExists(destPath) && !force) {
      continue;
    }

    try {
      await copyFile(sourcePath, destPath);
      copiedCount++;
    } catch (err) {
      warnings.push(`Failed to copy schema ${schemaFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (copiedCount > 0) {
    created.push(`schemas/ (${copiedCount} files)`);
  }
}

/**
 * Install git hooks from the package templates/git-hooks/ directory.
 * Copies commit-msg and pre-commit hooks into .git/hooks/ if they don't
 * already exist (unless force is set).
 */
async function initGitHooks(
  projRoot: string,
  force: boolean,
  created: string[],
  warnings: string[],
): Promise<void> {
  const gitHooksDir = join(projRoot, '.git', 'hooks');
  if (!existsSync(join(projRoot, '.git'))) {
    warnings.push('No .git/ directory found, skipping git hook installation');
    return;
  }

  await mkdir(gitHooksDir, { recursive: true });

  const packageRoot = getPackageRoot();
  const sourceDir = join(packageRoot, 'templates', 'git-hooks');

  if (!existsSync(sourceDir)) {
    warnings.push('templates/git-hooks/ not found in package root, skipping git hook installation');
    return;
  }

  const hooks = ['commit-msg', 'pre-commit'];
  let installedCount = 0;

  for (const hook of hooks) {
    const sourcePath = join(sourceDir, hook);
    const destPath = join(gitHooksDir, hook);

    if (!existsSync(sourcePath)) {
      continue;
    }

    if (existsSync(destPath) && !force) {
      continue;
    }

    try {
      await copyFile(sourcePath, destPath);
      await chmod(destPath, 0o755);
      installedCount++;
    } catch (err) {
      warnings.push(`Failed to install git hook ${hook}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (installedCount > 0) {
    created.push(`git hooks (${installedCount} installed)`);
  }
}

/**
 * Create project-info.json with project metadata.
 * @task T4684
 */
async function initProjectInfo(
  cleoDir: string,
  projectRoot: string,
  force: boolean,
  created: string[],
  skipped: string[],
): Promise<void> {
  const projectInfoPath = join(cleoDir, 'project-info.json');

  if (await fileExists(projectInfoPath) && !force) {
    skipped.push('project-info.json');
    return;
  }

  const projectHash = generateProjectHash(projectRoot);
  const cleoVersion = getCleoVersion();
  const now = new Date().toISOString();

  // Read schema versions from their canonical sources — never hardcode.
  const { readSchemaVersionFromFile } = await import('./validation/schema-integrity.js');
  const { SQLITE_SCHEMA_VERSION } = await import('../store/sqlite.js');
  const configSchemaVersion = readSchemaVersionFromFile('config.schema.json') ?? cleoVersion;

  const projectInfo = {
    $schema: './schemas/project-info.schema.json',
    schemaVersion: '1.0.0',
    projectHash,
    cleoVersion,
    lastUpdated: now,
    schemas: {
      config: configSchemaVersion,
      sqlite: SQLITE_SCHEMA_VERSION,
    },
    injection: {
      'CLAUDE.md': null,
      'AGENTS.md': null,
      'GEMINI.md': null,
    },
    health: {
      status: 'unknown',
      lastCheck: null,
      issues: [],
    },
    features: {
      multiSession: false,
      verification: false,
      contextAlerts: false,
    },
  };

  await writeFile(projectInfoPath, JSON.stringify(projectInfo, null, 2));
  created.push('project-info.json');
}

/**
 * Inject CLEO content into agent instruction files via CAAMP.
 *
 * Uses AGENTS.md as the hub file: injects `@AGENTS.md` into CLAUDE.md,
 * GEMINI.md etc. via CAAMP's injectAll(), then injects CLEO protocol
 * content into AGENTS.md itself via inject().
 *
 * Target architecture:
 *   CLAUDE.md/GEMINI.md -> @AGENTS.md (via injectAll)
 *   AGENTS.md -> @~/.cleo/templates/CLEO-INJECTION.md + @.cleo/project-context.json
 *
 * @task T4682
 */
async function initInjection(
  projectRoot: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const { getInstalledProviders, inject, injectAll, buildInjectionContent } = await import('@cleocode/caamp');

    const providers = getInstalledProviders();
    if (providers.length === 0) {
      warnings.push('No AI agent providers detected, skipping injection');
      return;
    }

    // Step 0: Strip legacy CLEO blocks from all provider files and AGENTS.md
    for (const provider of providers) {
      const instructFile = join(projectRoot, provider.pathProject, provider.instructFile);
      await stripCLEOBlocks(instructFile);
    }
    await stripCLEOBlocks(join(projectRoot, 'AGENTS.md'));

    // Step 1: Inject @AGENTS.md into all provider instruction files (CLAUDE.md, GEMINI.md, etc.)
    const injectionContent = buildInjectionContent({ references: ['@AGENTS.md'] });
    const results = await injectAll(providers, projectRoot, 'project', injectionContent);

    const injected: string[] = [];
    for (const [filePath, action] of results) {
      const fileName = basename(filePath);
      injected.push(`${fileName} (${action})`);
    }

    if (injected.length > 0) {
      created.push(`injection: ${injected.join(', ')}`);
    }

    // Step 2: Inject CLEO protocol content into AGENTS.md itself
    const agentsMdPath = join(projectRoot, 'AGENTS.md');
    const agentsMdLines = ['@~/.cleo/templates/CLEO-INJECTION.md'];

    // Include project-context.json reference if it exists
    const projectContextPath = join(projectRoot, '.cleo', 'project-context.json');
    if (existsSync(projectContextPath)) {
      agentsMdLines.push('@.cleo/project-context.json');
    }

    const agentsAction = await inject(agentsMdPath, agentsMdLines.join('\n'));
    created.push(`AGENTS.md CLEO content (${agentsAction})`);

    // Step 3: Install CLEO-INJECTION.md to global templates dir
    const content = getInjectionTemplateContent();
    if (content) {
      const globalTemplatesDir = join(getCleoHome(), 'templates');
      await mkdir(globalTemplatesDir, { recursive: true });
      const globalPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
      if (!existsSync(globalPath)) {
        await writeFile(globalPath, content);
      }
    }

    // Step 4: Create global ~/.agents/AGENTS.md hub if it doesn't exist
    try {
      const globalAgentsDir = join(homedir(), '.agents');
      const globalAgentsMd = join(globalAgentsDir, 'AGENTS.md');
      await mkdir(globalAgentsDir, { recursive: true });
      // inject() from CAAMP creates or updates the file with the CAAMP block
      await inject(globalAgentsMd, '@~/.cleo/templates/CLEO-INJECTION.md');
    } catch {
      // Best-effort — don't fail init if global hub creation fails
    }
  } catch (err) {
    warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Install cleo-subagent agent definition to ~/.agents/agents/.
 * @task T4685
 */
async function initAgentDefinition(
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
async function initMcpServer(
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
async function initCoreSkills(
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
    let ctSkillsRoot: string | null = null;
    try {
      const packageRoot = getPackageRoot();
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
async function initNexusRegistration(
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

/**
 * Detect project type and write project-context.json.
 * @task T4687
 */
async function initProjectDetect(
  cleoDir: string,
  projectRoot: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const { detectProjectType } = await import('../store/project-detect.js');
    const info = detectProjectType(projectRoot);
    const contextPath = join(cleoDir, 'project-context.json');
    const context = {
      ...info,
      detectedAt: new Date().toISOString(),
    };
    await writeFile(contextPath, JSON.stringify(context, null, 2));
    created.push('project-context.json');
  } catch (err) {
    warnings.push(`Project detection failed: ${err instanceof Error ? err.message : String(err)}`);
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
  await initInjection(projRoot, created, warnings);

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

  // T4681: Core files (config.json, tasks.db, etc.)
  await initCoreFiles(cleoDir, projectName, force, created, skipped);

  // T4872: Isolated .cleo/.git checkpoint repository
  await initCleoGitRepo(cleoDir, created, warnings);

  // T4700: Migrate legacy agent-output directories before proceeding
  try {
    const migrationResult = migrateAgentOutputs(cleoDir, projRoot);
    if (migrationResult.migrated) {
      created.push(`agent-outputs migration: ${migrationResult.summary}`);
    }
  } catch {
    warnings.push('Agent-outputs migration failed (best-effort, run cleo upgrade to retry)');
  }

  // T4681: Schema files (.cleo/schemas/)
  await initSchemas(cleoDir, force, created, warnings);

  // Git hooks (commit-msg, pre-commit)
  await initGitHooks(projRoot, force, created, warnings);

  // T4684: Project info (.cleo/project-info.json)
  await initProjectInfo(cleoDir, projRoot, force, created, skipped);

  // T4682: Inject into agent instruction files via CAAMP (AGENTS.md hub pattern)
  await initInjection(projRoot, created, warnings);

  // T4685: Agent definition (cleo-subagent)
  await initAgentDefinition(created, warnings);

  // T4706: MCP server installation
  await initMcpServer(projRoot, created, warnings);

  // T4707 + T4689: Core skills installation
  await initCoreSkills(created, warnings);

  // T4684: NEXUS registration
  await initNexusRegistration(projRoot, projectName, created, warnings);

  // Remove .cleo/ from root .gitignore if present
  const rootGitignoreChanged = await removeCleoFromRootGitignore(projRoot);
  if (rootGitignoreChanged) {
    warnings.push('.cleo/ was found in root .gitignore and has been removed. CLEO uses .cleo/.gitignore for selective tracking.');
  }

  // T4687: Project detection (--detect flag)
  if (opts.detect) {
    await initProjectDetect(cleoDir, projRoot, created, warnings);
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
