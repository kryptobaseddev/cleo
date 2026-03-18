/**
 * OpenCode Adapter
 *
 * Main CLEOProviderAdapter implementation for OpenCode AI coding assistant.
 * Provides spawn, hooks, and install capabilities for CLEO integration.
 *
 * @task T5240
 */
import type { AdapterCapabilities, AdapterHealthStatus, CLEOProviderAdapter } from '@cleocode/contracts';
import { OpenCodeHookProvider } from './hooks.js';
import { OpenCodeInstallProvider } from './install.js';
import { OpenCodeSpawnProvider } from './spawn.js';
/**
 * CLEO provider adapter for OpenCode AI coding assistant.
 *
 * Bridges CLEO's adapter system with OpenCode's native capabilities:
 * - Hooks: Maps OpenCode events (session.start, tool.complete, etc.) to CAAMP events
 * - Spawn: Launches subagent processes via the `opencode` CLI
 * - Install: Registers MCP server in .opencode/config.json and ensures AGENTS.md references
 */
export declare class OpenCodeAdapter implements CLEOProviderAdapter {
    readonly id = "opencode";
    readonly name = "OpenCode";
    readonly version = "1.0.0";
    capabilities: AdapterCapabilities;
    hooks: OpenCodeHookProvider;
    spawn: OpenCodeSpawnProvider;
    install: OpenCodeInstallProvider;
    private projectDir;
    private initialized;
    constructor();
    /**
     * Initialize the adapter for a given project directory.
     *
     * Validates the environment by checking for the OpenCode CLI
     * and OpenCode configuration directory.
     *
     * @param projectDir - Root directory of the project
     */
    initialize(projectDir: string): Promise<void>;
    /**
     * Dispose the adapter and clean up resources.
     *
     * Unregisters hooks and releases any tracked state.
     */
    dispose(): Promise<void>;
    /**
     * Run a health check to verify OpenCode is accessible.
     *
     * Checks:
     * 1. Adapter has been initialized
     * 2. OpenCode CLI is available in PATH
     * 3. .opencode/ configuration directory exists in the project
     *
     * @returns Health status with details about each check
     */
    healthCheck(): Promise<AdapterHealthStatus>;
    /**
     * Check whether the adapter has been initialized.
     */
    isInitialized(): boolean;
    /**
     * Get the project directory this adapter was initialized with.
     */
    getProjectDir(): string | null;
}
//# sourceMappingURL=adapter.d.ts.map