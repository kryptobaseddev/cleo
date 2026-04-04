/**
 * Codex CLI Adapter
 *
 * Main CLEOProviderAdapter implementation for OpenAI Codex CLI.
 * Provides hooks and install capabilities for CLEO integration.
 *
 * @task T162
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
import { CodexHookProvider } from './hooks.js';
import { CodexInstallProvider } from './install.js';

const execAsync = promisify(exec);

/**
 * CLEO provider adapter for OpenAI Codex CLI.
 *
 * Bridges CLEO's adapter system with Codex CLI's native capabilities:
 * - Hooks: Maps Codex events (SessionStart, PromptSubmit, ResponseComplete) to CAAMP events
 * - Install: Ensures AGENTS.md references for CLEO instruction files
 *
 * @task T162
 * @epic T134
 */
export class CodexAdapter implements CLEOProviderAdapter {
  readonly id = 'codex';
  readonly name = 'Codex';
  readonly version = '1.0.0';

  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    supportedHookEvents: ['SessionStart', 'UserPromptSubmit', 'Stop'],
    supportsSpawn: false,
    supportsInstall: true,
    supportsMcp: false,
    supportsInstructionFiles: false,
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: false,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  hooks: CodexHookProvider;
  install: CodexInstallProvider;

  private projectDir: string | null = null;
  private initialized = false;

  constructor() {
    this.hooks = new CodexHookProvider();
    this.install = new CodexInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * @param projectDir - Root directory of the project
   * @task T162
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and clean up resources.
   *
   * Unregisters hooks and releases any tracked state.
   * @task T162
   */
  async dispose(): Promise<void> {
    if (this.hooks.isRegistered()) {
      await this.hooks.unregisterNativeHooks();
    }
    this.initialized = false;
    this.projectDir = null;
  }

  /**
   * Run a health check to verify Codex CLI is accessible.
   *
   * Checks:
   * 1. Adapter has been initialized
   * 2. Codex CLI binary is available in PATH
   * 3. ~/.codex/ configuration directory exists
   *
   * @returns Health status with details about each check
   * @task T162
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

    // Check Codex CLI availability
    let cliAvailable = false;
    try {
      const { stdout } = await execAsync('which codex');
      cliAvailable = stdout.trim().length > 0;
      details.cliPath = stdout.trim();
    } catch {
      details.cliAvailable = false;
    }

    // Check for Codex CLI config directory
    const codexConfigDir = join(homedir(), '.codex');
    const configExists = existsSync(codexConfigDir);
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
   * @task T162
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the project directory this adapter was initialized with.
   * @task T162
   */
  getProjectDir(): string | null {
    return this.projectDir;
  }
}
