/**
 * Claude SDK provider adapter.
 *
 * Wraps {@link ClaudeSDKSpawnProvider} in the standard
 * {@link CLEOProviderAdapter} contract so registry and sovereignty probes can
 * treat the SDK-backed Claude provider like every other CLEO provider.
 *
 * @task T933
 * @packageDocumentation
 */

import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { ClaudeSDKInstallProvider } from './install.js';
import { ClaudeSDKSpawnProvider } from './spawn.js';

/**
 * CLEO provider adapter for Anthropic Claude via the Vercel AI SDK.
 *
 * @remarks
 * This adapter intentionally exposes spawn only. Hooks, instruction files, and
 * provider-native paths belong to CLI providers such as `claude-code`; the SDK
 * provider is the programmatic LLM bridge used when `provider.claude.mode` is
 * configured as `sdk`.
 */
export class ClaudeSDKAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'claude-sdk';
  /** Human-readable provider name. */
  readonly name = 'Claude SDK (Vercel AI SDK)';
  /** Adapter version string. */
  readonly version = '2.0.0';

  /** Declared capabilities for this provider. */
  capabilities: AdapterCapabilities = {
    supportsHooks: false,
    supportedHookEvents: [],
    supportsSpawn: true,
    supportsInstall: false,
    supportsInstructionFiles: false,
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: false,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  /** Spawn provider for SDK-backed Claude runs. */
  spawn: ClaudeSDKSpawnProvider;
  /** No-op install provider required by the adapter contract. */
  install: ClaudeSDKInstallProvider;

  private projectDir: string | null = null;
  private initialized = false;

  constructor() {
    this.spawn = new ClaudeSDKSpawnProvider();
    this.install = new ClaudeSDKInstallProvider();
  }

  /**
   * Initialize the adapter for a project directory.
   *
   * @param projectDir - Root directory of the project using this adapter.
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and clear tracked project state.
   */
  async dispose(): Promise<void> {
    this.projectDir = null;
    this.initialized = false;
  }

  /**
   * Check whether SDK-backed spawning can run in the current environment.
   *
   * @returns Adapter health with credential availability and initialization
   *   state.
   */
  async healthCheck(): Promise<AdapterHealthStatus> {
    const credentialsAvailable = await this.spawn.canSpawn();
    return {
      healthy: this.initialized && credentialsAvailable,
      provider: this.id,
      details: {
        initialized: this.initialized,
        credentialsAvailable,
        projectDir: this.projectDir,
        sdkVersion: 'ai@6 + @ai-sdk/anthropic',
      },
    };
  }
}
