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
import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { CursorHookProvider } from './hooks.js';
import { CursorInstallProvider } from './install.js';

/**
 * CLEO provider adapter for Cursor AI code editor.
 *
 * Bridges CLEO's adapter system with Cursor's capabilities:
 * - Install: Manages .cursorrules and .cursor/rules/cleo.mdc rule files
 * - Hooks: Stub provider (Cursor has no lifecycle event system)
 * - Spawn: Not supported (Cursor has no CLI for subagent spawning)
 *
 * @remarks
 * Cursor is a GUI-based editor, so many CLI-oriented capabilities
 * (spawn, transport, task sync, context monitor) are unsupported.
 * Integration is primarily through instruction rule files placed in
 * `.cursor/rules/` (modern MDC format) and `.cursorrules` (legacy).
 */
export class CursorAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'cursor';
  /** Human-readable provider name. */
  readonly name = 'Cursor';
  /** Adapter version string. */
  readonly version = '1.0.0';

  /** Declared capabilities for this provider. */
  capabilities: AdapterCapabilities = {
    supportsHooks: true,
    // 10/16 canonical events — derived from getProviderHookProfile('cursor') in CAAMP 1.9.1.
    // PermissionRequest, PreModel, PostModel, PostCompact, Notification, ConfigChange are
    // not supported by Cursor's hook system.
    supportedHookEvents: [
      'SessionStart',
      'SessionEnd',
      'PromptSubmit',
      'ResponseComplete',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
      'SubagentStart',
      'SubagentStop',
      'PreCompact',
    ],
    supportsSpawn: false,
    supportsInstall: true,
    supportsMcp: false,
    supportsInstructionFiles: true,
    instructionFilePattern: '.cursor/rules/*.mdc',
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: true,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  /** Hook provider for CAAMP event mapping. */
  hooks: CursorHookProvider;
  /** Install provider for managing rule files. */
  install: CursorInstallProvider;

  /** Project directory this adapter was initialized with, or null. */
  private projectDir: string | null = null;
  /** Whether {@link initialize} has been called. */
  private initialized = false;

  constructor() {
    this.hooks = new CursorHookProvider();
    this.install = new CursorInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * @param projectDir - Root directory of the project
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and clean up resources.
   */
  async dispose(): Promise<void> {
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
  async healthCheck(): Promise<AdapterHealthStatus> {
    const details: Record<string, unknown> = {};

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
