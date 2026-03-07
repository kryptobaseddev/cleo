/**
 * Directory & file scaffolding utilities.
 *
 * Shared ensure/check functions extracted from init.ts for reuse
 * by init.ts, upgrade.ts, and doctor health checks.
 *
 * Rules:
 *   - All ensure functions are idempotent (safe to call multiple times)
 *   - All check functions are read-only (no side effects)
 *   - Uses imports from ./paths.js for path resolution
 */

import { mkdir, access, writeFile, readFile } from 'node:fs/promises';
import { constants as fsConstants, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveJson } from '../store/json.js';
import { getCleoDirAbsolute, getConfigPath, getCleoHome, getCleoTemplatesDir } from './paths.js';
import { generateProjectHash } from './nexus/hash.js';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

/** Result of an ensure* scaffolding operation. */
export interface ScaffoldResult {
  action: 'created' | 'repaired' | 'skipped';
  path: string;
  details?: string;
}

/** Status of a check* diagnostic. */
export type CheckStatus = 'passed' | 'failed' | 'warning' | 'info';

/** Result of a check* diagnostic (compatible with doctor/checks.ts CheckResult). */
export interface CheckResult {
  id: string;
  category: string;
  status: CheckStatus;
  message: string;
  details: Record<string, unknown>;
  fix: string | null;
}

// ── Constants ────────────────────────────────────────────────────────

/** Required subdirectories under .cleo/. */
export const REQUIRED_CLEO_SUBDIRS = [
  'backups/operational',
  'backups/safety',
  'agent-outputs',
  'logs',
  'rcasd',
  'adrs',
] as const;

/** Embedded fallback for .cleo/.gitignore content (deny-by-default). */
export const CLEO_GITIGNORE_FALLBACK = `# .cleo/.gitignore — Deny-by-default for CLEO project data
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
!adrs/
!adrs/**
!rcasd/
!rcasd/**
!agent-outputs/
!agent-outputs/**

# Explicit deny safety net
*.db
*.db-shm
*.db-wal
*.db-journal
log.json
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

// ── Pure helpers ─────────────────────────────────────────────────────

/**
 * Check if a file exists and is readable.
 */
export async function fileExists(path: string): Promise<boolean> {
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
 */
export async function stripCLEOBlocks(filePath: string): Promise<void> {
  if (!existsSync(filePath)) return;
  const content = await readFile(filePath, 'utf8');
  const stripped = content.replace(
    /\n?<!-- CLEO:START -->[\s\S]*?<!-- CLEO:END -->\n?/g, ''
  );
  if (stripped !== content) await writeFile(filePath, stripped, 'utf8');
}

/**
 * Remove .cleo/ or .cleo entries from the project root .gitignore.
 */
export async function removeCleoFromRootGitignore(
  projectRoot: string,
): Promise<{ removed: boolean }> {
  const rootGitignorePath = join(projectRoot, '.gitignore');
  if (!(await fileExists(rootGitignorePath))) {
    return { removed: false };
  }
  const content = await readFile(rootGitignorePath, 'utf-8');
  const lines = content.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    return !/^\/?\.cleo\/?(\*)?$/.test(trimmed);
  });
  if (filtered.length === lines.length) {
    return { removed: false };
  }
  await writeFile(rootGitignorePath, filtered.join('\n'));
  return { removed: true };
}

// generateProjectHash moved to src/core/nexus/hash.ts (canonical location)
export { generateProjectHash } from './nexus/hash.js';

/**
 * Resolve the package root directory (where schemas/ and templates/ live).
 * scaffold.ts lives in src/core/, so 2 levels up reaches the package root.
 */
export function getPackageRoot(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return resolve(dirname(thisFile), '..', '..');
}

/**
 * Load the gitignore template from the package's templates/ directory.
 * Falls back to embedded content if file not found.
 */
export function getGitignoreContent(): string {
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

/**
 * Read CLEO version from package.json.
 */
export function getCleoVersion(): string {
  try {
    const pkgPath = join(getPackageRoot(), 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Create default config.json content.
 */
export function createDefaultConfig(): Record<string, unknown> {
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

// ── ensure* functions (idempotent) ───────────────────────────────────

/**
 * Create .cleo/ directory and all required subdirectories.
 * Idempotent: skips directories that already exist.
 */
export async function ensureCleoStructure(
  projectRoot: string,
): Promise<ScaffoldResult> {
  const cleoDir = getCleoDirAbsolute(projectRoot);

  const alreadyExists = existsSync(cleoDir);
  await mkdir(cleoDir, { recursive: true });

  for (const subdir of REQUIRED_CLEO_SUBDIRS) {
    await mkdir(join(cleoDir, subdir), { recursive: true });
  }

  return {
    action: alreadyExists ? 'skipped' : 'created',
    path: cleoDir,
    details: alreadyExists
      ? 'Directory already existed, ensured subdirs'
      : `Created .cleo/ with ${REQUIRED_CLEO_SUBDIRS.length} subdirectories`,
  };
}

/**
 * Create or repair .cleo/.gitignore from template.
 * Idempotent: skips if file already exists with correct content.
 */
export async function ensureGitignore(
  projectRoot: string,
): Promise<ScaffoldResult> {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const gitignorePath = join(cleoDir, '.gitignore');
  const templateContent = getGitignoreContent();

  if (existsSync(gitignorePath)) {
    const existing = readFileSync(gitignorePath, 'utf-8');
    const normalize = (s: string) => s.trim().replace(/\r\n/g, '\n');
    if (normalize(existing) === normalize(templateContent)) {
      return { action: 'skipped', path: gitignorePath, details: 'Already matches template' };
    }
    await writeFile(gitignorePath, templateContent);
    return { action: 'repaired', path: gitignorePath, details: 'Updated to match template' };
  }

  await writeFile(gitignorePath, templateContent);
  return { action: 'created', path: gitignorePath };
}

/**
 * Create default config.json if missing.
 * Idempotent: skips if file already exists.
 */
export async function ensureConfig(
  projectRoot: string,
  opts?: { force?: boolean },
): Promise<ScaffoldResult> {
  const configPath = getConfigPath(projectRoot);

  if (existsSync(configPath) && !opts?.force) {
    return { action: 'skipped', path: configPath, details: 'Config already exists' };
  }

  await saveJson(configPath, createDefaultConfig());
  return {
    action: existsSync(configPath) ? 'repaired' : 'created',
    path: configPath,
  };
}

/**
 * Create or refresh project-info.json.
 * Idempotent: skips if file already exists (unless force).
 */
export async function ensureProjectInfo(
  projectRoot: string,
  opts?: { force?: boolean },
): Promise<ScaffoldResult> {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const projectInfoPath = join(cleoDir, 'project-info.json');

  // Backfill projectId on existing files that lack it (T5333)
  if (existsSync(projectInfoPath) && !opts?.force) {
    try {
      const existing = JSON.parse(readFileSync(projectInfoPath, 'utf-8'));
      if (typeof existing.projectId !== 'string' || existing.projectId.length === 0) {
        existing.projectId = randomUUID();
        existing.lastUpdated = new Date().toISOString();
        await writeFile(projectInfoPath, JSON.stringify(existing, null, 2));
        return { action: 'repaired', path: projectInfoPath, details: 'Added projectId' };
      }
    } catch {
      // If parse fails, fall through to regenerate
    }
    return { action: 'skipped', path: projectInfoPath, details: 'Already exists' };
  }

  const projectHash = generateProjectHash(projectRoot);
  const cleoVersion = getCleoVersion();
  const now = new Date().toISOString();

  const { readSchemaVersionFromFile } = await import('./validation/schema-integrity.js');
  const { SQLITE_SCHEMA_VERSION } = await import('../store/sqlite.js');
  const configSchemaVersion = readSchemaVersionFromFile('config.schema.json') ?? cleoVersion;
  const projectContextSchemaVersion = readSchemaVersionFromFile('project-context.schema.json') ?? '1.0.0';

  const projectInfo = {
    $schema: './schemas/project-info.schema.json',
    schemaVersion: '1.0.0',
    projectId: randomUUID(),
    projectHash,
    cleoVersion,
    lastUpdated: now,
    schemas: {
      config: configSchemaVersion,
      sqlite: SQLITE_SCHEMA_VERSION,
      projectContext: projectContextSchemaVersion,
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
  return { action: 'created', path: projectInfoPath };
}

/**
 * Detect and write project-context.json.
 * Idempotent: skips if file exists and is less than staleDays old (default: 30).
 */
export async function ensureProjectContext(
  projectRoot: string,
  opts?: { force?: boolean; staleDays?: number },
): Promise<ScaffoldResult> {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const contextPath = join(cleoDir, 'project-context.json');
  const staleDays = opts?.staleDays ?? 30;

  if (existsSync(contextPath) && !opts?.force) {
    try {
      const content = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (content.detectedAt) {
        const detectedAt = new Date(content.detectedAt);
        const ageMs = Date.now() - detectedAt.getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);
        if (ageDays < staleDays) {
          return { action: 'skipped', path: contextPath, details: `Fresh (${Math.floor(ageDays)}d old)` };
        }
      }
    } catch {
      // If we can't parse it, regenerate
    }
  }

  const { detectProjectType } = await import('../store/project-detect.js');
  const context = detectProjectType(projectRoot);

  // Validate against schema before writing (best-effort, never blocks write)
  try {
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), '../../schemas/project-context.schema.json');
    if (existsSync(schemaPath)) {
      const AjvModule = await import('ajv');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Ajv = (AjvModule as any).default ?? AjvModule;
      const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
      const ajv = new Ajv({ strict: false });
      const valid = ajv.validate(schema, context);
      if (!valid) {
        // eslint-disable-next-line no-console
        console.warn('[CLEO] project-context.json schema validation warnings:', ajv.errors);
      }
    }
  } catch {
    // Schema validation is best-effort — never block the write
  }

  await writeFile(contextPath, JSON.stringify(context, null, 2));

  return {
    action: existsSync(contextPath) ? 'repaired' : 'created',
    path: contextPath,
  };
}

/**
 * Initialize isolated .cleo/.git checkpoint repository.
 * Idempotent: skips if .cleo/.git already exists.
 */
export async function ensureCleoGitRepo(
  projectRoot: string,
): Promise<ScaffoldResult> {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const cleoGitDir = join(cleoDir, '.git');

  if (existsSync(cleoGitDir)) {
    return { action: 'skipped', path: cleoGitDir, details: 'Already initialized' };
  }

  const gitEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_DIR: cleoGitDir,
    GIT_WORK_TREE: cleoDir,
  };

  await execFileAsync('git', ['init', '--quiet'], { cwd: cleoDir, env: gitEnv });
  await execFileAsync('git', ['config', 'user.email', 'cleo@local'], { cwd: cleoDir, env: gitEnv });
  await execFileAsync('git', ['config', 'user.name', 'CLEO'], { cwd: cleoDir, env: gitEnv });

  return { action: 'created', path: cleoGitDir, details: 'Isolated checkpoint repository' };
}

/**
 * Create SQLite database if missing.
 * Idempotent: skips if tasks.db already exists.
 */
export async function ensureSqliteDb(
  projectRoot: string,
): Promise<ScaffoldResult> {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const dbPath = join(cleoDir, 'tasks.db');

  if (existsSync(dbPath)) {
    return { action: 'skipped', path: dbPath, details: 'tasks.db already exists' };
  }

  try {
    const { getDb } = await import('../store/sqlite.js');
    await getDb(projectRoot);
    return { action: 'created', path: dbPath, details: 'SQLite database initialized' };
  } catch (err) {
    return {
      action: 'skipped',
      path: dbPath,
      details: `Failed to initialize SQLite: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── check* functions (read-only) ─────────────────────────────────────

/**
 * Verify all required .cleo/ subdirectories exist.
 */
export function checkCleoStructure(projectRoot: string): CheckResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const missing: string[] = [];

  if (!existsSync(cleoDir)) {
    return {
      id: 'cleo_structure',
      category: 'scaffold',
      status: 'failed',
      message: '.cleo/ directory does not exist',
      details: { path: cleoDir, exists: false },
      fix: 'cleo init',
    };
  }

  for (const subdir of REQUIRED_CLEO_SUBDIRS) {
    if (!existsSync(join(cleoDir, subdir))) {
      missing.push(subdir);
    }
  }

  if (missing.length > 0) {
    return {
      id: 'cleo_structure',
      category: 'scaffold',
      status: 'warning',
      message: `Missing subdirectories: ${missing.join(', ')}`,
      details: { path: cleoDir, missing },
      fix: 'cleo init',
    };
  }

  return {
    id: 'cleo_structure',
    category: 'scaffold',
    status: 'passed',
    message: 'All required .cleo/ subdirectories exist',
    details: { path: cleoDir, subdirs: [...REQUIRED_CLEO_SUBDIRS] },
    fix: null,
  };
}

/**
 * Verify .cleo/.gitignore exists and matches template.
 */
export function checkGitignore(projectRoot: string): CheckResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const gitignorePath = join(cleoDir, '.gitignore');

  if (!existsSync(gitignorePath)) {
    return {
      id: 'cleo_gitignore',
      category: 'scaffold',
      status: 'warning',
      message: '.cleo/.gitignore not found',
      details: { path: gitignorePath, exists: false },
      fix: 'cleo init --force',
    };
  }

  const installed = readFileSync(gitignorePath, 'utf-8');
  const template = getGitignoreContent();
  const normalize = (s: string) => s.trim().replace(/\r\n/g, '\n');
  const matches = normalize(installed) === normalize(template);

  return {
    id: 'cleo_gitignore',
    category: 'scaffold',
    status: matches ? 'passed' : 'warning',
    message: matches
      ? '.cleo/.gitignore matches template'
      : '.cleo/.gitignore has drifted from template',
    details: { path: gitignorePath, matchesTemplate: matches },
    fix: matches ? null : 'cleo upgrade',
  };
}

/**
 * Verify config.json exists and is valid JSON.
 */
export function checkConfig(projectRoot: string): CheckResult {
  const configPath = getConfigPath(projectRoot);

  if (!existsSync(configPath)) {
    return {
      id: 'cleo_config',
      category: 'scaffold',
      status: 'failed',
      message: 'config.json not found',
      details: { path: configPath, exists: false },
      fix: 'cleo init',
    };
  }

  try {
    JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (err) {
    return {
      id: 'cleo_config',
      category: 'scaffold',
      status: 'failed',
      message: `config.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: configPath, valid: false },
      fix: 'cleo init --force',
    };
  }

  return {
    id: 'cleo_config',
    category: 'scaffold',
    status: 'passed',
    message: 'config.json exists and is valid JSON',
    details: { path: configPath, valid: true },
    fix: null,
  };
}

/**
 * Verify project-info.json exists with required fields.
 */
export function checkProjectInfo(projectRoot: string): CheckResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const infoPath = join(cleoDir, 'project-info.json');

  if (!existsSync(infoPath)) {
    return {
      id: 'cleo_project_info',
      category: 'scaffold',
      status: 'warning',
      message: 'project-info.json not found',
      details: { path: infoPath, exists: false },
      fix: 'cleo init',
    };
  }

  try {
    const content = JSON.parse(readFileSync(infoPath, 'utf-8'));
    const requiredFields = ['projectHash', 'cleoVersion', 'lastUpdated'];
    const missing = requiredFields.filter(f => !(f in content));

    if (missing.length > 0) {
      return {
        id: 'cleo_project_info',
        category: 'scaffold',
        status: 'warning',
        message: `project-info.json missing fields: ${missing.join(', ')}`,
        details: { path: infoPath, missingFields: missing },
        fix: 'cleo init --force',
      };
    }

    return {
      id: 'cleo_project_info',
      category: 'scaffold',
      status: 'passed',
      message: 'project-info.json exists with all required fields',
      details: { path: infoPath, valid: true },
      fix: null,
    };
  } catch (err) {
    return {
      id: 'cleo_project_info',
      category: 'scaffold',
      status: 'failed',
      message: `project-info.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: infoPath, valid: false },
      fix: 'cleo init --force',
    };
  }
}

/**
 * Verify project-context.json exists and is not stale (default: 30 days).
 */
export function checkProjectContext(
  projectRoot: string,
  staleDays: number = 30,
): CheckResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const contextPath = join(cleoDir, 'project-context.json');

  if (!existsSync(contextPath)) {
    return {
      id: 'cleo_project_context',
      category: 'scaffold',
      status: 'warning',
      message: 'project-context.json not found',
      details: { path: contextPath, exists: false },
      fix: 'cleo init --detect',
    };
  }

  try {
    const content = JSON.parse(readFileSync(contextPath, 'utf-8'));

    if (!content.detectedAt) {
      return {
        id: 'cleo_project_context',
        category: 'scaffold',
        status: 'warning',
        message: 'project-context.json missing detectedAt timestamp',
        details: { path: contextPath, hasTimestamp: false },
        fix: 'cleo init --detect',
      };
    }

    const detectedAt = new Date(content.detectedAt);
    const ageMs = Date.now() - detectedAt.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays > staleDays) {
      return {
        id: 'cleo_project_context',
        category: 'scaffold',
        status: 'warning',
        message: `project-context.json is stale (${Math.floor(ageDays)} days old, threshold: ${staleDays})`,
        details: { path: contextPath, ageDays: Math.floor(ageDays), staleDays },
        fix: 'cleo init --detect',
      };
    }

    return {
      id: 'cleo_project_context',
      category: 'scaffold',
      status: 'passed',
      message: `project-context.json is fresh (${Math.floor(ageDays)} days old)`,
      details: { path: contextPath, ageDays: Math.floor(ageDays), staleDays },
      fix: null,
    };
  } catch (err) {
    return {
      id: 'cleo_project_context',
      category: 'scaffold',
      status: 'failed',
      message: `project-context.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      details: { path: contextPath, valid: false },
      fix: 'cleo init --detect',
    };
  }
}

/**
 * Verify .cleo/.git checkpoint repository exists.
 */
export function checkCleoGitRepo(projectRoot: string): CheckResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const cleoGitDir = join(cleoDir, '.git');

  if (!existsSync(cleoGitDir)) {
    return {
      id: 'cleo_git_repo',
      category: 'scaffold',
      status: 'warning',
      message: '.cleo/.git checkpoint repository not found',
      details: { path: cleoGitDir, exists: false },
      fix: 'cleo init',
    };
  }

  return {
    id: 'cleo_git_repo',
    category: 'scaffold',
    status: 'passed',
    message: '.cleo/.git checkpoint repository exists',
    details: { path: cleoGitDir, exists: true },
    fix: null,
  };
}

/**
 * Verify .cleo/tasks.db exists and is non-empty.
 */
export function checkSqliteDb(projectRoot: string): CheckResult {
  const cleoDir = getCleoDirAbsolute(projectRoot);
  const dbPath = join(cleoDir, 'tasks.db');

  if (!existsSync(dbPath)) {
    return {
      id: 'sqlite_db',
      category: 'scaffold',
      status: 'failed',
      message: 'tasks.db not found',
      details: { path: dbPath, exists: false },
      fix: 'cleo init',
    };
  }

  const stat = statSync(dbPath);
  if (stat.size === 0) {
    return {
      id: 'sqlite_db',
      category: 'scaffold',
      status: 'warning',
      message: 'tasks.db exists but is empty (0 bytes)',
      details: { path: dbPath, exists: true, size: 0 },
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'sqlite_db',
    category: 'scaffold',
    status: 'passed',
    message: `tasks.db exists (${stat.size} bytes)`,
    details: { path: dbPath, exists: true, size: stat.size },
    fix: null,
  };
}

// ── Global (~/.cleo) scaffold functions ──────────────────────────────

/**
 * Required subdirectories under the global ~/.cleo/ home.
 * These are infrastructure directories managed by CLEO itself,
 * not project-specific data.
 */
export const REQUIRED_GLOBAL_SUBDIRS = [
  'schemas',
  'templates',
] as const;

/**
 * Ensure the global ~/.cleo/ home directory and its required
 * subdirectories exist. Idempotent: skips directories that already exist.
 *
 * This is the SSoT for global home scaffolding, replacing raw mkdirSync
 * calls that were previously scattered across global-bootstrap.ts.
 */
export async function ensureGlobalHome(): Promise<ScaffoldResult> {
  const cleoHome = getCleoHome();
  const alreadyExists = existsSync(cleoHome);

  await mkdir(cleoHome, { recursive: true });

  for (const subdir of REQUIRED_GLOBAL_SUBDIRS) {
    await mkdir(join(cleoHome, subdir), { recursive: true });
  }

  return {
    action: alreadyExists ? 'skipped' : 'created',
    path: cleoHome,
    details: alreadyExists
      ? 'Global home already existed, ensured subdirs'
      : `Created ~/.cleo/ with ${REQUIRED_GLOBAL_SUBDIRS.length} subdirectories`,
  };
}

/**
 * Ensure the global CLEO injection template is installed.
 * Delegates to injection.ts for the template content, but owns the
 * filesystem write to maintain SSoT for scaffolding.
 *
 * Idempotent: skips if the template already exists with correct content.
 */
export async function ensureGlobalTemplates(): Promise<ScaffoldResult> {
  // Lazy import to avoid circular dependency (injection imports scaffold)
  const { getInjectionTemplateContent } = await import('./injection.js');

  const templatesDir = getCleoTemplatesDir();
  const injectionPath = join(templatesDir, 'CLEO-INJECTION.md');

  // Ensure directory exists (idempotent via ensureGlobalHome, but defensive)
  await mkdir(templatesDir, { recursive: true });

  const templateContent = getInjectionTemplateContent();
  if (!templateContent) {
    return {
      action: 'skipped',
      path: injectionPath,
      details: 'Bundled injection template not found; skipped',
    };
  }

  if (existsSync(injectionPath)) {
    const existing = readFileSync(injectionPath, 'utf-8');
    if (existing === templateContent) {
      return { action: 'skipped', path: injectionPath, details: 'Template already current' };
    }
    // Content differs — repair
    await writeFile(injectionPath, templateContent, 'utf-8');
    return { action: 'repaired', path: injectionPath, details: 'Updated injection template to match bundled version' };
  }

  await writeFile(injectionPath, templateContent, 'utf-8');
  return { action: 'created', path: injectionPath };
}

/**
 * Perform a complete global scaffold operation: ensure home, schemas,
 * and templates are all present and current. This is the single entry
 * point for global infrastructure scaffolding.
 *
 * Used by:
 *   - MCP startup (via startupHealthCheck in health.ts)
 *   - init (for first-time global setup)
 *   - upgrade (for global repair)
 */
export async function ensureGlobalScaffold(): Promise<{
  home: ScaffoldResult;
  schemas: { installed: number; updated: number; total: number };
  templates: ScaffoldResult;
}> {
  // Lazy import to avoid circular dependency
  const { ensureGlobalSchemas } = await import('./schema-management.js');

  const home = await ensureGlobalHome();
  const schemas = ensureGlobalSchemas();
  const templates = await ensureGlobalTemplates();

  return { home, schemas, templates };
}

// ── Global check* functions (read-only diagnostics) ──────────────────

/**
 * Check that the global ~/.cleo/ home and its required subdirectories exist.
 * Read-only: no side effects.
 */
export function checkGlobalHome(): CheckResult {
  const cleoHome = getCleoHome();

  if (!existsSync(cleoHome)) {
    return {
      id: 'global_home',
      category: 'global',
      status: 'failed',
      message: 'Global ~/.cleo/ directory not found',
      details: { path: cleoHome, exists: false },
      fix: 'cleo init (or restart MCP server)',
    };
  }

  const missingDirs = REQUIRED_GLOBAL_SUBDIRS.filter(
    dir => !existsSync(join(cleoHome, dir)),
  );

  if (missingDirs.length > 0) {
    return {
      id: 'global_home',
      category: 'global',
      status: 'warning',
      message: `Global home exists but missing subdirs: ${missingDirs.join(', ')}`,
      details: { path: cleoHome, exists: true, missingDirs },
      fix: 'cleo upgrade --include-global',
    };
  }

  return {
    id: 'global_home',
    category: 'global',
    status: 'passed',
    message: 'Global ~/.cleo/ home and subdirectories present',
    details: { path: cleoHome, exists: true, subdirs: REQUIRED_GLOBAL_SUBDIRS.length },
    fix: null,
  };
}

/**
 * Check that the global injection template is present and current.
 * Read-only: no side effects.
 */
export function checkGlobalTemplates(): CheckResult {
  const templatesDir = getCleoTemplatesDir();
  const injectionPath = join(templatesDir, 'CLEO-INJECTION.md');

  if (!existsSync(injectionPath)) {
    return {
      id: 'global_templates',
      category: 'global',
      status: 'failed',
      message: 'CLEO-INJECTION.md template not found in global templates',
      details: { path: injectionPath, exists: false },
      fix: 'cleo init (or restart MCP server)',
    };
  }

  return {
    id: 'global_templates',
    category: 'global',
    status: 'passed',
    message: 'Global injection template present',
    details: { path: injectionPath, exists: true },
    fix: null,
  };
}

/**
 * Check that the project log directory exists.
 * Read-only: no side effects.
 */
export function checkLogDir(projectRoot: string): CheckResult {
  const logDir = join(getCleoDirAbsolute(projectRoot), 'logs');

  if (!existsSync(logDir)) {
    return {
      id: 'log_dir',
      category: 'scaffold',
      status: 'warning',
      message: 'Log directory .cleo/logs/ not found',
      details: { path: logDir, exists: false },
      fix: 'cleo upgrade',
    };
  }

  return {
    id: 'log_dir',
    category: 'scaffold',
    status: 'passed',
    message: 'Log directory .cleo/logs/ present',
    details: { path: logDir, exists: true },
    fix: null,
  };
}
