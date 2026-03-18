/**
 * Claude Code Install Provider
 *
 * Handles CLEO installation into Claude Code environments:
 * - Registers CLEO MCP server in .mcp.json
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
const INSTRUCTION_REFERENCES = [
  '@~/.cleo/templates/CLEO-INJECTION.md',
  '@.cleo/memory-bridge.md',
];

/** MCP server registration key used in .mcp.json. */
const MCP_SERVER_KEY = 'cleo';

/**
 * Install provider for Claude Code.
 *
 * Manages CLEO's integration with Claude Code by:
 * 1. Registering the CLEO MCP server in the project's .mcp.json
 * 2. Ensuring CLAUDE.md contains @-references to CLEO instruction files
 * 3. Registering the brain observation plugin in ~/.claude/settings.json
 */
export class ClaudeCodeInstallProvider implements AdapterInstallProvider {
  private installedProjectDir: string | null = null;

  /**
   * Install CLEO into a Claude Code project.
   *
   * @param options - Installation options including project directory and MCP server path
   * @returns Result describing what was installed
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir, mcpServerPath } = options;
    const installedAt = new Date().toISOString();
    let instructionFileUpdated = false;
    let mcpRegistered = false;
    const details: Record<string, unknown> = {};

    // Step 1: Register MCP server in .mcp.json
    if (mcpServerPath) {
      mcpRegistered = this.registerMcpServer(projectDir, mcpServerPath);
      if (mcpRegistered) {
        details.mcpConfigPath = join(projectDir, '.mcp.json');
      }
    }

    // Step 2: Ensure CLAUDE.md has @-references
    instructionFileUpdated = this.updateInstructionFile(projectDir);
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, 'CLAUDE.md');
    }

    // Step 3: Register plugin in ~/.claude/settings.json
    const pluginResult = this.registerPlugin();
    if (pluginResult) {
      details.plugin = pluginResult;
    }

    this.installedProjectDir = projectDir;

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      mcpRegistered,
      details,
    };
  }

  /**
   * Uninstall CLEO from the current Claude Code project.
   *
   * Removes the MCP server registration from .mcp.json.
   * Does not remove CLAUDE.md references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {
    if (!this.installedProjectDir) return;

    const mcpPath = join(this.installedProjectDir, '.mcp.json');
    if (existsSync(mcpPath)) {
      try {
        const raw = readFileSync(mcpPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, unknown>;
        const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers && MCP_SERVER_KEY in mcpServers) {
          delete mcpServers[MCP_SERVER_KEY];
          writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        }
      } catch {
        // Ignore errors during uninstall
      }
    }

    this.installedProjectDir = null;
  }

  /**
   * Check whether CLEO is installed in the current environment.
   *
   * Checks for:
   * 1. MCP server registered in .mcp.json
   * 2. Plugin enabled in ~/.claude/settings.json
   *
   * Returns true if either condition is met (partial install counts).
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

    // Check current directory for .mcp.json with cleo server
    const mcpPath = join(process.cwd(), '.mcp.json');
    if (existsSync(mcpPath)) {
      try {
        const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers && MCP_SERVER_KEY in mcpServers) {
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
   * Register the CLEO MCP server in .mcp.json.
   *
   * @returns true if registration was performed or updated
   */
  private registerMcpServer(projectDir: string, mcpServerPath: string): boolean {
    const mcpPath = join(projectDir, '.mcp.json');
    let config: Record<string, unknown> = {};

    if (existsSync(mcpPath)) {
      try {
        config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
      } catch {
        // Start fresh on parse error
      }
    }

    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const mcpServers = config.mcpServers as Record<string, unknown>;
    mcpServers[MCP_SERVER_KEY] = {
      command: 'node',
      args: [mcpServerPath],
    };

    writeFileSync(mcpPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
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
