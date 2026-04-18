/**
 * OpenAI SDK Adapter — Vercel AI SDK edition.
 *
 * Main `CLEOProviderAdapter` implementation for the OpenAI provider, backed
 * by the Vercel AI SDK (`ai` v6 + `@ai-sdk/openai`). Provides spawn and
 * install capabilities. Hooks are not supported — the Vercel AI SDK does not
 * expose a CLI hook system equivalent to Claude Code's.
 *
 * @task T582 (original)
 * @task T933 (SDK consolidation — Vercel AI SDK migration)
 * @see ADR-052 — SDK consolidation decision
 */

import type {
  AdapterCapabilities,
  AdapterHealthStatus,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { OpenAiSdkInstallProvider } from './install.js';
import { OpenAiSdkSpawnProvider } from './spawn.js';

/**
 * CLEO provider adapter for the OpenAI provider.
 *
 * Bridges CLEO's adapter system with the Vercel AI SDK:
 * - Spawn: Launches agents via the SDK with CLEO-native handoff topology
 * - Install: Manages AGENTS.md @-references and .openai/ config directory
 * - Tracing: Default-on conduit span persistence via `CleoConduitTraceProcessor`
 *
 * @remarks
 * Handoff topology is CLEO-owned (see `handoff.ts`): lead agents delegate to
 * worker archetypes in sequence, and the concatenated output is returned.
 * The Vercel AI SDK surface (`generateText` / `streamText`) works uniformly
 * across Anthropic, OpenAI, and compatible providers, so the provider keeps
 * the `supportsMultiModel` capability flag.
 */
export class OpenAiSdkAdapter implements CLEOProviderAdapter {
  /** Unique provider identifier. */
  readonly id = 'openai-sdk';
  /** Human-readable provider name. */
  readonly name = 'OpenAI SDK (Vercel AI SDK)';
  /** Adapter version string. */
  readonly version = '2.0.0';

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
        sdkVersion: 'ai@6 + @ai-sdk/openai',
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
