/**
 * Tests for the OpenCode adapter package.
 *
 * @task T5240
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeAdapter } from '../adapter.js';
import { OpenCodeHookProvider } from '../hooks.js';
import { OpenCodeInstallProvider } from '../install.js';
import { OpenCodeSpawnProvider } from '../spawn.js';

// Mock child_process for health check and spawn tests
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(() => ({
    pid: 12345,
    unref: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('node:util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:util')>();
  return {
    ...actual,
    promisify: () => {
      // Return a mock for exec that simulates 'which opencode' succeeding
      return vi.fn().mockResolvedValue({ stdout: '/usr/local/bin/opencode', stderr: '' });
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('.opencode')) return true;
      if (typeof path === 'string' && path.includes('AGENTS.md')) return false;
      return false;
    }),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
  mkdir: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

describe('OpenCodeAdapter', () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  afterEach(async () => {
    if (adapter.isInitialized()) {
      await adapter.dispose();
    }
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('has correct id', () => {
      expect(adapter.id).toBe('opencode');
    });

    it('has correct name', () => {
      expect(adapter.name).toBe('OpenCode');
    });

    it('has correct version', () => {
      expect(adapter.version).toBe('1.0.0');
    });
  });

  describe('capabilities', () => {
    it('supports hooks', () => {
      expect(adapter.capabilities.supportsHooks).toBe(true);
    });

    it('supports spawn', () => {
      expect(adapter.capabilities.supportsSpawn).toBe(true);
    });

    it('supports install', () => {
      expect(adapter.capabilities.supportsInstall).toBe(true);
    });

    it('supports MCP', () => {
      expect(adapter.capabilities.supportsMcp).toBe(true);
    });

    it('supports instruction files with AGENTS.md pattern', () => {
      expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
      expect(adapter.capabilities.instructionFilePattern).toBe('AGENTS.md');
    });

    it('declares expected hook events', () => {
      expect(adapter.capabilities.supportedHookEvents).toContain('onSessionStart');
      expect(adapter.capabilities.supportedHookEvents).toContain('onSessionEnd');
      expect(adapter.capabilities.supportedHookEvents).toContain('onToolStart');
      expect(adapter.capabilities.supportedHookEvents).toContain('onToolComplete');
      expect(adapter.capabilities.supportedHookEvents).toContain('onError');
      expect(adapter.capabilities.supportedHookEvents).toContain('onPromptSubmit');
    });

    it('supports 6 hook events', () => {
      expect(adapter.capabilities.supportedHookEvents).toHaveLength(6);
    });
  });

  describe('sub-providers', () => {
    it('provides a hook provider', () => {
      expect(adapter.hooks).toBeInstanceOf(OpenCodeHookProvider);
    });

    it('provides a spawn provider', () => {
      expect(adapter.spawn).toBeInstanceOf(OpenCodeSpawnProvider);
    });

    it('provides an install provider', () => {
      expect(adapter.install).toBeInstanceOf(OpenCodeInstallProvider);
    });
  });

  describe('initialize', () => {
    it('sets initialized state', async () => {
      expect(adapter.isInitialized()).toBe(false);
      await adapter.initialize('/tmp/test-project');
      expect(adapter.isInitialized()).toBe(true);
    });

    it('stores project directory', async () => {
      await adapter.initialize('/tmp/test-project');
      expect(adapter.getProjectDir()).toBe('/tmp/test-project');
    });
  });

  describe('dispose', () => {
    it('resets initialized state', async () => {
      await adapter.initialize('/tmp/test-project');
      await adapter.dispose();
      expect(adapter.isInitialized()).toBe(false);
      expect(adapter.getProjectDir()).toBeNull();
    });
  });

  describe('healthCheck', () => {
    it('returns unhealthy when not initialized', async () => {
      const status = await adapter.healthCheck();
      expect(status.healthy).toBe(false);
      expect(status.provider).toBe('opencode');
      expect(status.details?.error).toBe('Adapter not initialized');
    });

    it('returns health status with provider id', async () => {
      await adapter.initialize('/tmp/test-project');
      const status = await adapter.healthCheck();
      expect(status.provider).toBe('opencode');
      expect(typeof status.healthy).toBe('boolean');
    });
  });
});

describe('OpenCodeHookProvider', () => {
  let hooks: OpenCodeHookProvider;

  beforeEach(() => {
    hooks = new OpenCodeHookProvider();
  });

  describe('mapProviderEvent', () => {
    it('maps session.start to onSessionStart', () => {
      expect(hooks.mapProviderEvent('session.start')).toBe('onSessionStart');
    });

    it('maps session.end to onSessionEnd', () => {
      expect(hooks.mapProviderEvent('session.end')).toBe('onSessionEnd');
    });

    it('maps tool.start to onToolStart', () => {
      expect(hooks.mapProviderEvent('tool.start')).toBe('onToolStart');
    });

    it('maps tool.complete to onToolComplete', () => {
      expect(hooks.mapProviderEvent('tool.complete')).toBe('onToolComplete');
    });

    it('maps error to onError', () => {
      expect(hooks.mapProviderEvent('error')).toBe('onError');
    });

    it('maps prompt.submit to onPromptSubmit', () => {
      expect(hooks.mapProviderEvent('prompt.submit')).toBe('onPromptSubmit');
    });

    it('returns null for unknown events', () => {
      expect(hooks.mapProviderEvent('UnknownEvent')).toBeNull();
      expect(hooks.mapProviderEvent('')).toBeNull();
    });
  });

  describe('registerNativeHooks', () => {
    it('marks hooks as registered', async () => {
      expect(hooks.isRegistered()).toBe(false);
      await hooks.registerNativeHooks('/tmp/project');
      expect(hooks.isRegistered()).toBe(true);
    });
  });

  describe('unregisterNativeHooks', () => {
    it('marks hooks as unregistered', async () => {
      await hooks.registerNativeHooks('/tmp/project');
      await hooks.unregisterNativeHooks();
      expect(hooks.isRegistered()).toBe(false);
    });
  });

  describe('getEventMap', () => {
    it('returns all mapped events', () => {
      const map = hooks.getEventMap();
      expect(Object.keys(map)).toHaveLength(6);
      expect(map['session.start']).toBe('onSessionStart');
      expect(map['session.end']).toBe('onSessionEnd');
      expect(map['tool.start']).toBe('onToolStart');
      expect(map['tool.complete']).toBe('onToolComplete');
      expect(map['error']).toBe('onError');
      expect(map['prompt.submit']).toBe('onPromptSubmit');
    });
  });
});

describe('OpenCodeSpawnProvider', () => {
  let spawn: OpenCodeSpawnProvider;

  beforeEach(() => {
    spawn = new OpenCodeSpawnProvider();
  });

  describe('canSpawn', () => {
    it('returns a boolean', async () => {
      const result = await spawn.canSpawn();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('listRunning', () => {
    it('returns empty array when no processes spawned', async () => {
      const running = await spawn.listRunning();
      expect(running).toEqual([]);
    });
  });

  describe('terminate', () => {
    it('handles non-existent instance gracefully', async () => {
      await expect(spawn.terminate('non-existent')).resolves.toBeUndefined();
    });
  });
});

describe('OpenCodeInstallProvider', () => {
  let installProvider: OpenCodeInstallProvider;

  beforeEach(() => {
    installProvider = new OpenCodeInstallProvider();
  });

  describe('isInstalled', () => {
    it('returns a boolean', async () => {
      const result = await installProvider.isInstalled();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('install', () => {
    it('returns a success result', async () => {
      const result = await installProvider.install({
        projectDir: '/tmp/test-project',
      });
      expect(result.success).toBe(true);
      expect(result.installedAt).toBeTruthy();
      expect(typeof result.instructionFileUpdated).toBe('boolean');
      expect(typeof result.mcpRegistered).toBe('boolean');
    });

    it('registers MCP when mcpServerPath provided', async () => {
      const result = await installProvider.install({
        projectDir: '/tmp/test-project',
        mcpServerPath: '/path/to/mcp-server.js',
      });
      expect(result.mcpRegistered).toBe(true);
    });
  });

  describe('uninstall', () => {
    it('handles uninstall when not installed', async () => {
      await expect(installProvider.uninstall()).resolves.toBeUndefined();
    });
  });
});
