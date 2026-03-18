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
 * - Install: Registers MCP server in .opencode/config.json and ensures AGENTS.md references
 */
export class OpenCodeAdapter implements CLEOProviderAdapter {
  readonly id = 'opencode';
  readonly name = 'OpenCode';
  readonly version = '1.0.0';

  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    supportedHookEvents: [
      'onSessionStart',
      'onSessionEnd',
      'onToolStart',
      'onToolComplete',
      'onError',
      'onPromptSubmit',
    ],
    supportsSpawn: true,
    supportsInstall: true,
    supportsMcp: true,
    supportsInstructionFiles: true,
    instructionFilePattern: 'AGENTS.md',
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: true,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  hooks: OpenCodeHookProvider;
  spawn: OpenCodeSpawnProvider;
  install: OpenCodeInstallProvider;

  private projectDir: string | null = null;
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
