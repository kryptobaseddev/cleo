/**
 * AdapterManager: central registry for provider adapters.
 * Handles adapter lifecycle (discovery, initialization, health, disposal)
 * and tracks the active adapter for the current session.
 *
 * @task T5240
 */

import type {
  AdapterHealthStatus,
  AdapterManifest,
  CLEOProviderAdapter,
} from '@cleocode/contracts';
import { hooks } from '../hooks/registry.js';
import type { HookEvent, HookPayload } from '../hooks/types.js';
import { getLogger } from '../logger.js';
import { loadAdapterFromManifest } from './adapter-registry.js';
import { detectProvider, discoverAdapterManifests } from './discovery.js';

const log = getLogger('adapter-manager');

/** Summary info for an adapter without exposing the full instance. */
export interface AdapterInfo {
  id: string;
  name: string;
  version: string;
  provider: string;
  healthy: boolean;
  active: boolean;
}

/**
 * Central adapter manager. Singleton per process.
 *
 * Lifecycle:
 *   1. discover() — scan for adapter packages and their manifests
 *   2. activate(id) — load, initialize, and set as active adapter
 *   3. getActive() — return the current active adapter
 *   4. dispose() — clean up all initialized adapters
 */
export class AdapterManager {
  private static instance: AdapterManager | null = null;

  private adapters = new Map<string, CLEOProviderAdapter>();
  private manifests = new Map<string, AdapterManifest>();
  private hookCleanups = new Map<string, Array<() => void>>();
  private activeId: string | null = null;
  private projectRoot: string;

  private constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  static getInstance(projectRoot: string): AdapterManager {
    if (!AdapterManager.instance) {
      AdapterManager.instance = new AdapterManager(projectRoot);
    }
    return AdapterManager.instance;
  }

  /** Reset singleton (for testing). */
  static resetInstance(): void {
    AdapterManager.instance = null;
  }

  /**
   * Discover adapter manifests from packages/adapters/.
   * Returns manifests found (does not load adapter code yet).
   */
  discover(): AdapterManifest[] {
    const found = discoverAdapterManifests(this.projectRoot);
    for (const manifest of found) {
      this.manifests.set(manifest.id, manifest);
    }
    log.info({ count: found.length }, 'Discovered adapter manifests');
    return found;
  }

  /**
   * Auto-detect which adapters match the current environment
   * and return their manifest IDs.
   */
  detectActive(): string[] {
    const detected: string[] = [];
    for (const [id, manifest] of this.manifests) {
      if (detectProvider(manifest.detectionPatterns)) {
        detected.push(id);
      }
    }
    log.info({ detected }, 'Detected active providers');
    return detected;
  }

  /**
   * Load and initialize an adapter by manifest ID.
   * Dynamically imports from the manifest's packagePath — no hardcoded adapters.
   */
  async activate(adapterId: string): Promise<CLEOProviderAdapter> {
    const manifest = this.manifests.get(adapterId);
    if (!manifest) {
      throw new Error(`Adapter manifest not found: ${adapterId}`);
    }

    // Check if already loaded
    const existing = this.adapters.get(adapterId);
    if (existing) {
      this.activeId = adapterId;
      return existing;
    }

    try {
      // Dynamic import from discovered package path — no hardcoded adapters
      const adapter = await loadAdapterFromManifest(manifest);
      await adapter.initialize(this.projectRoot);
      this.adapters.set(adapterId, adapter);
      this.activeId = adapterId;

      // Wire hooks into HookRegistry
      if (adapter.hooks) {
        await this.wireAdapterHooks(adapterId, adapter);
      }

      log.info({ adapterId, provider: manifest.provider }, 'Adapter activated');
      return adapter;
    } catch (err) {
      log.error({ adapterId, err }, 'Failed to activate adapter');
      throw err;
    }
  }

  /** Get the currently active adapter, or null if none. */
  getActive(): CLEOProviderAdapter | null {
    if (!this.activeId) return null;
    return this.adapters.get(this.activeId) ?? null;
  }

  /** Get the active adapter's ID, or null. */
  getActiveId(): string | null {
    return this.activeId;
  }

  /** Get a specific adapter by ID. */
  get(adapterId: string): CLEOProviderAdapter | null {
    return this.adapters.get(adapterId) ?? null;
  }

  /** Get the manifest for a specific adapter. */
  getManifest(adapterId: string): AdapterManifest | null {
    return this.manifests.get(adapterId) ?? null;
  }

  /** List all known adapters with summary info. */
  listAdapters(): AdapterInfo[] {
    const result: AdapterInfo[] = [];
    for (const [id, manifest] of this.manifests) {
      const adapter = this.adapters.get(id);
      result.push({
        id,
        name: manifest.name,
        version: manifest.version,
        provider: manifest.provider,
        healthy: !!adapter,
        active: id === this.activeId,
      });
    }
    return result;
  }

  /** Run health check on all initialized adapters. */
  async healthCheckAll(): Promise<Map<string, AdapterHealthStatus>> {
    const results = new Map<string, AdapterHealthStatus>();
    for (const [id, adapter] of this.adapters) {
      try {
        const status = await adapter.healthCheck();
        results.set(id, status);
      } catch (err) {
        results.set(id, {
          healthy: false,
          provider: this.manifests.get(id)?.provider ?? 'unknown',
          details: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }
    return results;
  }

  /** Health check a single adapter. */
  async healthCheck(adapterId: string): Promise<AdapterHealthStatus> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) {
      return {
        healthy: false,
        provider: this.manifests.get(adapterId)?.provider ?? 'unknown',
        details: { error: 'Adapter not initialized' },
      };
    }
    try {
      return await adapter.healthCheck();
    } catch (err) {
      return {
        healthy: false,
        provider: this.manifests.get(adapterId)?.provider ?? 'unknown',
        details: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /** Dispose all initialized adapters. */
  async dispose(): Promise<void> {
    for (const [id, adapter] of this.adapters) {
      try {
        // Clean up hooks first
        await this.cleanupAdapterHooks(id, adapter);
        await adapter.dispose();
        log.info({ adapterId: id }, 'Adapter disposed');
      } catch (err) {
        log.error({ adapterId: id, err }, 'Failed to dispose adapter');
      }
    }
    this.adapters.clear();
    this.hookCleanups.clear();
    this.activeId = null;
  }

  /** Dispose a single adapter. */
  async disposeAdapter(adapterId: string): Promise<void> {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) return;
    try {
      await this.cleanupAdapterHooks(adapterId, adapter);
      await adapter.dispose();
    } catch (err) {
      log.error({ adapterId, err }, 'Failed to dispose adapter');
    }
    this.adapters.delete(adapterId);
    if (this.activeId === adapterId) {
      this.activeId = null;
    }
  }

  /**
   * Wire an adapter's hook event map into CLEO's HookRegistry.
   * Creates bridging handlers at priority 50 for each mapped event.
   */
  private async wireAdapterHooks(adapterId: string, adapter: CLEOProviderAdapter): Promise<void> {
    if (!adapter.hooks) return;

    try {
      await adapter.hooks.registerNativeHooks(this.projectRoot);
    } catch (err) {
      log.error({ adapterId, err }, 'Failed to register native hooks');
    }

    const eventMap = adapter.hooks.getEventMap?.();
    if (!eventMap) return;

    const cleanups: Array<() => void> = [];

    for (const [_providerEvent, caampEvent] of Object.entries(eventMap)) {
      const hookId = `adapter-${adapterId}-${caampEvent}`;
      const unregister = hooks.register({
        id: hookId,
        event: caampEvent as HookEvent,
        priority: 50,
        handler: async (_projectRoot: string, payload: HookPayload) => {
          log.debug({ adapterId, event: caampEvent, payload }, 'Adapter hook dispatched');
        },
      });
      cleanups.push(unregister);
    }

    this.hookCleanups.set(adapterId, cleanups);
  }

  /**
   * Clean up hook registrations for an adapter.
   */
  private async cleanupAdapterHooks(
    adapterId: string,
    adapter: CLEOProviderAdapter,
  ): Promise<void> {
    // Unregister from HookRegistry
    const cleanups = this.hookCleanups.get(adapterId);
    if (cleanups) {
      for (const fn of cleanups) {
        fn();
      }
      this.hookCleanups.delete(adapterId);
    }

    // Unregister native hooks
    try {
      await adapter.hooks?.unregisterNativeHooks();
    } catch (err) {
      log.error({ adapterId, err }, 'Failed to unregister native hooks');
    }
  }
}
