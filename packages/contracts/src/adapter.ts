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
import type { AdapterTransportProvider } from './transport.js';

export interface CLEOProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  capabilities: AdapterCapabilities;
  hooks?: AdapterHookProvider;
  spawn?: AdapterSpawnProvider;
  install: AdapterInstallProvider;
  paths?: AdapterPathProvider;
  contextMonitor?: AdapterContextMonitorProvider;
  transport?: AdapterTransportProvider;
  initialize(projectDir: string): Promise<void>;
  dispose(): Promise<void>;
  healthCheck(): Promise<AdapterHealthStatus>;
}

export interface AdapterHealthStatus {
  healthy: boolean;
  provider: string;
  details?: Record<string, unknown>;
}
