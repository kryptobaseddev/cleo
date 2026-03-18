/**
 * Type stubs for optional adapter packages.
 * These are dynamically imported at runtime — not bundled in core.
 */

declare module '@cleocode/adapter-claude-code' {
  import type {
    AdapterCapabilities,
    AdapterHealthStatus,
    AdapterInstallProvider,
    AdapterSpawnProvider,
    CLEOProviderAdapter,
    SpawnContext,
    SpawnResult,
  } from '@cleocode/contracts';

  export class ClaudeCodeAdapter implements CLEOProviderAdapter {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    capabilities: AdapterCapabilities;
    install: AdapterInstallProvider;
    spawn?: AdapterSpawnProvider;
    initialize(projectDir: string): Promise<void>;
    dispose(): Promise<void>;
    healthCheck(): Promise<AdapterHealthStatus>;
  }
  export class ClaudeCodeSpawnProvider implements AdapterSpawnProvider {
    canSpawn(): Promise<boolean>;
    spawn(context: SpawnContext): Promise<SpawnResult>;
    listRunning(): Promise<SpawnResult[]>;
    terminate(instanceId: string): Promise<void>;
  }
}

declare module '@cleocode/adapter-opencode' {
  import type {
    AdapterCapabilities,
    AdapterHealthStatus,
    AdapterInstallProvider,
    AdapterSpawnProvider,
    CLEOProviderAdapter,
    SpawnContext,
    SpawnResult,
  } from '@cleocode/contracts';

  export class OpenCodeAdapter implements CLEOProviderAdapter {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    capabilities: AdapterCapabilities;
    install: AdapterInstallProvider;
    spawn?: AdapterSpawnProvider;
    initialize(projectDir: string): Promise<void>;
    dispose(): Promise<void>;
    healthCheck(): Promise<AdapterHealthStatus>;
  }
  export class OpenCodeSpawnProvider implements AdapterSpawnProvider {
    canSpawn(): Promise<boolean>;
    spawn(context: SpawnContext): Promise<SpawnResult>;
    listRunning(): Promise<SpawnResult[]>;
    terminate(instanceId: string): Promise<void>;
  }
}

declare module '@cleocode/adapter-cursor' {
  import type {
    AdapterCapabilities,
    AdapterHealthStatus,
    AdapterInstallProvider,
    CLEOProviderAdapter,
  } from '@cleocode/contracts';

  export class CursorAdapter implements CLEOProviderAdapter {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    capabilities: AdapterCapabilities;
    install: AdapterInstallProvider;
    initialize(projectDir: string): Promise<void>;
    dispose(): Promise<void>;
    healthCheck(): Promise<AdapterHealthStatus>;
  }
}
