/**
 * Claude Code Install Provider
 *
 * Handles CLEO installation into Claude Code environments:
 * - Ensures CLAUDE.md has CLEO @-references
 * - Manages plugin registration in ~/.claude/settings.json
 *
 * Migrated from src/core/install/claude-plugin.ts
 *
 * @task T5240
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProviderInstructionFile, updateJsonConfigFile } from '@cleocode/caamp';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
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
} from './paths.js';

/** Resolve Claude Code's config directory, honoring the documented CI override. */
function getClaudeConfigDir(): string {
  return process.env['CLAUDE_HOME'] ?? join(homedir(), '.claude');
}

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
 * 2. Installing adapter-provided commands to .claude/commands/
 * 3. Registering the brain observation plugin in ~/.claude/settings.json
 *
 * @remarks
 * Installation is idempotent -- running install multiple times on the same
 * project produces the same result. The provider disables the legacy
 * `claude-mem\@thedotmack` plugin if present and enables the unified
 * `cleo\@cleocode` plugin instead.
 */
export class ClaudeCodeInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Claude Code project.
   *
   * @param options - Installation options including project directory
   * @returns Result describing what was installed
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir } = options;
    const installedAt = new Date().toISOString();
    let instructionFileUpdated = false;
    const details: Record<string, unknown> = {};

    // Step 1: Ensure CLAUDE.md has @-references via CAAMP canonical API (T1919)
    const instructionResult = await ensureProviderInstructionFile('claude-code', projectDir, {});
    instructionFileUpdated = instructionResult.action !== 'intact';
    if (instructionFileUpdated) {
      details.instructionFile = instructionResult.filePath;
    }

    // Step 2: Install adapter-provided commands to .claude/commands/
    const commandsInstalled = this.installCommands(projectDir);
    if (commandsInstalled.length > 0) {
      details.commands = commandsInstalled;
    }

    // T12385: settings.json writes are locked + atomic, and a malformed file
    // aborts the write and is reported here — it is never reset to `{}`.
    const settingsErrors: string[] = [];

    // Step 3: Register plugin in ~/.claude/settings.json
    try {
      const pluginResult = await this.registerPlugin();
      if (pluginResult) {
        details.plugin = pluginResult;
      }
    } catch (err) {
      settingsErrors.push(err instanceof Error ? err.message : String(err));
    }

    // Step 4 (T1013): Install PreCompact hook templates + wire the handler
    // command into ~/.claude/settings.json's `PreCompact` event.
    try {
      const hookResult = await this.installHookTemplates();
      if (hookResult) {
        details.hookTemplates = hookResult;
      }
    } catch (err) {
      settingsErrors.push(err instanceof Error ? err.message : String(err));
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
   * Checks for plugin enabled in ~/.claude/settings.json.
   */
  async isInstalled(): Promise<boolean> {
    // Check ~/.claude/settings.json for plugin registration
    const settingsPath = claudeSettingsPath();
    if (existsSync(settingsPath)) {
      try {
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        const plugins = settings.enabledPlugins as Record<string, boolean> | undefined;
        if (plugins && plugins['cleo@cleocode'] === true) {
          return true;
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
   */
  private installCommands(projectDir: string): string[] {
    const adapterCommandsDir = getAdapterCommandsDir();
    if (!existsSync(adapterCommandsDir)) {
      return [];
    }

    const targetDir = join(projectDir, '.claude', 'commands');
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
   * Register the CLEO brain plugin in ~/.claude/settings.json.
   *
   * @returns Description of what was registered, or null if no change needed
   */
  private async registerPlugin(): Promise<string | null> {
    const pluginKey = 'cleo@cleocode';
    const wrote = await updateJsonConfigFile(claudeSettingsPath(), (settings) => {
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

    return wrote ? `Enabled ${pluginKey} in ~/.claude/settings.json` : null;
  }

  /**
   * Install the CLEO PreCompact hook templates for Claude Code (T1013).
   *
   * Writes two files to `~/.claude/hooks/`:
   * 1. `cleo-precompact-core.sh` — universal CLEO safestop helper (shared
   *    across all providers; sourced by the provider-specific shim).
   * 2. `precompact-safestop.sh` — Claude-Code-flavoured wrapper that invokes
   *    `cleo memory precompact-flush` and `cleo safestop`.
   *
   * Also registers a `PreCompact` entry in `~/.claude/settings.json` so Claude
   * Code runs the hook when auto-compact fires (at 95% context).
   *
   * Idempotent: subsequent installs skip unchanged files and do not duplicate
   * the settings.json hook entry.
   *
   * @returns Install summary (paths written + config change description), or
   *   `null` when no change was required.
   *
   * @task T1013
   */
  private async installHookTemplates(): Promise<{
    templates: InstallHookTemplatesResult;
    settingsEntryAdded: boolean;
  } | null> {
    const claudeDir = getClaudeConfigDir();
    const hooksDir = join(claudeDir, 'hooks');

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

    // 2. Wire the PreCompact event in ~/.claude/settings.json.
    const settingsEntryAdded = await this.registerPreCompactHook(
      join(hooksDir, 'precompact-safestop.sh'),
    );

    if (templates.installedFiles.length === 0 && !settingsEntryAdded) {
      return null;
    }

    return { templates, settingsEntryAdded };
  }

  /**
   * Register the PreCompact hook command in `~/.claude/settings.json`.
   *
   * The Claude Code native event name for the canonical `PreCompact` event is
   * `PreCompact` (identity mapping — see `hook-mappings.json`). The entry is
   * tagged with `# cleo-hook` so the uninstall flow can identify and remove
   * our additions without touching user-authored hooks.
   *
   * @param shimPath - Absolute path to the installed `precompact-safestop.sh`.
   * @returns `true` when a new hook entry was written, `false` when an
   *   equivalent entry was already present.
   *
   * @task T1013
   */
  private async registerPreCompactHook(shimPath: string): Promise<boolean> {
    return updateJsonConfigFile(claudeSettingsPath(), (settings) => {
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
