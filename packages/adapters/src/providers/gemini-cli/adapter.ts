/**
 * Gemini CLI Adapter
 *
 * Main CLEOProviderAdapter implementation for Google Gemini CLI.
 * Provides hooks and install capabilities for CLEO integration.
 *
 * @task T161
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
import { GeminiCliHookProvider } from './hooks.js';
import { GeminiCliInstallProvider } from './install.js';

const execAsync = promisify(exec);

/**
 * CLEO provider adapter for Google Gemini CLI.
 *
 * Bridges CLEO's adapter system with Gemini CLI's native capabilities:
 * - Hooks: Maps Gemini CLI events (SessionStart, PreToolUse, etc.) to CAAMP events
 * - Install: Ensures AGENTS.md references for CLEO instruction files
 *
 * @task T161
 * @epic T134
 */
export class GeminiCliAdapter implements CLEOProviderAdapter {
  readonly id = 'gemini-cli';
  readonly name = 'Gemini CLI';
  readonly version = '1.0.0';

  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    supportedHookEvents: [
      'SessionStart',
      'SessionEnd',
      'BeforeAgent',
      'AfterAgent',
      'BeforeTool',
      'AfterTool',
      'BeforeModel',
      'AfterModel',
      'PreCompress',
      'Notification',
    ],
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

  hooks: GeminiCliHookProvider;
  install: GeminiCliInstallProvider;

  private projectDir: string | null = null;
  private initialized = false;

  constructor() {
    this.hooks = new GeminiCliHookProvider();
    this.install = new GeminiCliInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * @param projectDir - Root directory of the project
   * @task T161
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and clean up resources.
   *
   * Unregisters hooks and releases any tracked state.
   * @task T161
   */
  async dispose(): Promise<void> {
    if (this.hooks.isRegistered()) {
      await this.hooks.unregisterNativeHooks();
    }
    this.initialized = false;
    this.projectDir = null;
  }

  /**
   * Run a health check to verify Gemini CLI is accessible.
   *
   * Checks:
   * 1. Adapter has been initialized
   * 2. Gemini CLI binary is available in PATH
   * 3. ~/.gemini/ configuration directory exists
   *
   * @returns Health status with details about each check
   * @task T161
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

    // Check Gemini CLI availability
    let cliAvailable = false;
    try {
      const { stdout } = await execAsync('which gemini');
      cliAvailable = stdout.trim().length > 0;
      details.cliPath = stdout.trim();
    } catch {
      details.cliAvailable = false;
    }

    // Check for Gemini CLI config directory
    const geminiConfigDir = join(homedir(), '.gemini');
    const configExists = existsSync(geminiConfigDir);
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
   * @task T161
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Get the project directory this adapter was initialized with.
   * @task T161
   */
  getProjectDir(): string | null {
    return this.projectDir;
  }
}
