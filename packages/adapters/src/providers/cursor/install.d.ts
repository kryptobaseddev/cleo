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
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
/**
 * Install provider for Cursor.
 *
 * Manages CLEO's integration with Cursor by:
 * 1. Registering the CLEO MCP server in .cursor/mcp.json
 * 2. Creating/updating .cursorrules with @-references (legacy)
 * 3. Creating .cursor/rules/cleo.mdc with @-references (modern)
 */
export declare class CursorInstallProvider implements AdapterInstallProvider {
  private installedProjectDir;
  /**
   * Install CLEO into a Cursor project.
   *
   * @param options - Installation options including project directory and MCP server path
   * @returns Result describing what was installed
   */
  install(options: InstallOptions): Promise<InstallResult>;
  /**
   * Uninstall CLEO from the current Cursor project.
   *
   * Removes the MCP server registration from .cursor/mcp.json.
   * Does not remove instruction file references (they are harmless if CLEO is not present).
   */
  uninstall(): Promise<void>;
  /**
   * Check whether CLEO is installed in the current environment.
   *
   * Checks for MCP server registered in .cursor/mcp.json.
   */
  isInstalled(): Promise<boolean>;
  /**
   * Ensure instruction files contain @-references to CLEO.
   *
   * Updates .cursorrules (legacy) and creates .cursor/rules/cleo.mdc (modern).
   *
   * @param projectDir - Project root directory
   */
  ensureInstructionReferences(projectDir: string): Promise<void>;
  /**
   * Register the CLEO MCP server in .cursor/mcp.json.
   *
   * Cursor stores MCP server configuration in .cursor/mcp.json
   * under the mcpServers key.
   *
   * @returns true if registration was performed or updated
   */
  private registerMcpServer;
  /**
   * Update instruction files with CLEO @-references.
   *
   * Handles both legacy (.cursorrules) and modern (.cursor/rules/cleo.mdc) formats.
   *
   * @returns true if any file was created or modified
   */
  private updateInstructionFiles;
  /**
   * Update legacy .cursorrules file with @-references.
   * Only modifies the file if it already exists (does not create it).
   *
   * @returns true if the file was modified
   */
  private updateLegacyRules;
  /**
   * Create or update .cursor/rules/cleo.mdc with CLEO references.
   *
   * MDC (Markdown Component) format is Cursor's modern rule file format.
   * Each .mdc file in .cursor/rules/ is loaded as a rule set.
   *
   * @returns true if the file was created or modified
   */
  private updateModernRules;
  /**
   * Get list of instruction files that were updated.
   */
  private getUpdatedFileList;
}
//# sourceMappingURL=install.d.ts.map
