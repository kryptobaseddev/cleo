/**
 * XDG-compliant path resolution for CLEO V2.
 *
 * Environment variables:
 *   CLEO_HOME   - Global installation directory (default: ~/.cleo)
 *   CLEO_DIR    - Project data directory (default: .cleo)
 *
 * @epic T4454
 * @task T4458
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { getPlatformPaths } from './system/platform-paths.js';

/**
 * Check if a CLEO project is initialized at the given root.
 * Checks for tasks.db.
 *
 * @param projectRoot - Absolute path to check; defaults to the resolved project root
 * @returns True if .cleo/ and tasks.db exist at the given root
 *
 * @remarks
 * A project is considered initialized when both the .cleo/ directory and
 * the tasks.db SQLite database file are present.
 *
 * @example
 * ```typescript
 * if (isProjectInitialized('/my/project')) {
 *   console.log('CLEO project found');
 * }
 * ```
 */
export function isProjectInitialized(projectRoot?: string): boolean {
  const root = projectRoot ?? getProjectRoot();
  const cleoDir = join(root, '.cleo');
  return existsSync(cleoDir) && existsSync(join(cleoDir, 'tasks.db'));
}

/**
 * Get the global CLEO home directory.
 * Respects CLEO_HOME env var; otherwise uses the OS-appropriate data path
 * via env-paths (XDG_DATA_HOME on Linux, Library/Application Support on macOS,
 * %LOCALAPPDATA% on Windows).
 *
 * @returns Absolute path to the global CLEO data directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().data` which uses the `env-paths` package
 * for XDG-compliant path resolution across operating systems.
 *
 * @example
 * ```typescript
 * const home = getCleoHome(); // e.g. "/home/user/.local/share/cleo"
 * ```
 */
export function getCleoHome(): string {
  return getPlatformPaths().data;
}

/**
 * Get the global CLEO templates directory.
 *
 * @returns Absolute path to the templates directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/templates` where CLEO-INJECTION.md and other global
 * templates are stored.
 *
 * @example
 * ```typescript
 * const dir = getCleoTemplatesDir(); // e.g. "/home/user/.local/share/cleo/templates"
 * ```
 */
export function getCleoTemplatesDir(): string {
  return join(getCleoHome(), 'templates');
}

/**
 * Get the global CLEO schemas directory.
 *
 * @returns Absolute path to the schemas directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/schemas`. Note that schemas are typically read at
 * runtime from the npm package root, not this global directory.
 *
 * @example
 * ```typescript
 * const dir = getCleoSchemasDir();
 * ```
 */
export function getCleoSchemasDir(): string {
  return join(getCleoHome(), 'schemas');
}

/**
 * Get the global CLEO docs directory.
 *
 * @returns Absolute path to the docs directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/docs` for global documentation storage.
 *
 * @example
 * ```typescript
 * const dir = getCleoDocsDir();
 * ```
 */
export function getCleoDocsDir(): string {
  return join(getCleoHome(), 'docs');
}

/**
 * Get the project CLEO data directory (relative).
 * Respects CLEO_DIR env var, defaults to ".cleo".
 *
 * @param cwd - Optional working directory; when provided, returns absolute path
 * @returns Relative or absolute path to the project's .cleo directory
 *
 * @remarks
 * If `cwd` is provided, delegates to `getCleoDirAbsolute`. Otherwise returns
 * the `CLEO_DIR` env var or the default ".cleo" relative path.
 *
 * @example
 * ```typescript
 * const rel = getCleoDir();           // ".cleo"
 * const abs = getCleoDir('/project'); // "/project/.cleo"
 * ```
 */
export function getCleoDir(cwd?: string): string {
  if (cwd) {
    return getCleoDirAbsolute(cwd);
  }
  return process.env['CLEO_DIR'] ?? '.cleo';
}

/**
 * Get the absolute path to the project CLEO directory.
 *
 * @param cwd - Optional working directory to resolve against; defaults to process.cwd()
 * @returns Absolute path to the project's .cleo directory
 *
 * @remarks
 * If CLEO_DIR is already absolute, returns it directly. Otherwise resolves
 * it relative to the provided cwd or process.cwd().
 *
 * @example
 * ```typescript
 * const dir = getCleoDirAbsolute('/my/project'); // "/my/project/.cleo"
 * ```
 */
export function getCleoDirAbsolute(cwd?: string): string {
  const cleoDir = getCleoDir();
  if (isAbsolutePath(cleoDir)) {
    return cleoDir;
  }
  return resolve(cwd ?? process.cwd(), cleoDir);
}

/**
 * Get the project root from the CLEO directory.
 * Respects CLEO_ROOT env var, then derives from CLEO_DIR.
 * If CLEO_DIR is ".cleo", the project root is its parent.
 *
 * @param cwd - Optional working directory hint
 * @returns Absolute path to the project root
 *
 * @remarks
 * Resolution order: CLEO_ROOT env var (if no cwd), parent of the resolved
 * .cleo directory (if it ends with /.cleo), or the cwd/process.cwd() fallback.
 *
 * @example
 * ```typescript
 * const root = getProjectRoot(); // "/home/user/projects/myapp"
 * ```
 */
export function getProjectRoot(cwd?: string): string {
  if (!cwd && process.env['CLEO_ROOT']) {
    return process.env['CLEO_ROOT'];
  }
  const cleoDirAbs = getCleoDirAbsolute(cwd);
  if (cleoDirAbs.endsWith('/.cleo') || cleoDirAbs.endsWith('\\.cleo')) {
    return dirname(cleoDirAbs);
  }
  return cwd ?? process.cwd();
}

/**
 * Resolve a project-relative path to an absolute path.
 *
 * @param relativePath - Path to resolve (relative, absolute, or tilde-prefixed)
 * @param cwd - Optional working directory for project root resolution
 * @returns Absolute resolved path
 *
 * @remarks
 * Returns absolute paths unchanged. Expands leading tilde (`~/`) to the user's
 * home directory. Resolves other relative paths against the project root.
 *
 * @example
 * ```typescript
 * resolveProjectPath('src/index.ts');     // "/project/src/index.ts"
 * resolveProjectPath('~/notes.md');       // "/home/user/notes.md"
 * resolveProjectPath('/absolute/path');   // "/absolute/path"
 * ```
 */
export function resolveProjectPath(relativePath: string, cwd?: string): string {
  if (isAbsolutePath(relativePath)) {
    return relativePath;
  }
  // Expand leading tilde (handles both ~/ on Unix and ~\ on Windows)
  if (relativePath.startsWith('~/') || relativePath.startsWith('~\\') || relativePath === '~') {
    return resolve(homedir(), relativePath.slice(2));
  }
  return resolve(getProjectRoot(cwd), relativePath);
}

/**
 * Get the path to the project's tasks.db file (SQLite database).
 * @deprecated Use getAccessor() from './store/data-accessor.js' instead. This function
 *   returns the database file path for legacy compatibility, but all task data access
 *   should go through the DataAccessor interface to ensure proper SQLite interaction.
 *   Example:
 *     // OLD (deprecated):
 *     const taskPath = getTaskPath(cwd);
 *     const data = await readJsonFile<TaskFile>(taskPath);
 *     // NEW (correct):
 *     const accessor = await getAccessor(cwd);
 *     const data = await accessor.queryTasks({});
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the tasks.db file
 *
 * @remarks
 * Returns `{cleoDir}/tasks.db`. Prefer `getAccessor()` for actual data access.
 *
 * @example
 * ```typescript
 * const dbPath = getTaskPath('/project');
 * ```
 */
export function getTaskPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'tasks.db');
}

/**
 * Get the path to the project's config.json file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the project config.json
 *
 * @remarks
 * Returns `{cleoDir}/config.json`.
 *
 * @example
 * ```typescript
 * const configPath = getConfigPath('/project');
 * ```
 */
export function getConfigPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'config.json');
}

/**
 * Get the path to the project's sessions.json file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the sessions.json file
 *
 * @remarks
 * Returns `{cleoDir}/sessions.json`.
 *
 * @example
 * ```typescript
 * const sessionsPath = getSessionsPath('/project');
 * ```
 */
export function getSessionsPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'sessions.json');
}

/**
 * Get the path to the project's archive file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the tasks-archive.json file
 *
 * @remarks
 * Returns `{cleoDir}/tasks-archive.json` where archived tasks are stored.
 *
 * @example
 * ```typescript
 * const archivePath = getArchivePath('/project');
 * ```
 */
export function getArchivePath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'tasks-archive.json');
}

/**
 * Get the path to the project's log file.
 * Canonical structured runtime log path (pino).
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the cleo.log file
 *
 * @remarks
 * Returns `{cleoDir}/logs/cleo.log`. Used by pino for structured JSON logging.
 *
 * @example
 * ```typescript
 * const logPath = getLogPath('/project');
 * ```
 *
 * @task T4644
 */
export function getLogPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'logs', 'cleo.log');
}

/**
 * Get the backup directory for operational backups.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the operational backups directory
 *
 * @remarks
 * Returns `{cleoDir}/backups/operational`.
 *
 * @example
 * ```typescript
 * const backupDir = getBackupDir('/project');
 * ```
 */
export function getBackupDir(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'backups', 'operational');
}

/**
 * Get the global config file path.
 *
 * @returns Absolute path to the global config.json in CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/config.json` for global CLEO configuration.
 *
 * @example
 * ```typescript
 * const globalConfig = getGlobalConfigPath();
 * ```
 */
export function getGlobalConfigPath(): string {
  return join(getCleoHome(), 'config.json');
}

// ============================================================================
// CleoOS Hub Paths (Phase 1)
// ============================================================================

/**
 * Get the Global Justfile Hub directory.
 *
 * The hub stores cross-project recipe libraries agents can run in ANY project
 * (cleo-bootstrap, rcasd-init, schema-validate, lint-standard). Both humans
 * (via editor) and the meta Cleo Chef Agent write recipes here.
 *
 * @returns Absolute path to the global-recipes directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/global-recipes`. Created by `ensureGlobalHome()`.
 *
 * @example
 * ```typescript
 * const dir = getCleoGlobalRecipesDir();
 * // Linux: "/home/user/.local/share/cleo/global-recipes"
 * ```
 */
export function getCleoGlobalRecipesDir(): string {
  return join(getCleoHome(), 'global-recipes');
}

/**
 * Get the absolute path to the primary global justfile.
 *
 * @returns Absolute path to `{cleoHome}/global-recipes/justfile`
 *
 * @remarks
 * This is the single-file entry point for the Justfile Hub. Additional
 * domain-specific justfiles live alongside it in the same directory.
 *
 * @example
 * ```typescript
 * const path = getCleoGlobalJustfilePath();
 * ```
 */
export function getCleoGlobalJustfilePath(): string {
  return join(getCleoGlobalRecipesDir(), 'justfile');
}

/**
 * Get the Global Pi Extensions Hub directory.
 *
 * Houses the Pi extensions that drive the CleoOS UI and tools:
 * orchestrator.ts (Conductor Loop), project-manager.ts (TUI dashboard),
 * tilldone.ts (work visualization), cant-bridge.ts (CANT runtime),
 * stage-guide.ts (before_agent_start hook).
 *
 * @returns Absolute path to the pi-extensions directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/pi-extensions`. Pi is configured to load extensions
 * from this directory via settings.json or the PI extension path setting.
 *
 * @example
 * ```typescript
 * const dir = getCleoPiExtensionsDir();
 * // Linux: "/home/user/.local/share/cleo/pi-extensions"
 * ```
 */
export function getCleoPiExtensionsDir(): string {
  return join(getCleoHome(), 'pi-extensions');
}

/**
 * Get the Global CANT Workflows Hub directory.
 *
 * Stores compiled and parsed `.cant` workflows that agents can invoke
 * globally across projects. Project-local agents still live in `.cleo/agents/`.
 *
 * @returns Absolute path to the cant-workflows directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/cant-workflows`. Used by the CANT runtime bridge
 * to resolve globally-available workflow definitions.
 *
 * @example
 * ```typescript
 * const dir = getCleoCantWorkflowsDir();
 * ```
 */
export function getCleoCantWorkflowsDir(): string {
  return join(getCleoHome(), 'cant-workflows');
}

/**
 * Get the Global CLEO Agents directory.
 *
 * Holds globally-available CANT agent definitions (`.cant` files).
 * Project-local agents still live in `{projectRoot}/.cleo/agents/`.
 *
 * @returns Absolute path to the agents directory under CLEO home
 *
 * @remarks
 * Returns `{cleoHome}/agents`. Loaded when `cleo agent start <id>` resolves
 * agent IDs that aren't found in the project-local registry.
 *
 * @example
 * ```typescript
 * const dir = getCleoGlobalAgentsDir();
 * ```
 */
export function getCleoGlobalAgentsDir(): string {
  return join(getCleoHome(), 'agents');
}

// ============================================================================
// Agent Outputs
// ============================================================================

const DEFAULT_AGENT_OUTPUTS_DIR = '.cleo/agent-outputs';

/**
 * Get the agent outputs directory (relative path) from config or default.
 *
 * Config lookup priority:
 *   1. config.agentOutputs.directory
 *   2. config.research.outputDir (deprecated)
 *   3. config.directories.agentOutputs (deprecated)
 *   4. Default: '.cleo/agent-outputs'
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Relative or absolute path to the agent outputs directory
 *
 * @remarks
 * Checks config fields in priority order: `agentOutputs.directory`, `research.outputDir`,
 * `directories.agentOutputs`. Falls back to `.cleo/agent-outputs`.
 *
 * @example
 * ```typescript
 * const dir = getAgentOutputsDir('/project');
 * ```
 *
 * @task T4700
 */
export function getAgentOutputsDir(cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Priority 1: agentOutputs.directory (canonical)
      if (typeof config.agentOutputs === 'object' && config.agentOutputs?.directory) {
        return config.agentOutputs.directory;
      }
      // Also support agentOutputs as a plain string
      if (typeof config.agentOutputs === 'string' && config.agentOutputs) {
        return config.agentOutputs;
      }

      // Priority 2: research.outputDir (deprecated)
      if (config.research?.outputDir) {
        return config.research.outputDir;
      }

      // Priority 3: directories.agentOutputs (deprecated)
      if (config.directories?.agentOutputs) {
        return config.directories.agentOutputs;
      }
    } catch {
      // fallback to default
    }
  }

  return DEFAULT_AGENT_OUTPUTS_DIR;
}

/**
 * Get the absolute path to the agent outputs directory.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the agent outputs directory
 *
 * @remarks
 * Resolves the output of `getAgentOutputsDir()` against the project root
 * if it is not already absolute.
 *
 * @example
 * ```typescript
 * const absDir = getAgentOutputsAbsolute('/project');
 * ```
 *
 * @task T4700
 */
export function getAgentOutputsAbsolute(cwd?: string): string {
  const dir = getAgentOutputsDir(cwd);
  if (isAbsolutePath(dir)) {
    return dir;
  }
  return resolve(getProjectRoot(cwd), dir);
}

/**
 * Get the absolute path to the MANIFEST.jsonl file.
 *
 * Checks config.agentOutputs.manifestFile for custom filename,
 * defaults to 'MANIFEST.jsonl'.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the MANIFEST.jsonl file
 *
 * @remarks
 * Checks `config.agentOutputs.manifestFile` for a custom filename,
 * defaults to `MANIFEST.jsonl` in the agent outputs directory.
 *
 * @example
 * ```typescript
 * const manifestPath = getManifestPath('/project');
 * ```
 *
 * @task T4700
 */
export function getManifestPath(cwd?: string): string {
  const outputDir = getAgentOutputsDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  let manifestFile = 'MANIFEST.jsonl';
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const customFile = config.agentOutputs?.manifestFile ?? config.research?.manifestFile;
      if (customFile) {
        manifestFile = customFile;
      }
    } catch {
      // fallback
    }
  }

  return resolve(projectRoot, outputDir, manifestFile);
}

/**
 * Get the absolute path to the MANIFEST.archive.jsonl file.
 *
 * @param cwd - Optional working directory for path resolution
 * @returns Absolute path to the MANIFEST.archive.jsonl file
 *
 * @remarks
 * Returns the archive manifest path in the agent outputs directory.
 *
 * @example
 * ```typescript
 * const archivePath = getManifestArchivePath('/project');
 * ```
 *
 * @task T4700
 */
export function getManifestArchivePath(cwd?: string): string {
  const outputDir = getAgentOutputsDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  return resolve(projectRoot, outputDir, 'MANIFEST.archive.jsonl');
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Check if a path is absolute (POSIX or Windows).
 *
 * @param path - Filesystem path to check
 * @returns True if the path is absolute on any supported OS
 *
 * @remarks
 * Recognizes POSIX absolute paths (`/...`), Windows drive letters (`C:\...`),
 * and UNC paths (`\\...`).
 *
 * @example
 * ```typescript
 * isAbsolutePath('/usr/bin');    // true
 * isAbsolutePath('C:\\Users');   // true
 * isAbsolutePath('./relative'); // false
 * ```
 */
export function isAbsolutePath(path: string): boolean {
  // POSIX absolute
  if (path.startsWith('/')) return true;
  // Windows drive letter (C:\, D:/)
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  // UNC path
  if (path.startsWith('\\\\')) return true;
  return false;
}

// ============================================================================
// OS-Aware Global Paths (via env-paths)
// ============================================================================

/**
 * Get the OS log directory for CLEO global logs.
 * Linux: ~/.local/state/cleo | macOS: ~/Library/Logs/cleo | Windows: %LOCALAPPDATA%\cleo\Log
 *
 * @returns Absolute path to the OS-appropriate log directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().log` for XDG-compliant resolution.
 *
 * @example
 * ```typescript
 * const logDir = getCleoLogDir();
 * ```
 */
export function getCleoLogDir(): string {
  return getPlatformPaths().log;
}

/**
 * Get the OS cache directory for CLEO.
 * Linux: ~/.cache/cleo | macOS: ~/Library/Caches/cleo | Windows: %LOCALAPPDATA%\cleo\Cache
 *
 * @returns Absolute path to the OS-appropriate cache directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().cache` for XDG-compliant resolution.
 *
 * @example
 * ```typescript
 * const cacheDir = getCleoCacheDir();
 * ```
 */
export function getCleoCacheDir(): string {
  return getPlatformPaths().cache;
}

/**
 * Get the OS temp directory for CLEO ephemeral files.
 *
 * @returns Absolute path to the OS-appropriate temp directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().temp` for platform-specific resolution.
 *
 * @example
 * ```typescript
 * const tempDir = getCleoTempDir();
 * ```
 */
export function getCleoTempDir(): string {
  return getPlatformPaths().temp;
}

/**
 * Get the OS config directory for CLEO.
 * Linux: ~/.config/cleo | macOS: ~/Library/Preferences/cleo | Windows: %APPDATA%\cleo\Config
 *
 * @returns Absolute path to the OS-appropriate config directory
 *
 * @remarks
 * Delegates to `getPlatformPaths().config` for XDG-compliant resolution.
 *
 * @example
 * ```typescript
 * const configDir = getCleoConfigDir();
 * ```
 */
export function getCleoConfigDir(): string {
  return getPlatformPaths().config;
}

/**
 * Get the CLEO templates directory as a tilde-prefixed path for use
 * in `@` references (AGENTS.md, CLAUDE.md, etc.). Cross-platform:
 * replaces the user's home directory with `~` so the reference works
 * when loaded by LLM providers that resolve `~` at runtime.
 *
 * Linux:   ~/.local/share/cleo/templates
 * macOS:   ~/Library/Application Support/cleo/templates
 * Windows: ~/AppData/Local/cleo/Data/templates (approximate)
 *
 * @returns Tilde-prefixed path like "~/.local/share/cleo/templates"
 *
 * @remarks
 * Returns the absolute path if the home directory is not a prefix
 * (unlikely but handled). Always uses forward slashes after the tilde
 * for cross-platform compatibility in `@`-reference resolution.
 *
 * @example
 * ```typescript
 * const tildePath = getCleoTemplatesTildePath();
 * // "~/.local/share/cleo/templates"
 * ```
 */
export function getCleoTemplatesTildePath(): string {
  const absPath = getCleoTemplatesDir();
  const home = homedir();
  if (absPath.startsWith(home)) {
    // Always use forward slash after tilde for cross-platform @-reference resolution
    const relative = absPath.slice(home.length).replace(/\\/g, '/');
    return `~${relative}`;
  }
  return absPath;
}

// ============================================================================
// Third-Party Tool Paths (OS-aware)
// ============================================================================

/**
 * Get the global agents hub directory.
 * Respects AGENTS_HOME env var, defaults to ~/.agents.
 *
 * @returns Absolute path to the agents hub directory
 *
 * @remarks
 * Returns `AGENTS_HOME` env var if set, otherwise `~/.agents`.
 *
 * @example
 * ```typescript
 * const agentsHome = getAgentsHome(); // "/home/user/.agents"
 * ```
 */
export function getAgentsHome(): string {
  return process.env['AGENTS_HOME'] ?? join(homedir(), '.agents');
}

/**
 * Get the Claude Code agents directory (~/.claude/agents by default).
 *
 * @returns Absolute path to the Claude agents directory
 *
 * @remarks
 * Respects `CLAUDE_HOME` env var for the parent directory.
 *
 * @example
 * ```typescript
 * const dir = getClaudeAgentsDir();
 * ```
 *
 * @deprecated Use AdapterPathProvider.getAgentInstallDir() from the active adapter instead.
 */
export function getClaudeAgentsDir(): string {
  const claudeDir = process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
  return join(claudeDir, 'agents');
}

/**
 * Get the claude-mem SQLite database path.
 *
 * @returns Absolute path to the claude-mem.db file
 *
 * @remarks
 * Respects `CLAUDE_MEM_DB` env var, defaults to `~/.claude-mem/claude-mem.db`.
 * This is a third-party tool path; homedir() is correct here (no env-paths standard).
 *
 * @example
 * ```typescript
 * const dbPath = getClaudeMemDbPath();
 * ```
 *
 * @deprecated Use AdapterPathProvider.getMemoryDbPath() from the active adapter instead.
 */
export function getClaudeMemDbPath(): string {
  return process.env['CLAUDE_MEM_DB'] ?? join(homedir(), '.claude-mem', 'claude-mem.db');
}
