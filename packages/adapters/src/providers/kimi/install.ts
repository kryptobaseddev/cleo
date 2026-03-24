/**
 * Kimi Install Provider
 *
 * Handles CLEO installation into Kimi environments:
 * - Registers CLEO MCP server in ~/.kimi/mcp.json
 * - Ensures AGENTS.md has CLEO @-references
 *
 * Kimi has no native hook system, so this is the primary integration
 * mechanism: registering the MCP server so CLEO can be accessed as a tool.
 *
 * @task T163
 * @epic T134
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in AGENTS.md to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/** MCP server registration key used in Kimi MCP config. */
const MCP_SERVER_KEY = 'cleo';

/**
 * Install provider for Kimi.
 *
 * Manages CLEO's integration with Kimi by:
 * 1. Registering the CLEO MCP server in ~/.kimi/mcp.json
 * 2. Ensuring AGENTS.md contains @-references to CLEO instruction files
 *
 * Since Kimi has no native hook system, MCP registration is the only
 * mechanism for surfacing CLEO capabilities inside a Kimi session.
 *
 * @task T163
 * @epic T134
 */
export class KimiInstallProvider implements AdapterInstallProvider {
  /**
   * Install CLEO into a Kimi environment.
   *
   * @param options - Installation options including project directory and MCP server path
   * @returns Result describing what was installed
   * @task T163
   */
  async install(options: InstallOptions): Promise<InstallResult> {
    const { projectDir, mcpServerPath } = options;
    const installedAt = new Date().toISOString();
    let instructionFileUpdated = false;
    let mcpRegistered = false;
    const details: Record<string, unknown> = {};

    // Step 1: Register MCP server in ~/.kimi/mcp.json
    if (mcpServerPath) {
      mcpRegistered = this.registerMcpServer(mcpServerPath);
      if (mcpRegistered) {
        details.mcpConfigPath = join(homedir(), '.kimi', 'mcp.json');
      }
    }

    // Step 2: Ensure AGENTS.md has @-references
    instructionFileUpdated = this.updateInstructionFile(projectDir);
    if (instructionFileUpdated) {
      details.instructionFile = join(projectDir, 'AGENTS.md');
    }

    return {
      success: true,
      installedAt,
      instructionFileUpdated,
      mcpRegistered,
      details,
    };
  }

  /**
   * Uninstall CLEO from the Kimi environment.
   *
   * Removes the MCP server registration from ~/.kimi/mcp.json.
   * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
   * @task T163
   */
  async uninstall(): Promise<void> {
    const mcpPath = join(homedir(), '.kimi', 'mcp.json');
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
  }

  /**
   * Check whether CLEO is installed in the Kimi environment.
   *
   * Checks for MCP server registered in ~/.kimi/mcp.json.
   * Returns true if the CLEO MCP server entry is found.
   * @task T163
   */
  async isInstalled(): Promise<boolean> {
    const mcpPath = join(homedir(), '.kimi', 'mcp.json');
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
   * Ensure AGENTS.md contains @-references to CLEO instruction files.
   *
   * Creates AGENTS.md if it does not exist. Appends any missing references.
   *
   * @param projectDir - Project root directory
   * @task T163
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    this.updateInstructionFile(projectDir);
  }

  /**
   * Register the CLEO MCP server in ~/.kimi/mcp.json.
   *
   * Kimi stores its MCP server configuration in ~/.kimi/mcp.json
   * under the mcpServers key.
   *
   * @param mcpServerPath - Absolute path to the MCP server entry point
   * @returns true if registration was performed or updated
   */
  private registerMcpServer(mcpServerPath: string): boolean {
    const kimiDir = join(homedir(), '.kimi');
    const mcpPath = join(kimiDir, 'mcp.json');
    let config: Record<string, unknown> = {};

    mkdirSync(kimiDir, { recursive: true });

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
   * Update AGENTS.md with CLEO @-references.
   *
   * @param projectDir - Project root directory
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
      const separator = content.endsWith('\n') ? '' : '\n';
      content = content + separator + refsBlock + '\n';
    } else {
      content = refsBlock + '\n';
    }

    writeFileSync(agentsMdPath, content, 'utf-8');
    return true;
  }
}
