/**
 * Core CLEOProviderAdapter interface.
 * Every provider adapter must implement this contract.
 *
 * @task T5240
 */

import type { AdapterCapabilities } from './capabilities.js';
import type { AdapterContextMonitorProvider } from './context-monitor.js';
import type { AdapterHookProvider } from './hooks.js';
import type { AdapterInstallProvider } from './install.js';
import type { AdapterPathProvider } from './provider-paths.js';
import type { AdapterSpawnProvider } from './spawn.js';
import type { ExternalTaskProvider } from './task-sync.js';
import type { AdapterTransportProvider } from './transport.js';

/**
 * Core provider adapter interface that every CLEO provider must implement.
 *
 * @remarks
 * Provider adapters bridge CLEO's core engine to specific LLM providers
 * (Claude, GPT, etc.). Each adapter declares its capabilities and exposes
 * optional sub-providers for hooks, spawning, paths, and transport.
 */
export interface CLEOProviderAdapter {
  /** Unique identifier for this adapter (e.g. `"claude"`, `"openai"`). */
  readonly id: string;
  /** Human-readable display name for the adapter. */
  readonly name: string;
  /** Semantic version of the adapter implementation. */
  readonly version: string;
  /** Capability flags declaring what this adapter supports. */
  capabilities: AdapterCapabilities;
  /**
   * Optional hook provider for lifecycle event integration.
   *
   * @defaultValue undefined
   */
  hooks?: AdapterHookProvider;
  /**
   * Optional spawn provider for launching sub-agents.
   *
   * @defaultValue undefined
   */
  spawn?: AdapterSpawnProvider;
  /** Installation provider for scaffolding adapter-specific config files. */
  install: AdapterInstallProvider;
  /**
   * Optional path provider for adapter-specific file locations.
   *
   * @defaultValue undefined
   */
  paths?: AdapterPathProvider;
  /**
   * Optional context monitor provider for tracking token usage.
   *
   * @defaultValue undefined
   */
  contextMonitor?: AdapterContextMonitorProvider;
  /**
   * Optional transport provider for inter-agent messaging.
   *
   * @defaultValue undefined
   */
  transport?: AdapterTransportProvider;
  /**
   * Optional external task sync provider for bidirectional issue tracking.
   *
   * @defaultValue undefined
   */
  taskSync?: ExternalTaskProvider;
  /** Initialize the adapter for the given project directory. */
  initialize(projectDir: string): Promise<void>;
  /** Release all resources held by the adapter. */
  dispose(): Promise<void>;
  /** Return the current health status of the adapter. */
  healthCheck(): Promise<AdapterHealthStatus>;
}

/**
 * Health check result returned by {@link CLEOProviderAdapter.healthCheck}.
 *
 * @remarks
 * Used by the `cleo doctor` command to verify adapter connectivity and
 * surface provider-specific diagnostic information.
 */
export interface AdapterHealthStatus {
  /** Whether the adapter is currently operational. */
  healthy: boolean;
  /** Name of the provider this status applies to. */
  provider: string;
  /**
   * Provider-specific diagnostic key-value pairs.
   *
   * @defaultValue undefined
   */
  details?: Record<string, unknown>;
}
