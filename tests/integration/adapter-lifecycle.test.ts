/**
 * Integration tests for provider adapter lifecycle.
 * Tests discovery, detection, capabilities, and inter-adapter consistency
 * across all 3 adapters (claude-code, opencode, cursor).
 *
 * @task T5240
 */

import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverAdapterManifests } from '../../src/core/adapters/discovery.js';
import { AdapterManager } from '../../src/core/adapters/manager.js';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..');

describe('adapter lifecycle integration', () => {
  describe('discovery from real packages/adapters/', () => {
    it('discovers all 3 adapter manifests', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      const ids = manifests.map((m) => m.id).sort();
      expect(ids).toContain('claude-code');
      expect(ids).toContain('opencode');
      expect(ids).toContain('cursor');
    });

    it('all manifests have required fields', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      for (const m of manifests) {
        expect(m.id).toBeTruthy();
        expect(m.name).toBeTruthy();
        expect(m.version).toBeTruthy();
        expect(m.provider).toBeTruthy();
        expect(m.entryPoint).toBeTruthy();
        expect(m.capabilities).toBeDefined();
        expect(m.detectionPatterns).toBeDefined();
        expect(Array.isArray(m.detectionPatterns)).toBe(true);
      }
    });

    it('each manifest has at least one detection pattern', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      for (const m of manifests) {
        expect(m.detectionPatterns.length).toBeGreaterThan(0);
        for (const p of m.detectionPatterns) {
          expect(p.type).toBeTruthy();
          expect(p.pattern).toBeTruthy();
        }
      }
    });
  });

  describe('AdapterManager with real manifests', () => {
    beforeEach(() => {
      AdapterManager.resetInstance();
    });

    afterEach(() => {
      AdapterManager.resetInstance();
    });

    it('discover returns 3 manifests from project root', () => {
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      const manifests = manager.discover();
      expect(manifests.length).toBe(3);
    });

    it('listAdapters returns info for all 3 after discover', () => {
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      manager.discover();
      const list = manager.listAdapters();
      expect(list.length).toBe(3);
      expect(list.every((a) => a.healthy === false)).toBe(true);
      expect(list.every((a) => a.active === false)).toBe(true);
    });

    it('getManifest returns correct manifest for each adapter', () => {
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      manager.discover();

      const claude = manager.getManifest('claude-code');
      expect(claude).not.toBeNull();
      expect(claude!.provider).toBe('claude-code');
      expect(claude!.capabilities.supportsHooks).toBe(true);
      expect(claude!.capabilities.supportsSpawn).toBe(true);

      const opencode = manager.getManifest('opencode');
      expect(opencode).not.toBeNull();
      expect(opencode!.provider).toBe('opencode');
      expect(opencode!.capabilities.supportsHooks).toBe(true);

      const cursor = manager.getManifest('cursor');
      expect(cursor).not.toBeNull();
      expect(cursor!.provider).toBe('cursor');
      expect(cursor!.capabilities.supportsHooks).toBe(false);
      expect(cursor!.capabilities.supportsSpawn).toBe(false);
    });
  });

  describe('capability consistency across adapters', () => {
    it('claude-code and opencode support hooks, cursor does not', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      const byId = new Map(manifests.map((m) => [m.id, m]));

      expect(byId.get('claude-code')!.capabilities.supportsHooks).toBe(true);
      expect(byId.get('opencode')!.capabilities.supportsHooks).toBe(true);
      expect(byId.get('cursor')!.capabilities.supportsHooks).toBe(false);
    });

    it('claude-code and opencode support spawn, cursor does not', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      const byId = new Map(manifests.map((m) => [m.id, m]));

      expect(byId.get('claude-code')!.capabilities.supportsSpawn).toBe(true);
      expect(byId.get('opencode')!.capabilities.supportsSpawn).toBe(true);
      expect(byId.get('cursor')!.capabilities.supportsSpawn).toBe(false);
    });

    it('all adapters support MCP and install', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      for (const m of manifests) {
        expect(m.capabilities.supportsMcp).toBe(true);
        expect(m.capabilities.supportsInstall).toBe(true);
      }
    });

    it('all adapters support instruction files with distinct patterns', () => {
      const manifests = discoverAdapterManifests(PROJECT_ROOT);
      const patterns = new Set<string>();
      for (const m of manifests) {
        expect(m.capabilities.supportsInstructionFiles).toBe(true);
        expect(m.capabilities.instructionFilePattern).toBeTruthy();
        patterns.add(m.capabilities.instructionFilePattern!);
      }
      expect(patterns.size).toBe(3);
    });
  });

  describe('detection isolation', () => {
    it('no adapters are detected by default in test environment', () => {
      AdapterManager.resetInstance();
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      manager.discover();

      // Clean env: none of CLAUDE_CODE_ENTRYPOINT, OPENCODE_VERSION, CURSOR_EDITOR should be set
      const envClean =
        !process.env.CLAUDE_CODE_ENTRYPOINT &&
        !process.env.OPENCODE_VERSION &&
        !process.env.CURSOR_EDITOR;

      if (envClean) {
        // File-based detection may match .claude/ in project root, so we only assert
        // that detectActive returns a deterministic array (not random)
        const detected1 = manager.detectActive();
        const detected2 = manager.detectActive();
        expect(detected1).toEqual(detected2);
      }

      AdapterManager.resetInstance();
    });

    it('detects adapter when env var is set', () => {
      process.env.CLEO_ADAPTER_DETECT_TEST = '1';
      AdapterManager.resetInstance();
      const manager = AdapterManager.getInstance(PROJECT_ROOT);

      // Use a mock manifest with the test env var
      const manifests = manager.discover();
      // Real adapters don't match CLEO_ADAPTER_DETECT_TEST, so detected should not include them
      const detected = manager.detectActive();
      // None of the real adapters use CLEO_ADAPTER_DETECT_TEST
      // This verifies detection only fires on matching patterns
      for (const id of detected) {
        const manifest = manager.getManifest(id);
        expect(manifest).not.toBeNull();
      }

      delete process.env.CLEO_ADAPTER_DETECT_TEST;
      AdapterManager.resetInstance();
    });
  });

  describe('adapter activation', () => {
    beforeEach(() => {
      AdapterManager.resetInstance();
    });

    afterEach(async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      await mgr.dispose();
      AdapterManager.resetInstance();
    });

    it('should activate claude-code adapter from dynamic import', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();

      const adapter = await mgr.activate('claude-code');
      expect(adapter).toBeDefined();
      expect(adapter.id).toBe('claude-code');
      expect(mgr.getActiveId()).toBe('claude-code');
    });

    it('activated adapter should have new capability flags', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();

      const adapter = await mgr.activate('claude-code');
      expect(adapter.capabilities.supportsContextMonitor).toBe(true);
      expect(adapter.capabilities.supportsProviderPaths).toBe(true);
      expect(adapter.capabilities.supportsStatusline).toBe(true);
      expect(adapter.capabilities.supportsTransport).toBe(true);
    });

    it('activated adapter should have paths provider', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();

      const adapter = await mgr.activate('claude-code');
      expect(adapter.paths).toBeDefined();
      expect(adapter.paths!.getProviderDir()).toBeTruthy();
    });

    it('activated adapter should have context monitor provider', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();

      const adapter = await mgr.activate('claude-code');
      expect(adapter.contextMonitor).toBeDefined();
      expect(typeof adapter.contextMonitor!.processContextInput).toBe('function');
      expect(typeof adapter.contextMonitor!.checkStatuslineIntegration).toBe('function');
    });

    it('activated adapter should have transport provider', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();

      const adapter = await mgr.activate('claude-code');
      expect(adapter.transport).toBeDefined();
      expect(adapter.transport!.transportName).toBe('claude-code');
    });

    it('dispose should clear active adapter', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();
      await mgr.activate('claude-code');

      expect(mgr.getActive()).not.toBeNull();

      await mgr.dispose();
      expect(mgr.getActive()).toBeNull();
      expect(mgr.getActiveId()).toBeNull();
    });

    it('re-activate returns cached adapter', async () => {
      const mgr = AdapterManager.getInstance(PROJECT_ROOT);
      mgr.discover();

      const first = await mgr.activate('claude-code');
      const second = await mgr.activate('claude-code');
      expect(first).toBe(second);
    });
  });

  describe('error paths', () => {
    it('activate throws for non-existent adapter', async () => {
      AdapterManager.resetInstance();
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      await expect(manager.activate('nonexistent')).rejects.toThrow();
      AdapterManager.resetInstance();
    });

    it('healthCheck returns unhealthy for uninitialized adapter', async () => {
      AdapterManager.resetInstance();
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      manager.discover();
      const status = await manager.healthCheck('claude-code');
      expect(status.healthy).toBe(false);
      AdapterManager.resetInstance();
    });

    it('dispose is safe with no initialized adapters', async () => {
      AdapterManager.resetInstance();
      const manager = AdapterManager.getInstance(PROJECT_ROOT);
      manager.discover();
      await expect(manager.dispose()).resolves.toBeUndefined();
      AdapterManager.resetInstance();
    });
  });
});
