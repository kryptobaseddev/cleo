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
import type { AdapterInstallProvider, InstallOptions, InstallResult } from '@cleocode/contracts';
/**
 * Install provider for Claude Code.
 *
 * Manages CLEO's integration with Claude Code by:
 * 1. Registering the CLEO MCP server in the project's .mcp.json
 * 2. Ensuring CLAUDE.md contains @-references to CLEO instruction files
 * 3. Registering the brain observation plugin in ~/.claude/settings.json
 */
export declare class ClaudeCodeInstallProvider implements AdapterInstallProvider {
    private installedProjectDir;
    /**
     * Install CLEO into a Claude Code project.
     *
     * @param options - Installation options including project directory and MCP server path
     * @returns Result describing what was installed
     */
    install(options: InstallOptions): Promise<InstallResult>;
    /**
     * Uninstall CLEO from the current Claude Code project.
     *
     * Removes the MCP server registration from .mcp.json.
     * Does not remove CLAUDE.md references (they are harmless if CLEO is not present).
     */
    uninstall(): Promise<void>;
    /**
     * Check whether CLEO is installed in the current environment.
     *
     * Checks for:
     * 1. MCP server registered in .mcp.json
     * 2. Plugin enabled in ~/.claude/settings.json
     *
     * Returns true if either condition is met (partial install counts).
     */
    isInstalled(): Promise<boolean>;
    /**
     * Ensure CLAUDE.md contains @-references to CLEO instruction files.
     *
     * Creates CLAUDE.md if it does not exist. Appends any missing references.
     *
     * @param projectDir - Project root directory
     */
    ensureInstructionReferences(projectDir: string): Promise<void>;
    /**
     * Register the CLEO MCP server in .mcp.json.
     *
     * @returns true if registration was performed or updated
     */
    private registerMcpServer;
    /**
     * Update CLAUDE.md with CLEO @-references.
     *
     * @returns true if the file was created or modified
     */
    private updateInstructionFile;
    /**
     * Register the CLEO brain plugin in ~/.claude/settings.json.
     *
     * @returns Description of what was registered, or null if no change needed
     */
    private registerPlugin;
}
//# sourceMappingURL=install.d.ts.map