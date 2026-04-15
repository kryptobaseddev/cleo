/**
 * OpenAI Agents SDK Adapter.
 *
 * Main `CLEOProviderAdapter` implementation for the OpenAI Agents SDK.
 * Provides spawn and install capabilities. Hooks are not supported (the
 * SDK does not expose a CLI hook system equivalent to Claude Code's).
 *
 * @task T582
 */

import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { OpenAiSdkInstallProvider } from './install.js';
import { OpenAiSdkSpawnProvider } from './spawn.js';

/**
 * CLEO provider adapter for the OpenAI Agents SDK.
 *
 * Bridges CLEO's adapter system with the `@openai/agents` SDK:
 * - Spawn: Launches agents via the SDK runner with handoff topology
 * - Install: Manages AGENTS.md @-references and .openai/ config directory
 * - Tracing: Default-on conduit span persistence via `CleoConduitTraceProcessor`
 *
 * @remarks
 * This adapter is the only CLEO provider with first-class handoff support.
 * Team Lead → Worker topology is declared in `SpawnContext.options.handoffs`
 * and wired directly to SDK `Agent.handoffs`. The SDK handles routing
 * internally without any CLEO glue code.
 *
 * This is also the only provider supporting 100+ LLMs via the Vercel AI SDK
 * bridge (capability flag: `supportsMultiModel`).
 */
export class OpenAiSdkAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'openai-sdk';
  /** Human-readable provider name. */
  readonly name = 'OpenAI Agents SDK';
  /** Adapter version string. */
  readonly version = '1.0.0';

  /** Declared capabilities for this provider. */
  capabilities: AdapterCapabilities = {
    supportsHooks: false,
    // The SDK does not expose CLI lifecycle hooks equivalent to Claude Code.
    supportedHookEvents: [],
    supportsSpawn: true,
    supportsInstall: true,
    supportsInstructionFiles: true,
    instructionFilePattern: 'AGENTS.md',
    supportsContextMonitor: false,
    supportsStatusline: false,
    supportsProviderPaths: false,
    supportsTransport: false,
    supportsTaskSync: false,
  };

  /** Spawn provider for SDK-backed agent runs with handoff topology. */
  spawn: OpenAiSdkSpawnProvider;
  /** Install provider for AGENTS.md and .openai/ config directory management. */
  install: OpenAiSdkInstallProvider;

  /** Project directory this adapter was initialized with, or null. */
  private projectDir: string | null = null;
  /** Whether {@link initialize} has been called. */
  private initialized = false;

  constructor() {
    this.spawn = new OpenAiSdkSpawnProvider();
    this.install = new OpenAiSdkInstallProvider();
  }

  /**
   * Initialize the adapter for a given project directory.
   *
   * @param projectDir - Root directory of the project.
   */
  async initialize(projectDir: string): Promise<void> {
    this.projectDir = projectDir;
    this.initialized = true;
  }

  /**
   * Dispose the adapter and release all resources.
   */
  async dispose(): Promise<void> {
    this.initialized = false;
    this.projectDir = null;
  }

  /**
   * Run a health check to verify the OpenAI SDK is usable.
   *
   * Checks:
   * 1. Adapter has been initialized
   * 2. `OPENAI_API_KEY` is set in the environment
   *
   * @returns Health status with details about each check.
   */
  async healthCheck(): Promise<AdapterHealthStatus> {
    if (!this.initialized) {
      return {
        healthy: false,
        provider: this.id,
        details: { error: 'Adapter not initialized' },
      };
    }

    const apiKeyPresent =
      typeof process.env.OPENAI_API_KEY === 'string' && process.env.OPENAI_API_KEY.length > 0;

    return {
      healthy: apiKeyPresent,
      provider: this.id,
      details: {
        apiKeyPresent,
        projectDir: this.projectDir,
        sdkVersion: '0.8.3',
      },
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
