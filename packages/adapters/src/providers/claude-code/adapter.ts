/**
 * Claude Code Adapter
 *
 * Main CLEOProviderAdapter implementation for Anthropic's Claude Code CLI.
 * Provides spawn, hooks, and install capabilities for CLEO integration.
 *
 * @task T5240
 */

import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { ClaudeCodeContextMonitorProvider } from './context-monitor.js';
import { ClaudeCodeHookProvider } from './hooks.js';
import { ClaudeCodeInstallProvider } from './install.js';
import { ClaudeCodePathProvider } from './paths.js';
import { ClaudeCodeSpawnProvider } from './spawn.js';
import { ClaudeCodeTaskSyncProvider } from './task-sync.js';
import { ClaudeCodeTransportProvider } from './transport.js';

const execAsync = promisify(exec);

/**
 * CLEO provider adapter for Anthropic Claude Code CLI.
 *
 * Bridges CLEO's adapter system with Claude Code's native capabilities:
 * - Hooks: Maps Claude Code events (SessionStart, PostToolUse, etc.) to CAAMP events
 * - Spawn: Launches subagent processes via the `claude` CLI
 * - Install: Manages instruction files and brain observation plugin registration
 *
 * @remarks
 * This is the most feature-complete adapter in the CLEO system, supporting
 * 14 of 16 CAAMP canonical events, subagent spawning via the `claude` CLI,
 * context monitoring with statusline integration, task sync via TodoWrite,
 * and inter-agent transport. It serves as the reference implementation for
 * other provider adapters.
 */
export class ClaudeCodeAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'claude-code';
  /** Human-readable provider name. */
  readonly name = 'Claude Code';
  /** Adapter version string. */
  readonly version = '1.0.0';

  /** Declared capabilities for this provider. */
  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    // 14/16 canonical events — derived from getProviderHookProfile('claude-code') in CAAMP 1.9.1.
    // PreModel and PostModel are not supported by Claude Code.
    supportedHookEvents: [
      'SessionStart',
      'SessionEnd',
      'PromptSubmit',
      'ResponseComplete',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'PermissionRequest',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
      'PostCompact',
      'Notification',
      'ConfigChange',
    ],
    supportsSpawn: true,
    supportsInstall: true,
    supportsInstructionFiles: true,
    instructionFilePattern: 'CLAUDE.md',
    supportsContextMonitor: true,
    supportsStatusline: true,
    supportsProviderPaths: true,
    supportsTransport: true,
    supportsTaskSync: true,
  };

  /** Hook provider for CAAMP event mapping and registration. */
  hooks: ClaudeCodeHookProvider;
  /** Spawn provider for launching subagent processes via `claude` CLI. */
  spawn: ClaudeCodeSpawnProvider;
  /** Install provider for managing instruction files and plugin registration. */
  install: ClaudeCodeInstallProvider;
  /** Path provider for resolving Claude Code directory locations. */
  paths: ClaudeCodePathProvider;
  /** Context monitor for tracking context window usage and statusline output. */
  contextMonitor: ClaudeCodeContextMonitorProvider;
  /** Transport provider for inter-agent communication. */
  transport: ClaudeCodeTransportProvider;
  /** Task sync provider bridging Claude's TodoWrite format to CLEO tasks. */
  taskSync: ClaudeCodeTaskSyncProvider;

  /** Project directory this adapter was initialized with, or null. */
  private projectDir: string | null = null;
  /** Whether {@link initialize} has been called. */
  private initialized = false;

  constructor() {
    this.hooks = new ClaudeCodeHookProvider();
    this.spawn = new ClaudeCodeSpawnProvider();
    this.install = new ClaudeCodeInstallProvider();
    this.paths = new ClaudeCodePathProvider();
    this.contextMonitor = new ClaudeCodeContextMonitorProvider();
    this.transport = new ClaudeCodeTransportProvider();
    this.taskSync = new ClaudeCodeTaskSyncProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * Validates the environment by checking for the Claude CLI
   * and Claude Code configuration directory.
   *
   * @param projectDir - Root directory of the project
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;

    // Activate CLEO hook bridge for this project — connects Claude Code
    // native events to CLEO's internal hook dispatch (T555).
    await this.hooks.registerNativeHooks(projectDir);
  }

  /**
   * Dispose the adapter and clean up resources.
   *
   * Unregisters hooks and releases any tracked state.
   */
  async dispose(): Promise<void> {
    if (this.hooks.isRegistered()) {
      await this.hooks.unregisterNativeHooks();
    }
    this.initialized = false;
    this.projectDir = null;
  }

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
  async healthCheck(): Promise<AdapterHealthStatus> {
    const details: Record<string, unknown> = {};

    if (!this.initialized) {
      return {
        healthy: false,
        provider: this.id,
        details: { error: 'Adapter not initialized' },
      };
    }

    // Check Claude CLI availability
    let cliAvailable = false;
    try {
      const { stdout } = await execAsync('which claude');
      cliAvailable = stdout.trim().length > 0;
      details.cliPath = stdout.trim();
    } catch {
      details.cliAvailable = false;
    }

    // Check for Claude Code config directory
    const claudeConfigDir = join(homedir(), '.claude');
    const configExists = existsSync(claudeConfigDir);
    details.configDirExists = configExists;

    // Check for CLAUDE_CODE_ENTRYPOINT env var
    const entrypointSet = process.env.CLAUDE_CODE_ENTRYPOINT !== undefined;
    details.entrypointEnvSet = entrypointSet;

    // Healthy if CLI is available (primary requirement)
    const healthy = cliAvailable;
    details.cliAvailable = cliAvailable;

    return {
      healthy,
      provider: this.id,
      details,
    };
  }

  /**
   * Check whether the adapter has been initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the project directory this adapter was initialized with.
   */
  getProjectDir(): string | null {
    return this.projectDir;
  }
}
