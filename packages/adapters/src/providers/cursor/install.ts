/**
 * Cursor Install Provider
 *
 * Handles CLEO installation into Cursor environments:
 * - Registers CLEO MCP server in .cursor/mcp.json
 * - Ensures .cursorrules has CLEO @-references (legacy format)
 * - Creates .cursor/rules/cleo.mdc with CLEO references (modern format)
 *
 * Cursor supports two instruction file formats:
 * 1. Legacy: .cursorrules (flat file, project root)
 * 2. Modern: .cursor/rules/*.mdc (MDC format, per-rule files)
 *
 * This provider writes to both for maximum compatibility.
 *
 * @task T5240
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';

/** Lines that should appear in instruction files to reference CLEO. */
const INSTRUCTION_REFERENCES = ['@~/.cleo/templates/CLEO-INJECTION.md', '@.cleo/memory-bridge.md'];

/** MCP server registration key used in Cursor config. */
const MCP_SERVER_KEY = 'cleo';

/**
 * Install provider for Cursor.
 *
 * Manages CLEO's integration with Cursor by:
 * 1. Registering the CLEO MCP server in .cursor/mcp.json
 * 2. Creating/updating .cursorrules with @-references (legacy)
 * 3. Creating .cursor/rules/cleo.mdc with @-references (modern)
 */
export class CursorInstallProvider implements AdapterInstallProvider {
  private installedProjectDir: string | null = null;

  /**
   * Install CLEO into a Cursor project.
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

    // Step 1: Register MCP server in .cursor/mcp.json
    if (mcpServerPath) {
      mcpRegistered = this.registerMcpServer(projectDir, mcpServerPath);
      if (mcpRegistered) {
        details.mcpConfigPath = join(projectDir, '.cursor', 'mcp.json');
      }
    }

    // Step 2: Ensure instruction files have @-references
    instructionFileUpdated = this.updateInstructionFiles(projectDir);
    if (instructionFileUpdated) {
      details.instructionFiles = this.getUpdatedFileList(projectDir);
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
   * Uninstall CLEO from the current Cursor project.
   *
   * Removes the MCP server registration from .cursor/mcp.json.
   * Does not remove instruction file references (they are harmless if CLEO is not present).
   */
  async uninstall(): Promise<void> {
    if (!this.installedProjectDir) return;

    const mcpPath = join(this.installedProjectDir, '.cursor', 'mcp.json');
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
   * Checks for MCP server registered in .cursor/mcp.json.
   */
  async isInstalled(): Promise<boolean> {
    const mcpPath = join(process.cwd(), '.cursor', 'mcp.json');
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
   * Ensure instruction files contain @-references to CLEO.
   *
   * Updates .cursorrules (legacy) and creates .cursor/rules/cleo.mdc (modern).
   *
   * @param projectDir - Project root directory
   */
  async ensureInstructionReferences(projectDir: string): Promise<void> {
    this.updateInstructionFiles(projectDir);
  }

  /**
   * Register the CLEO MCP server in .cursor/mcp.json.
   *
   * Cursor stores MCP server configuration in .cursor/mcp.json
   * under the mcpServers key.
   *
   * @returns true if registration was performed or updated
   */
  private registerMcpServer(projectDir: string, mcpServerPath: string): boolean {
    const cursorDir = join(projectDir, '.cursor');
    const mcpPath = join(cursorDir, 'mcp.json');
    let config: Record<string, unknown> = {};

    mkdirSync(cursorDir, { recursive: true });

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
   * Update instruction files with CLEO @-references.
   *
   * Handles both legacy (.cursorrules) and modern (.cursor/rules/cleo.mdc) formats.
   *
   * @returns true if any file was created or modified
   */
  private updateInstructionFiles(projectDir: string): boolean {
    let updated = false;

    // Update legacy .cursorrules if it exists
    if (this.updateLegacyRules(projectDir)) {
      updated = true;
    }

    // Create/update modern .cursor/rules/cleo.mdc
    if (this.updateModernRules(projectDir)) {
      updated = true;
    }

    return updated;
  }

  /**
   * Update legacy .cursorrules file with @-references.
   * Only modifies the file if it already exists (does not create it).
   *
   * @returns true if the file was modified
   */
  private updateLegacyRules(projectDir: string): boolean {
    const rulesPath = join(projectDir, '.cursorrules');
    if (!existsSync(rulesPath)) {
      return false;
    }

    let content = readFileSync(rulesPath, 'utf-8');
    const missingRefs = INSTRUCTION_REFERENCES.filter((ref) => !content.includes(ref));

    if (missingRefs.length === 0) {
      return false;
    }

    const separator = content.endsWith('\n') ? '' : '\n';
    content = content + separator + missingRefs.join('\n') + '\n';
    writeFileSync(rulesPath, content, 'utf-8');
    return true;
  }

  /**
   * Create or update .cursor/rules/cleo.mdc with CLEO references.
   *
   * MDC (Markdown Component) format is Cursor's modern rule file format.
   * Each .mdc file in .cursor/rules/ is loaded as a rule set.
   *
   * @returns true if the file was created or modified
   */
  private updateModernRules(projectDir: string): boolean {
    const rulesDir = join(projectDir, '.cursor', 'rules');
    const mdcPath = join(rulesDir, 'cleo.mdc');

    const expectedContent = [
      '---',
      'description: CLEO task management protocol references',
      'globs: "**/*"',
      'alwaysApply: true',
      '---',
      '',
      ...INSTRUCTION_REFERENCES,
      '',
    ].join('\n');

    if (existsSync(mdcPath)) {
      const existing = readFileSync(mdcPath, 'utf-8');
      if (existing === expectedContent) {
        return false;
      }
    }

    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(mdcPath, expectedContent, 'utf-8');
    return true;
  }

  /**
   * Get list of instruction files that were updated.
   */
  private getUpdatedFileList(projectDir: string): string[] {
    const files: string[] = [];
    if (existsSync(join(projectDir, '.cursorrules'))) {
      files.push(join(projectDir, '.cursorrules'));
    }
    files.push(join(projectDir, '.cursor', 'rules', 'cleo.mdc'));
    return files;
  }
}
