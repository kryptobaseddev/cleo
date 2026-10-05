/**
 * Claude Code Install Provider
 *
 * Handles CLEO installation into Claude Code environments:
 * - Ensures CLAUDE.md has CLEO @-references
 * - Manages plugin registration in the PROJECT's `.claude/settings.local.json`
 * - Installs the PreCompact hook templates in the PROJECT's `.claude/hooks/`
 * - Installs the heavy-command `PreToolUse` hook in the PROJECT's
 *   `.claude/settings.local.json` (T12983)
 *
 * Project-level only (T13227): CLEO never writes the user-global
 * `~/.claude/settings.json` or `~/.claude/hooks/` (`CLAUDE_HOME`,
 * `CLAUDE_SETTINGS`). A project that is the home directory, or whose
 * `.claude/` resolves into the user-global Claude config, gets those steps
 * reported as `skipped` and nothing is written there.
 *
 * Migrated from src/core/install/claude-plugin.ts
 *
 * @task T5240
 * @task T12983
 * @task T13227
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProviderInstructionFile, updateJsonConfigFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
import {
  excludeHookFileFromGit,
  excludeLocalSettingsFromGit,
  isUserHomeDir,
  syncClaudeCodeHeavyCommandHook,
} from '../shared/heavy-command-hook-install.js';
import {
  type InstallHookTemplatesResult,
  installProviderHookTemplates,
} from '../shared/hook-template-installer.js';
import {
  appendHookEntry,
  claudeSettingsPath,
  hasCleoHook,
  hookMap,
  isPlainObject,
  projectClaudeCommandsDir,
  projectClaudeHooksDir,
  projectClaudeSettingsPath,
  UserGlobalClaudeConfigError,
} from './paths.js';

/** The plugin the install enables in the project's Claude settings. */
const CLEO_PLUGIN_KEY = 'cleo@cleocode';

/** The PreCompact hook scripts the install copies, relative to the project. */
const PROJECT_HOOK_FILES = [
  '.claude/hooks/precompact-safestop.sh',
  '.claude/hooks/cleo-precompact-core.sh',
] as const;

/** Resolve the commands directory bundled with this adapter. */
function getAdapterCommandsDir(): string {
  // Works in both ESM (import.meta.url) and compiled output
  const thisDir = dirname(fileURLToPath(import.meta.url));
  return join(thisDir, 'commands');
}

/**
 * Install provider for Claude Code.
 *
 * Manages CLEO's integration with Claude Code by:
 * 1. Ensuring CLAUDE.md contains @-references to CLEO instruction files
 * 2. Installing adapter-provided commands to the project's .claude/commands/
 * 3. Registering the brain observation plugin in the project's
 *    `.claude/settings.local.json`
 * 4. Installing PreCompact hook templates in the project's `.claude/hooks/`
 *    and wiring them into the project's `.claude/settings.local.json`
 * 5. Installing the heavy-command `PreToolUse` hook in the project's
 *    `.claude/settings.local.json`, when `options.heavyCommandHook` is set
 *
 * @remarks
 * Installation is idempotent -- running install multiple times on the same
 * project produces the same result. The provider disables the legacy
 * `claude-mem\@thedotmack` plugin for the project if present and enables the
 * unified `cleo\@cleocode` plugin instead. Nothing is written to the
 * user-global Claude config (T13227).
 */
export class ClaudeCodeInstallProvider implements AdapterInstallProvider {
  /** The project the last {@link install} ran for; {@link isInstalled} reads its settings. */
  private projectDir: string | null = null;

  /**
   * Install CLEO into a Claude Code project.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    this.projectDir = projectDir;
    const installedAt = new Date().toISOString();
    let instructionFileUpdated = false;
    const details: Record<string, unknown> = {};

    // Step 1: Ensure CLAUDE.md has @-references via CAAMP canonical API (T1919)
    const instructionResult = await ensureProviderInstructionFile('claude-code', projectDir, {});
    instructionFileUpdated = instructionResult.action !== 'intact';
    if (instructionFileUpdated) {
      details.instructionFile = instructionResult.filePath;
    }

    // Step 2: Install adapter-provided commands to .claude/commands/ — never
    // into the user-global Claude dir (T13227).
    try {
      const commandsInstalled = this.installCommands(projectDir);
      if (commandsInstalled.length > 0) {
        details.commands = commandsInstalled;
      }
    } catch (err) {
      if (!(err instanceof UserGlobalClaudeConfigError)) throw err;
      details.commands = 'skipped';
    }

    // T12385: settings.json writes are locked + atomic, and a malformed file
    // aborts the write and is reported here — it is never reset to `{}`.
    const settingsErrors: string[] = [];

    // Step 3: Register plugin in the project's .claude/settings.local.json.
    // A user-global target (T13227) is skipped, never written.
    try {
      const pluginResult = await this.registerPlugin(projectDir);
      if (pluginResult) {
        details.plugin = pluginResult;
      }
    } catch (err) {
      if (err instanceof UserGlobalClaudeConfigError) details.plugin = 'skipped';
      else settingsErrors.push(err instanceof Error ? err.message : String(err));
    }

    // Step 4 (T1013): Install PreCompact hook templates into the project's
    // .claude/hooks/ + wire the handler command into the project's
    // .claude/settings.local.json `PreCompact` event (T13227).
    try {
      const hookResult = await this.installHookTemplates(projectDir);
      if (hookResult) {
        details.hookTemplates = hookResult;
      }
    } catch (err) {
      if (err instanceof UserGlobalClaudeConfigError) details.hookTemplates = 'skipped';
      else settingsErrors.push(err instanceof Error ? err.message : String(err));
    }

    // Step 5 (T12983): route heavy shell commands through `cleo run`.
    // Project-level settings only; the user's ~/.claude is never touched.
    if (options.heavyCommandHook !== undefined) {
      const projectSettings = join(projectDir, '.claude', 'settings.json');
      if (isUserHomeDir(projectDir) || resolve(projectSettings) === resolve(claudeSettingsPath())) {
        details.heavyCommandHook = 'skipped';
      } else {
        try {
          details.heavyCommandHook = await syncClaudeCodeHeavyCommandHook(
            projectDir,
            options.heavyCommandHook,
          );
        } catch (err) {
          settingsErrors.push(err instanceof Error ? err.message : String(err));
        }
      }
    }

    if (settingsErrors.length > 0) {
      details.settingsErrors = settingsErrors;
    }

    return {
      success: settingsErrors.length === 0,
      installedAt,
      instructionFileUpdated,
      details,
    };
  }

  /**
   * Uninstall CLEO from the current Claude Code project.
   *
   * Does not remove CLAUDE.md references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {}

  /**
   * Check whether CLEO is installed in the current environment.
   *
   * Checks for the plugin enabled in the project's
   * `.claude/settings.local.json` — the project of the last {@link install},
   * else the working directory (T13227).
   */
  async isInstalled(): Promise<boolean> {
    let settingsPath: string;
    try {
      settingsPath = projectClaudeSettingsPath(this.projectDir ?? process.cwd());
    } catch {
      return false;
    }
    if (existsSync(settingsPath)) {
      try {
        const settings: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        if (isPlainObject(settings)) {
          const plugins = settings.enabledPlugins;
          if (isPlainObject(plugins) && plugins[CLEO_PLUGIN_KEY] === true) {
            return true;
          }
        }
      } catch {
        // Fall through
      }
    }

    return false;
  }

  /**
   * Ensure CLAUDE.md contains @-references to CLEO instruction files.
   *
   * Delegates to CAAMP's canonical API which reads the instruction file name
   * and default references from the provider registry (T1919).
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    await ensureProviderInstructionFile('claude-code', projectDir, {});
  }

  /**
   * Install Claude Code-specific commands to .claude/commands/ in the project.
   *
   * These commands extend CLEO's provider-neutral skills with Claude Code-specific
   * operational patterns (Agent tool spawn templates, model assignment, context guardrails).
   *
   * @param projectDir - Project root directory
   * @returns Array of installed command filenames
   * @throws {@link UserGlobalClaudeConfigError} when the target is user-global
   */
  private installCommands(projectDir: string): string[] {
    const adapterCommandsDir = getAdapterCommandsDir();
    if (!existsSync(adapterCommandsDir)) {
      return [];
    }

    const targetDir = projectClaudeCommandsDir(projectDir);
    mkdirSync(targetDir, { recursive: true });

    const installed: string[] = [];
    const files = readdirSync(adapterCommandsDir).filter((f) => f.endsWith('.md'));

    for (const file of files) {
      const src = join(adapterCommandsDir, file);
      const dest = join(targetDir, file);
      copyFileSync(src, dest);
      installed.push(file);
    }

    return installed;
  }

  /**
   * Register the CLEO brain plugin in the project's
   * `.claude/settings.local.json` (T13227: never the user-global settings).
   *
   * @param projectDir - Project root directory
   * @returns Description of what was registered, or null if no change needed
   * @throws {@link UserGlobalClaudeConfigError} when the target is user-global
   */
  private async registerPlugin(projectDir: string): Promise<string | null> {
    const pluginKey = CLEO_PLUGIN_KEY;
    const settingsPath = projectClaudeSettingsPath(projectDir);
    const wrote = await updateJsonConfigFile(settingsPath, (settings) => {
      const enabledPlugins = settings.enabledPlugins ?? {};
      if (!isPlainObject(enabledPlugins)) {
        throw new Error('settings.json "enabledPlugins" is not an object; not modifying it');
      }
      if (enabledPlugins[pluginKey] === true) {
        return false;
      }

      // Disable old claude-mem if present
      if (enabledPlugins['claude-mem@thedotmack'] === true) {
        enabledPlugins['claude-mem@thedotmack'] = false;
      }

      enabledPlugins[pluginKey] = true;
      settings.enabledPlugins = enabledPlugins;
      return true;
    });

    if (!wrote) return null;
    excludeLocalSettingsFromGit(projectDir);
    return `Enabled ${pluginKey} in ${settingsPath}`;
  }

  /**
   * Install the CLEO PreCompact hook templates for Claude Code (T1013).
   *
   * Writes two files to the project's `.claude/hooks/`:
   * 1. `cleo-precompact-core.sh` — universal CLEO safestop helper (shared
   *    across all providers; sourced by the provider-specific shim).
   * 2. `precompact-safestop.sh` — Claude-Code-flavoured wrapper that invokes
   *    `cleo memory precompact-flush` and `cleo safestop`.
   *
   * Also registers a `PreCompact` entry in the project's
   * `.claude/settings.local.json` so Claude Code runs the hook when
   * auto-compact fires (at 95% context). Files git does not ignore yet are
   * kept out of it with a marked `info/exclude` block. Nothing is written to
   * the user-global Claude config (T13227).
   *
   * Idempotent: subsequent installs skip unchanged files and do not duplicate
   * the settings hook entry.
   *
   * @param projectDir - Project root directory
   * @returns Install summary (paths written + config change description), or
   *   `null` when no change was required.
   * @throws {@link UserGlobalClaudeConfigError} when the target is user-global
   *
   * @task T1013 @task T13227
   */
  private async installHookTemplates(projectDir: string): Promise<{
    templates: InstallHookTemplatesResult;
    settingsEntryAdded: boolean;
  } | null> {
    const hooksDir = projectClaudeHooksDir(projectDir);
    const settingsPath = projectClaudeSettingsPath(projectDir);

    // 1. Copy the bash templates next to each other so `source $SCRIPT_DIR/...` works.
    //    Template copy is best-effort so missing/locked filesystems (CI sandboxes,
    //    mocked `node:fs` in unit tests) don't fail the whole install.
    let templates: InstallHookTemplatesResult;
    try {
      templates = installProviderHookTemplates({
        provider: 'claude-code',
        targetDir: hooksDir,
      });
    } catch {
      return null;
    }

    for (const file of PROJECT_HOOK_FILES) excludeHookFileFromGit(projectDir, file);

    // 2. Wire the PreCompact event in the project's settings.local.json.
    const settingsEntryAdded = await this.registerPreCompactHook(
      settingsPath,
      join(hooksDir, 'precompact-safestop.sh'),
    );
    if (settingsEntryAdded) excludeLocalSettingsFromGit(projectDir);

    if (templates.installedFiles.length === 0 && !settingsEntryAdded) {
      return null;
    }

    return { templates, settingsEntryAdded };
  }

  /**
   * Register the PreCompact hook command in the project's
   * `.claude/settings.local.json`.
   *
   * The Claude Code native event name for the canonical `PreCompact` event is
   * `PreCompact` (identity mapping — see `hook-mappings.json`). The entry is
   * tagged with `# cleo-hook` so the uninstall flow can identify and remove
   * our additions without touching user-authored hooks.
   *
   * @param settingsPath - The project settings file (already scope-checked).
   * @param shimPath - Absolute path to the installed `precompact-safestop.sh`.
   * @returns `true` when a new hook entry was written, `false` when an
   *   equivalent entry was already present.
   *
   * @task T1013
   */
  private async registerPreCompactHook(settingsPath: string, shimPath: string): Promise<boolean> {
    return updateJsonConfigFile(settingsPath, (settings) => {
      const hooks = hookMap(settings);
      if (hasCleoHook(hooks.PreCompact, 'precompact-safestop.sh')) {
        return false;
      }
      appendHookEntry(hooks, 'PreCompact', {
        matcher: '',
        hooks: [
          {
            type: 'command',
            command: `"${shimPath}" # cleo-hook`,
            timeout: 30,
          },
        ],
      });
      return true;
    });
  }
}
