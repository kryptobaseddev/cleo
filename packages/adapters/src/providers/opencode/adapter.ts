/**
 * OpenCode Adapter
 *
 * Main CLEOProviderAdapter implementation for OpenCode AI coding assistant.
 * Provides spawn, hooks, and install capabilities for CLEO integration.
 *
 * @task T5240
 */

import { exec } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { OpenCodeHookProvider } from './hooks.js';
import { OpenCodeInstallProvider } from './install.js';
import { OpenCodeSpawnProvider } from './spawn.js';

const execAsync = promisify(exec);

/**
 * CLEO provider adapter for OpenCode AI coding assistant.
 *
 * Bridges CLEO's adapter system with OpenCode's native capabilities:
 * - Hooks: Maps OpenCode events (session.start, tool.complete, etc.) to CAAMP events
 * - Spawn: Launches subagent processes via the `opencode` CLI
 * - Install: Ensures AGENTS.md references for CLEO instruction files
 *
 * @remarks
 * OpenCode is the second-most feature-complete adapter after Claude Code,
 * supporting 10 canonical events through its JavaScript plugin system,
 * subagent spawning via the `opencode run` CLI command, and instruction
 * file management via AGENTS.md. It uniquely supports PreModel via the
 * `chat.params` event, which allows pre-inference parameter injection.
 */
export class OpenCodeAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'opencode';
  /** Human-readable provider name. */
  readonly name = 'OpenCode';
  /** Adapter version string. */
  readonly version = '1.0.0';

  /** Declared capabilities for this provider. */
  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    // 10/16 canonical events — derived from getProviderHookProfile('opencode') in CAAMP 1.9.1.
    // PostToolUseFailure, SubagentStart, SubagentStop, Notification, ConfigChange are
    // not supported by OpenCode's plugin system.
    supportedHookEvents: [
      'SessionStart',
      'SessionEnd',
      'PromptSubmit',
      'ResponseComplete',
      'PreToolUse',
      'PostToolUse',
      'PermissionRequest',
      'PreModel',
      'PreCompact',
      'PostCompact',
    ],
    supportsSpawn: true,
    supportsInstall: true,
    supportsInstructionFiles: true,
    instructionFilePattern: 'AGENTS.md',
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: true,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  /** Hook provider for CAAMP event mapping via OpenCode's plugin system. */
  hooks: OpenCodeHookProvider;
  /** Spawn provider for launching subagent processes via `opencode run`. */
  spawn: OpenCodeSpawnProvider;
  /** Install provider for managing AGENTS.md instruction files. */
  install: OpenCodeInstallProvider;

  /** Project directory this adapter was initialized with, or null. */
  private projectDir: string | null = null;
  /** Whether {@link initialize} has been called. */
  private initialized = false;

  constructor() {
    this.hooks = new OpenCodeHookProvider();
    this.spawn = new OpenCodeSpawnProvider();
    this.install = new OpenCodeInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * Validates the environment by checking for the OpenCode CLI
   * and OpenCode configuration directory.
   *
   * @param projectDir - Root directory of the project
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
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
   * Run a health check to verify OpenCode is accessible.
   *
   * Checks:
   * 1. Adapter has been initialized
   * 2. OpenCode CLI is available in PATH
   * 3. .opencode/ configuration directory exists in the project
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

    // Check OpenCode CLI availability
    let cliAvailable = false;
    try {
      const { stdout } = await execAsync('which opencode');
      cliAvailable = stdout.trim().length > 0;
      details.cliPath = stdout.trim();
    } catch {
      details.cliAvailable = false;
    }

    // Check for OpenCode config directory in the project
    if (this.projectDir) {
      const openCodeConfigDir = join(this.projectDir, '.opencode');
      const configExists = existsSync(openCodeConfigDir);
      details.configDirExists = configExists;
    }

    // Check for OPENCODE_VERSION env var
    const versionEnvSet = process.env.OPENCODE_VERSION !== undefined;
    details.versionEnvSet = versionEnvSet;

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
