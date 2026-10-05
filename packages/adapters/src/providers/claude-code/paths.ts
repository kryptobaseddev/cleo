/**
 * Claude Code path provider.
 *
 * Implements AdapterPathProvider with Claude Code-specific directory locations.
 *
 * @task T5240
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AdapterPathProvider } from '@cleocode/contracts';
import { CLAUDE_LOCAL_SETTINGS, isUserHomeDir } from '../shared/heavy-command-hook-install.js';

/**
 * Path provider for Anthropic Claude Code CLI.
 *
 * Resolves Claude Code's standard directory layout:
 * - Config dir: ~/.claude (or CLAUDE_HOME)
 * - Settings: ~/.claude/settings.json (or CLAUDE_SETTINGS)
 * - Agents: ~/.claude/agents
 * - Memory DB: ~/.claude-mem/claude-mem.db (or CLAUDE_MEM_DB)
 *
 * @remarks
 * All paths respect environment variable overrides for CI and non-standard
 * installations. When env vars are unset, the canonical default paths are used.
 */
export class ClaudeCodePathProvider implements AdapterPathProvider {
  /** Get the provider's root configuration directory. */
  getProviderDir(): string {
    return process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
  }

  /** Get the path to the provider's settings file, or null if unavailable. */
  getSettingsPath(): string | null {
    return process.env['CLAUDE_SETTINGS'] ?? join(this.getProviderDir(), 'settings.json');
  }

  /** Get the directory where agents are installed, or null if unsupported. */
  getAgentInstallDir(): string | null {
    return join(this.getProviderDir(), 'agents');
  }

  /** Get the path to the provider's memory database, or null if unsupported. */
  getMemoryDbPath(): string | null {
    return process.env['CLAUDE_MEM_DB'] ?? join(homedir(), '.claude-mem', 'claude-mem.db');
  }
}

/**
 * Resolve Claude Code's `settings.json`, honouring `CLAUDE_SETTINGS` and
 * `CLAUDE_HOME`.
 *
 * @remarks
 * The single resolver for every adapter write to the settings file (T12385).
 * Hook registration previously hard-coded `~/.claude/settings.json` while the
 * installer honoured `CLAUDE_HOME`, so the two wrote different files whenever
 * the override was set.
 *
 * @returns Absolute path of the settings file
 *
 * @example
 * ```typescript
 * const settingsPath = claudeSettingsPath();
 * ```
 */
export function claudeSettingsPath(): string {
  return (
    new ClaudeCodePathProvider().getSettingsPath() ?? join(homedir(), '.claude', 'settings.json')
  );
}

/**
 * `path` with every existing leading part resolved through symlinks, so two
 * spellings of one location compare equal even before the leaf exists.
 */
function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

/** Whether `path` is `dir` or lies inside it (both canonical). */
function isAtOrInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The adapter was asked to write somewhere that is, or lies inside, the
 * user-global Claude Code config (T13227). CLEO never writes there — adding
 * and removing entries alike — so nothing is written and the caller reports
 * the step as skipped.
 */
export class UserGlobalClaudeConfigError extends Error {
  /** The path that was refused. */
  readonly path: string;

  /**
   * @param path - the refused target.
   * @param why - which user-global location it hits.
   */
  constructor(path: string, why: string) {
    super(`refusing to write ${path}: ${why}; CLEO only writes project-level Claude Code config`);
    this.name = 'UserGlobalClaudeConfigError';
    this.path = path;
  }
}

/**
 * Refuse `target` when it is user-global Claude Code config: the settings
 * file {@link claudeSettingsPath} resolves (`CLAUDE_SETTINGS`), anything in
 * the Claude config dir (`CLAUDE_HOME`, else `~/.claude`), or anything when
 * the project is the home directory (its `.claude/` IS the user-global dir).
 *
 * @param projectDir - the project root the write is for.
 * @param target - the file or directory about to be written.
 * @returns `target`, absolute, when it is project-level.
 * @throws {@link UserGlobalClaudeConfigError} otherwise; nothing is written.
 */
function assertProjectScoped(projectDir: string, target: string): string {
  const abs = resolve(target);
  if (isUserHomeDir(projectDir)) {
    throw new UserGlobalClaudeConfigError(abs, 'the project is the home directory');
  }
  const canonical = canonicalPath(abs);
  if (canonical === canonicalPath(claudeSettingsPath())) {
    throw new UserGlobalClaudeConfigError(abs, 'it is the user-global Claude settings file');
  }
  if (isAtOrInside(canonical, canonicalPath(new ClaudeCodePathProvider().getProviderDir()))) {
    throw new UserGlobalClaudeConfigError(abs, 'it is inside the user-global Claude config dir');
  }
  return abs;
}

/**
 * The project's per-machine Claude Code settings file,
 * `<project>/.claude/settings.local.json` — the only settings file the
 * adapter's hook and plugin writers touch (T13227, the T12983/T13124 rule:
 * project-level only, never the user-global `~/.claude/settings.json`).
 *
 * @param projectDir - the project root.
 * @returns the absolute settings path.
 * @throws {@link UserGlobalClaudeConfigError} when it would be user-global.
 *
 * @example
 * ```typescript
 * const target = projectClaudeSettingsPath('/repo'); // /repo/.claude/settings.local.json
 * ```
 */
export function projectClaudeSettingsPath(projectDir: string): string {
  return assertProjectScoped(projectDir, join(projectDir, CLAUDE_LOCAL_SETTINGS));
}

/**
 * The project's Claude Code hook-script dir, `<project>/.claude/hooks`, where
 * the PreCompact templates are copied (T13227).
 *
 * @param projectDir - the project root.
 * @returns the absolute hooks dir.
 * @throws {@link UserGlobalClaudeConfigError} when it would be user-global.
 *
 * @example
 * ```typescript
 * const dir = projectClaudeHooksDir('/repo'); // /repo/.claude/hooks
 * ```
 */
export function projectClaudeHooksDir(projectDir: string): string {
  return assertProjectScoped(projectDir, join(projectDir, '.claude', 'hooks'));
}

/**
 * The project's Claude Code commands dir, `<project>/.claude/commands`, where
 * the adapter's slash commands are copied (T13227).
 *
 * @param projectDir - the project root.
 * @returns the absolute commands dir.
 * @throws {@link UserGlobalClaudeConfigError} when it would be user-global.
 *
 * @example
 * ```typescript
 * const dir = projectClaudeCommandsDir('/repo'); // /repo/.claude/commands
 * ```
 */
export function projectClaudeCommandsDir(projectDir: string): string {
  return assertProjectScoped(projectDir, join(projectDir, '.claude', 'commands'));
}

export {
  appendHookEntry,
  CLEO_HOOK_MARKER,
  hasCleoHook,
  hookMap,
  isCleoHookEntry,
  isPlainObject,
  removeCleoHookEntries,
} from '../shared/hook-config.js';
