/**
 * Kimi Adapter
 *
 * Main CLEOProviderAdapter implementation for Moonshot AI Kimi.
 * Provides install-only capabilities for CLEO integration.
 * Kimi has no native hook system, so integration is via MCP only.
 *
 * @task T163
 * @epic T134
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
import { KimiHookProvider } from './hooks.js';
import { KimiInstallProvider } from './install.js';

const execAsync = promisify(exec);

/**
 * CLEO provider adapter for Moonshot AI Kimi.
 *
 * Bridges CLEO's adapter system with Kimi's integration surface:
 * - Hooks: No-op (Kimi has no native hook system)
 * - Install: Registers MCP server in ~/.kimi/mcp.json and ensures AGENTS.md references
 *
 * @task T163
 * @epic T134
 */
export class KimiAdapter implements CLEOProviderAdapter {
  readonly id = 'kimi';
  readonly name = 'Kimi';
  readonly version = '1.0.0';

  capabilities: AdapterCapabilities = {
    supportsHooks: false,
    supportedHookEvents: [],
    supportsSpawn: false,
    supportsInstall: true,
    supportsMcp: true,
    supportsInstructionFiles: false,
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: false,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  hooks: KimiHookProvider;
  install: KimiInstallProvider;

  private projectDir: string | null = null;
  private initialized = false;

  constructor() {
    this.hooks = new KimiHookProvider();
    this.install = new KimiInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * @param projectDir - Root directory of the project
   * @task T163
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and clean up resources.
   *
   * Releases tracked state. No hooks to unregister since Kimi
   * has no native hook system.
   * @task T163
   */
  async dispose(): Promise<void> {
    this.initialized = false;
    this.projectDir = null;
  }

  /**
   * Run a health check to verify Kimi is accessible.
   *
   * Checks:
   * 1. Adapter has been initialized
   * 2. Kimi CLI binary is available in PATH
   * 3. ~/.kimi/ configuration directory exists
   *
   * @returns Health status with details about each check
   * @task T163
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

    // Check Kimi CLI availability
    let cliAvailable = false;
    try {
      const { stdout } = await execAsync('which kimi');
      cliAvailable = stdout.trim().length > 0;
      details.cliPath = stdout.trim();
    } catch {
      details.cliAvailable = false;
    }

    // Check for Kimi config directory
    const kimiConfigDir = join(homedir(), '.kimi');
    const configExists = existsSync(kimiConfigDir);
    details.configDirExists = configExists;

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
   * @task T163
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the project directory this adapter was initialized with.
   * @task T163
   */
  getProjectDir(): string | null {
    return this.projectDir;
  }
}
