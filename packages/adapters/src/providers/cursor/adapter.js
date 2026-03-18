/**
 * Cursor Adapter
 *
 * Main CLEOProviderAdapter implementation for Cursor AI code editor.
 * Provides install capabilities for CLEO integration. Hooks and spawn
 * are not supported since Cursor lacks CLI-based lifecycle events
 * and subagent spawning.
 *
 * @task T5240
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CursorHookProvider } from './hooks.js';
import { CursorInstallProvider } from './install.js';
/**
 * CLEO provider adapter for Cursor AI code editor.
 *
 * Bridges CLEO's adapter system with Cursor's capabilities:
 * - Install: Registers MCP server in .cursor/mcp.json and manages rule files
 * - Hooks: Stub provider (Cursor has no lifecycle event system)
 * - Spawn: Not supported (Cursor has no CLI for subagent spawning)
 */
export class CursorAdapter {
    id = 'cursor';
    name = 'Cursor';
    version = '1.0.0';
    capabilities = {
        supportsHooks: false,
        supportedHookEvents: [],
        supportsSpawn: false,
        supportsInstall: true,
        supportsMcp: true,
        supportsInstructionFiles: true,
        instructionFilePattern: '.cursor/rules/*.mdc',
        supportsContextMonitor: false,
        supportsStatusline: false,
        supportsProviderPaths: true,
        supportsTransport: false,
        supportsTaskSync: false,
    };
    hooks;
    install;
    projectDir = null;
    initialized = false;
    constructor() {
        this.hooks = new CursorHookProvider();
        this.install = new CursorInstallProvider();
    }
    /**
     * Initialize the adapter for a given project directory.
     *
     * @param projectDir - Root directory of the project
     */
    async initialize(projectDir) {
        this.projectDir = projectDir;
        this.initialized = true;
    }
    /**
     * Dispose the adapter and clean up resources.
     */
    async dispose() {
        if (this.hooks.isRegistered()) {
            await this.hooks.unregisterNativeHooks();
        }
        this.initialized = false;
        this.projectDir = null;
    }
    /**
     * Run a health check to verify Cursor is accessible.
     *
     * Checks:
     * 1. Adapter has been initialized
     * 2. .cursor/ configuration directory exists in the project
     * 3. CURSOR_EDITOR env var is set
     *
     * @returns Health status with details about each check
     */
    async healthCheck() {
        const details = {};
        if (!this.initialized) {
            return {
                healthy: false,
                provider: this.id,
                details: { error: 'Adapter not initialized' },
            };
        }
        // Check for Cursor config directory in the project
        let configExists = false;
        if (this.projectDir) {
            const cursorConfigDir = join(this.projectDir, '.cursor');
            configExists = existsSync(cursorConfigDir);
            details.configDirExists = configExists;
        }
        // Check for CURSOR_EDITOR env var
        const editorEnvSet = process.env.CURSOR_EDITOR !== undefined;
        details.editorEnvSet = editorEnvSet;
        // Check for legacy .cursorrules file
        if (this.projectDir) {
            const legacyRulesExist = existsSync(join(this.projectDir, '.cursorrules'));
            details.legacyRulesExist = legacyRulesExist;
        }
        // Healthy if we detect Cursor presence (config dir or env var)
        const healthy = configExists || editorEnvSet;
        details.detected = healthy;
        return {
            healthy,
            provider: this.id,
            details,
        };
    }
    /**
     * Check whether the adapter has been initialized.
     */
    isInitialized() {
        return this.initialized;
    }
    /**
     * Get the project directory this adapter was initialized with.
     */
    getProjectDir() {
        return this.projectDir;
    }
}
//# sourceMappingURL=adapter.js.map