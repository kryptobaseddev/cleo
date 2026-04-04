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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in CLAUDE.md to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/**
 * Install provider for Claude Code.
 *
 * Manages CLEO's integration with Claude Code by:
 * 1. Ensuring CLAUDE.md contains @-references to CLEO instruction files
 * 2. Registering the brain observation plugin in ~/.claude/settings.json
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

    // Step 1: Ensure CLAUDE.md has @-references
    instructionFileUpdated = this.updateInstructionFile(projectDir);
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, 'CLAUDE.md');
    }

    // Step 2: Register plugin in ~/.claude/settings.json
    const pluginResult = this.registerPlugin();
    if (pluginResult) {
      details.plugin = pluginResult;
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      mcpRegistered: false,
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
    const settingsPath = join(homedir(), '.claude', 'settings.json');
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
   * Creates CLAUDE.md if it does not exist. Appends any missing references.
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    this.updateInstructionFile(projectDir);
  }

  /**
   * Update CLAUDE.md with CLEO @-references.
   *
   * @returns true if the file was created or modified
   */
  private updateInstructionFile(projectDir: string): boolean {
    const claudeMdPath = join(projectDir, 'CLAUDE.md');
    let content = '';
    let existed = false;

    if (existsSync(claudeMdPath)) {
      content = readFileSync(claudeMdPath, 'utf-8');
      existed = true;
    }

    const missingRefs = INSTRUCTION_REFERENCES.filter((ref) => !content.includes(ref));

    if (missingRefs.length === 0) {
      return false;
    }

    const refsBlock = missingRefs.join('\n');

    if (existed) {
      // Append missing references
      const separator = content.endsWith('\n') ? '' : '\n';
      content = content + separator + refsBlock + '\n';
    } else {
      // Create new CLAUDE.md with references
      content = refsBlock + '\n';
    }

    writeFileSync(claudeMdPath, content, 'utf-8');
    return true;
  }

  /**
   * Register the CLEO brain plugin in ~/.claude/settings.json.
   *
   * @returns Description of what was registered, or null if no change needed
   */
  private registerPlugin(): string | null {
    const home = homedir();
    const settingsPath = join(home, '.claude', 'settings.json');

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      } catch {
        // Start fresh
      }
    }

    const enabledPlugins = (settings.enabledPlugins as Record<string, boolean>) ?? {};
    const pluginKey = 'cleo@cleocode';

    if (enabledPlugins[pluginKey] === true) {
      return null;
    }

    // Disable old claude-mem if present
    if (enabledPlugins['claude-mem@thedotmack'] === true) {
      enabledPlugins['claude-mem@thedotmack'] = false;
    }

    enabledPlugins[pluginKey] = true;
    settings.enabledPlugins = enabledPlugins;

    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');

    return `Enabled ${pluginKey} in ~/.claude/settings.json`;
  }
}
