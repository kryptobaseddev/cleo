/**
 * OpenCode Install Provider
 *
 * Handles CLEO installation into OpenCode environments:
 * - Registers CLEO MCP server in .opencode/config.json
 * - Ensures AGENTS.md has CLEO @-references
 *
 * @task T5240
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in AGENTS.md to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/** MCP server registration key used in OpenCode config. */
const MCP_SERVER_KEY = 'cleo';

/**
 * Install provider for OpenCode.
 *
 * Manages CLEO's integration with OpenCode by:
 * 1. Registering the CLEO MCP server in .opencode/config.json
 * 2. Ensuring AGENTS.md contains @-references to CLEO instruction files
 */
export class OpenCodeInstallProvider implements AdapterInstallProvider {
  private installedProjectDir: string | null = null;

  /**
   * Install CLEO into an OpenCode project.
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

    // Step 1: Register MCP server in .opencode/config.json
    if (mcpServerPath) {
      mcpRegistered = this.registerMcpServer(projectDir, mcpServerPath);
      if (mcpRegistered) {
        details.mcpConfigPath = join(projectDir, '.opencode', 'config.json');
      }
    }

    // Step 2: Ensure AGENTS.md has @-references
    instructionFileUpdated = this.updateInstructionFile(projectDir);
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, 'AGENTS.md');
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
   * Uninstall CLEO from the current OpenCode project.
   *
   * Removes the MCP server registration from .opencode/config.json.
   * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {
    if (!this.installedProjectDir) return;

    const configPath = join(this.installedProjectDir, '.opencode', 'config.json');
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw) as Record<string, unknown>;
        const mcpServers = config.mcpServers as Record<string, unknown> | undefined;
        if (mcpServers && MCP_SERVER_KEY in mcpServers) {
          delete mcpServers[MCP_SERVER_KEY];
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
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
   * Checks for MCP server registered in .opencode/config.json.
   * Returns true if the CLEO MCP server entry is found.
   */
  async isInstalled(): Promise<boolean> {
    // Check current directory for .opencode/config.json with cleo server
    const configPath = join(process.cwd(), '.opencode', 'config.json');
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
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
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * Creates AGENTS.md if it does not exist. Appends any missing references.
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    this.updateInstructionFile(projectDir);
  }

  /**
   * Register the CLEO MCP server in .opencode/config.json.
   *
   * OpenCode stores its MCP server configuration in .opencode/config.json
   * under the mcpServers key.
   *
   * @returns true if registration was performed or updated
   */
  private registerMcpServer(projectDir: string, mcpServerPath: string): boolean {
    const openCodeDir = join(projectDir, '.opencode');
    const configPath = join(openCodeDir, 'config.json');
    let config: Record<string, unknown> = {};

    mkdirSync(openCodeDir, { recursive: true });

    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'));
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

    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    return true;
  }

  /**
   * Update AGENTS.md with CLEO @-references.
   *
   * @returns true if the file was created or modified
   */
  private updateInstructionFile(projectDir: string): boolean {
    const agentsMdPath = join(projectDir, 'AGENTS.md');
    let content = '';
    let existed = false;

    if (existsSync(agentsMdPath)) {
      content = readFileSync(agentsMdPath, 'utf-8');
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
      // Create new AGENTS.md with references
      content = refsBlock + '\n';
    }

    writeFileSync(agentsMdPath, content, 'utf-8');
    return true;
  }
}
