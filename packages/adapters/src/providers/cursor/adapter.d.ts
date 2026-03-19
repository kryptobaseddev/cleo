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
 * - Install: Registers MCP server in .cursor/mcp.json and manages rule files
 * - Hooks: Stub provider (Cursor has no lifecycle event system)
 * - Spawn: Not supported (Cursor has no CLI for subagent spawning)
 */
export declare class CursorAdapter implements CLEOProviderAdapter {
  readonly id = 'cursor';
  readonly name = 'Cursor';
  readonly version = '1.0.0';
  capabilities: AdapterCapabilities;
  hooks: CursorHookProvider;
  install: CursorInstallProvider;
  private projectDir;
  private initialized;
  constructor();
  /**
   * Initialize the adapter for a given project directory.
   *
   * @param projectDir - Root directory of the project
   */
  initialize(projectDir: string): Promise<void>;
  /**
   * Dispose the adapter and clean up resources.
   */
  dispose(): Promise<void>;
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
