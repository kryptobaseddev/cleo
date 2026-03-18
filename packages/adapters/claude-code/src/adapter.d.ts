/**
 * Claude Code Adapter
 *
 * Main CLEOProviderAdapter implementation for Anthropic's Claude Code CLI.
 * Provides spawn, hooks, and install capabilities for CLEO integration.
 *
 * @task T5240
 */
import type { AdapterCapabilities, AdapterHealthStatus, CLEOProviderAdapter } from '@cleocode/contracts';
import { ClaudeCodeContextMonitorProvider } from './context-monitor.js';
import { ClaudeCodeHookProvider } from './hooks.js';
import { ClaudeCodeInstallProvider } from './install.js';
import { ClaudeCodePathProvider } from './paths.js';
import { ClaudeCodeSpawnProvider } from './spawn.js';
import { ClaudeCodeTransportProvider } from './transport.js';
/**
 * CLEO provider adapter for Anthropic Claude Code CLI.
 *
 * Bridges CLEO's adapter system with Claude Code's native capabilities:
 * - Hooks: Maps Claude Code events (SessionStart, PostToolUse, etc.) to CAAMP events
 * - Spawn: Launches subagent processes via the `claude` CLI
 * - Install: Registers MCP server, instruction files, and brain observation plugin
 */
export declare class ClaudeCodeAdapter implements CLEOProviderAdapter {
    readonly id = "claude-code";
    readonly name = "Claude Code";
    readonly version = "1.0.0";
    capabilities: AdapterCapabilities;
    hooks: ClaudeCodeHookProvider;
    spawn: ClaudeCodeSpawnProvider;
    install: ClaudeCodeInstallProvider;
    paths: ClaudeCodePathProvider;
    contextMonitor: ClaudeCodeContextMonitorProvider;
    transport: ClaudeCodeTransportProvider;
    private projectDir;
    private initialized;
    constructor();
    /**
     * Initialize the adapter for a given project directory.
     *
     * Validates the environment by checking for the Claude CLI
     * and Claude Code configuration directory.
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
     * Run a health check to verify Claude Code is accessible.
     *
     * Checks:
     * 1. Adapter has been initialized
     * 2. Claude CLI is available in PATH
     * 3. ~/.claude/ configuration directory exists
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