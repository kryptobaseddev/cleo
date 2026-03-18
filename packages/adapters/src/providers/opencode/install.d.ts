/**
 * OpenCode Install Provider
 *
 * Handles CLEO installation into OpenCode environments:
 * - Registers CLEO MCP server in .opencode/config.json
 * - Ensures AGENTS.md has CLEO @-references
 *
 * @task T5240
 */
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
/**
 * Install provider for OpenCode.
 *
 * Manages CLEO's integration with OpenCode by:
 * 1. Registering the CLEO MCP server in .opencode/config.json
 * 2. Ensuring AGENTS.md contains @-references to CLEO instruction files
 */
export declare class OpenCodeInstallProvider implements AdapterInstallProvider {
    private installedProjectDir;
    /**
     * Install CLEO into an OpenCode project.
     *
     * @param options - Installation options including project directory and MCP server path
     * @returns Result describing what was installed
     */
    install(options: InstallOptions): Promise<InstallResult>;
    /**
     * Uninstall CLEO from the current OpenCode project.
     *
     * Removes the MCP server registration from .opencode/config.json.
     * Does not remove AGENTS.md references (they are harmless if CLEO is not present).
     */
    uninstall(): Promise<void>;
    /**
     * Check whether CLEO is installed in the current environment.
     *
     * Checks for MCP server registered in .opencode/config.json.
     * Returns true if the CLEO MCP server entry is found.
     */
    isInstalled(): Promise<boolean>;
    /**
     * Ensure AGENTS.md contains @-references to CLEO instruction files.
     *
     * Creates AGENTS.md if it does not exist. Appends any missing references.
     *
     * @param projectDir - Project root directory
     */
    ensureInstructionReferences(projectDir: string): Promise<void>;
    /**
     * Register the CLEO MCP server in .opencode/config.json.
     *
     * OpenCode stores its MCP server configuration in .opencode/config.json
     * under the mcpServers key.
     *
     * @returns true if registration was performed or updated
     */
    private registerMcpServer;
    /**
     * Update AGENTS.md with CLEO @-references.
     *
     * @returns true if the file was created or modified
     */
    private updateInstructionFile;
}
//# sourceMappingURL=install.d.ts.map