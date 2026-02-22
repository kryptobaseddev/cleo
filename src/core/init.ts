/**
 * Core init logic - project initialization and maintenance.
 *
 * Single source of truth for all init operations. Both CLI and MCP
 * delegate here (shared-core pattern).
 *
 * Handles:
 *   1. .cleo/ directory structure creation
 *   2. Core data files (todo.json, config.json, sessions.json, etc.)
 *   3. Schema file installation (.cleo/schemas/)
 *   4. Sequence counter (.cleo/.sequence.json)
 *   5. Project info (.cleo/project-info.json)
 *   6. CAAMP injection into agent instruction files
 *   7. MCP server installation to detected providers
 *   8. Agent definition installation (cleo-subagent)
 *   9. Core skill installation via CAAMP
 *  10. NEXUS project registration
 *  11. Project type detection (--detect)
 *  12. Injection refresh (--update-docs)
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

import { mkdir, access, writeFile, readFile, copyFile, symlink, lstat, unlink } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { readJson } from '../store/json.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { saveJson } from '../store/json.js';
import { getCleoDirAbsolute, getTaskPath, getConfigPath, getProjectRoot, getCleoHome } from './paths.js';
import type { TaskFile } from '../types/task.js';

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
 * Create default todo.json content.
 * @task T4681
 */
function createDefaultTodo(projectName: string): TaskFile {
  const now = new Date().toISOString();
  return {
    version: '2.10.0',
    project: {
      name: projectName,
      currentPhase: null,
      phases: {},
    },
    lastUpdated: now,
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '',
      configVersion: '2.10.0',
    },
    focus: {
      currentTask: null,
    },
    tasks: [],
  };
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
      maxSiblings: 7,
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
 * Create default sessions.json content.
 * @task T4681
 */
function createDefaultSessions(projectName: string): Record<string, unknown> {
  return {
    version: '1.0.0',
    project: { name: projectName },
    sessions: [],
    _meta: { schemaVersion: '1.0.0' },
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

/** Embedded fallback for .cleo/.gitignore content. */
const CLEO_GITIGNORE_FALLBACK = `# CLEO Project Data - Selective Git Tracking
# Tracked: todo.json, config.json, sessions.json, templates/, schemas/
# IGNORED:
*.lock
*.tmp
.backups/
backups/
metrics/
audit-log-*.json
.context-state.json
.context-state-session_*.json
context-states/
*.db-journal
*.db-wal
*.db-shm
research/
rcsd/
.current-session
.git-checkpoint-state
backup-metadata.json
*.corrupted
*.bak
*.bak*
*.backup-*
agent-outputs/
.cache/
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
  projectName: string,
  force: boolean,
  created: string[],
  skipped: string[],
): Promise<void> {
  // Create .cleo directory
  await mkdir(cleoDir, { recursive: true });

  // Create todo.json
  const todoPath = getTaskPath();
  if (await fileExists(todoPath) && !force) {
    skipped.push('tasks.json');
  } else {
    await saveJson(todoPath, createDefaultTodo(projectName));
    created.push('tasks.json');
  }

  // Create config.json
  const configPath = getConfigPath();
  if (await fileExists(configPath) && !force) {
    skipped.push('config.json');
  } else {
    await saveJson(configPath, createDefaultConfig());
    created.push('config.json');
  }

  // Create sessions.json
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (await fileExists(sessionsPath) && !force) {
    skipped.push('sessions.json');
  } else {
    await saveJson(sessionsPath, createDefaultSessions(projectName));
    created.push('sessions.json');
  }

  // Create .sequence.json (task ID counter — JSON format for sequence module)
  const sequencePath = join(cleoDir, '.sequence.json');
  if (await fileExists(sequencePath) && !force) {
    skipped.push('.sequence.json');
  } else {
    await writeFile(sequencePath, JSON.stringify({ counter: 0, lastId: 'T000', checksum: '' }, null, 2));
    created.push('.sequence.json');
  }

  // Remove legacy .sequence plain-text file if it exists (migration)
  const legacySequencePath = join(cleoDir, '.sequence');
  try { await unlink(legacySequencePath); } catch { /* ignore if absent */ }

  // Create backup directories
  const backupDir = join(cleoDir, 'backups');
  await mkdir(join(backupDir, 'operational'), { recursive: true });
  await mkdir(join(backupDir, 'safety'), { recursive: true });

  // Create log file
  const logPath = join(cleoDir, 'todo-log.jsonl');
  if (!(await fileExists(logPath))) {
    const legacyLogPath = join(cleoDir, 'todo-log.json');
    if (await fileExists(legacyLogPath)) {
      const { rename: renameFile } = await import('node:fs/promises');
      await renameFile(legacyLogPath, logPath);
      created.push('todo-log.jsonl (migrated from todo-log.json)');
    } else {
      await writeFile(logPath, '');
      created.push('todo-log.jsonl');
    }
  }

  // Create archive file
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (!(await fileExists(archivePath))) {
    await writeFile(archivePath, JSON.stringify({
      version: '2.10.0',
      _meta: { schemaVersion: '2.10.0' },
      archivedTasks: [],
    }, null, 2));
    created.push('todo-archive.json');
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

  // Core schemas to copy
  const coreSchemas = [
    'todo.schema.json',
    'config.schema.json',
    'archive.schema.json',
    'log.schema.json',
    'sessions.schema.json',
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

  const projectInfo = {
    $schema: './schemas/project-info.schema.json',
    schemaVersion: '1.0.0',
    projectHash,
    cleoVersion,
    lastUpdated: now,
    schemas: {
      todo: '2.10.0',
      config: '2.10.0',
      archive: '2.10.0',
      log: '1.0.0',
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
 * Inject CLEO-INJECTION.md template into agent instruction files via CAAMP.
 *
 * Injects the template reference `@.cleo/templates/AGENT-INJECTION.md`
 * into CLAUDE.md, AGENTS.md, GEMINI.md etc. using CAAMP's inject/injectAll.
 *
 * @task T4682
 */
async function initInjection(
  projectRoot: string,
  created: string[],
  warnings: string[],
): Promise<void> {
  try {
    const {
      getInstalledProviders,
      injectAll,
    } = await import('@cleocode/caamp');

    const providers = getInstalledProviders();
    if (providers.length === 0) {
      warnings.push('No AI agent providers detected, skipping injection');
      return;
    }

    // The injection content references the local template which references
    // the global CLEO-INJECTION.md
    const injectionContent = '@.cleo/templates/AGENT-INJECTION.md';

    const results = await injectAll(providers, projectRoot, 'project', injectionContent);

    const injected: string[] = [];
    for (const [filePath, action] of results) {
      const fileName = basename(filePath);
      injected.push(`${fileName} (${action})`);
    }

    if (injected.length > 0) {
      created.push(`injection: ${injected.join(', ')}`);
    }
  } catch (err) {
    warnings.push(`CAAMP injection: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Install the AGENT-INJECTION.md template to .cleo/templates/.
 * This is the project-local copy that references the global CLEO-INJECTION.md.
 * @task T4682
 */
async function initInjectionTemplate(
  cleoDir: string,
  force: boolean,
  created: string[],
  skipped: string[],
  _warnings: string[],
): Promise<void> {
  const templatesDir = join(cleoDir, 'templates');
  await mkdir(templatesDir, { recursive: true });

  const targetPath = join(templatesDir, 'AGENT-INJECTION.md');

  if (await fileExists(targetPath) && !force) {
    skipped.push('templates/AGENT-INJECTION.md');
    return;
  }

  // The AGENT-INJECTION.md template references the global CLEO-INJECTION.md
  const content = getInjectionTemplateContent();
  if (content) {
    // Install CLEO-INJECTION.md to the global templates dir as well
    const globalTemplatesDir = join(getCleoHome(), 'templates');
    await mkdir(globalTemplatesDir, { recursive: true });
    const globalPath = join(globalTemplatesDir, 'CLEO-INJECTION.md');
    if (!existsSync(globalPath) || force) {
      await writeFile(globalPath, content);
    }
  }

  // Create the project-local AGENT-INJECTION.md that references global
  const agentInjectionContent = [
    '<!-- Unified into CLEO-INJECTION.md (v2.0.0). This file retained for backward compatibility. -->',
    '<!-- Agents receive the appropriate MVI tier from CLEO-INJECTION.md -->',
    '@~/.cleo/templates/CLEO-INJECTION.md',
    '',
  ].join('\n');

  await writeFile(targetPath, agentInjectionContent);
  created.push('templates/AGENT-INJECTION.md');
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
    const {
      getInstalledProviders,
      installSkill,
    } = await import('@cleocode/caamp');

    const providers = getInstalledProviders();
    if (providers.length === 0) {
      return;
    }

    // Find ct-skills package
    let ctSkillsRoot: string | null = null;
    try {
      // resolve from package root
      const packageRoot = getPackageRoot();
      const ctSkillsPath = join(packageRoot, 'node_modules', '@cleocode', 'ct-skills');
      if (existsSync(join(ctSkillsPath, 'skills.json'))) {
        ctSkillsRoot = ctSkillsPath;
      }
    } catch {
      // not found
    }

    if (!ctSkillsRoot) {
      warnings.push('ct-skills package not found, skipping core skill installation');
      return;
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

  // Re-install the injection template
  await initInjectionTemplate(cleoDir, true, created, [], warnings);

  // Re-inject into all provider instruction files
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

  // T4681: Core files (todo.json, config.json, sessions.json, .sequence.json, etc.)
  await initCoreFiles(cleoDir, projectName, force, created, skipped);

  // T4681: Schema files (.cleo/schemas/)
  await initSchemas(cleoDir, force, created, warnings);

  // T4684: Project info (.cleo/project-info.json)
  await initProjectInfo(cleoDir, projRoot, force, created, skipped);

  // T4682: Injection template (.cleo/templates/AGENT-INJECTION.md)
  await initInjectionTemplate(cleoDir, force, created, skipped, warnings);

  // T4682: Inject into agent instruction files via CAAMP
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
  const isInit = existsSync(cleoDir) && existsSync(join(cleoDir, 'todo.json'));

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
