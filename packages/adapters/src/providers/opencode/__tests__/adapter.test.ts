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

    it('does not support MCP (removed)', () => {
      expect(adapter.capabilities.supportsMcp).toBe(false);
    });

    it('supports instruction files with AGENTS.md pattern', () => {
      expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
      expect(adapter.capabilities.instructionFilePattern).toBe('AGENTS.md');
    });

    it('declares expected hook events (10 CAAMP canonical events)', () => {
      expect(adapter.capabilities.supportedHookEvents).toContain('SessionStart');
      expect(adapter.capabilities.supportedHookEvents).toContain('SessionEnd');
      expect(adapter.capabilities.supportedHookEvents).toContain('PromptSubmit');
      expect(adapter.capabilities.supportedHookEvents).toContain('ResponseComplete');
      expect(adapter.capabilities.supportedHookEvents).toContain('PreToolUse');
      expect(adapter.capabilities.supportedHookEvents).toContain('PostToolUse');
      expect(adapter.capabilities.supportedHookEvents).toContain('PermissionRequest');
      expect(adapter.capabilities.supportedHookEvents).toContain('PreModel');
      expect(adapter.capabilities.supportedHookEvents).toContain('PreCompact');
      expect(adapter.capabilities.supportedHookEvents).toContain('PostCompact');
    });

    it('supports 10 hook events', () => {
      expect(adapter.capabilities.supportedHookEvents).toHaveLength(10);
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
    it('maps event:session.created to SessionStart', () => {
      expect(hooks.mapProviderEvent('event:session.created')).toBe('SessionStart');
    });

    it('maps event:session.deleted to SessionEnd', () => {
      expect(hooks.mapProviderEvent('event:session.deleted')).toBe('SessionEnd');
    });

    it('maps chat.message to PromptSubmit', () => {
      expect(hooks.mapProviderEvent('chat.message')).toBe('PromptSubmit');
    });

    it('maps event:session.idle to ResponseComplete', () => {
      expect(hooks.mapProviderEvent('event:session.idle')).toBe('ResponseComplete');
    });

    it('maps tool.execute.before to PreToolUse', () => {
      expect(hooks.mapProviderEvent('tool.execute.before')).toBe('PreToolUse');
    });

    it('maps tool.execute.after to PostToolUse', () => {
      expect(hooks.mapProviderEvent('tool.execute.after')).toBe('PostToolUse');
    });

    it('maps permission.ask to PermissionRequest', () => {
      expect(hooks.mapProviderEvent('permission.ask')).toBe('PermissionRequest');
    });

    it('maps chat.params to PreModel', () => {
      expect(hooks.mapProviderEvent('chat.params')).toBe('PreModel');
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
    it('returns all 10 mapped events', () => {
      const map = hooks.getEventMap();
      expect(Object.keys(map)).toHaveLength(10);
      expect(map['event:session.created']).toBe('SessionStart');
      expect(map['event:session.deleted']).toBe('SessionEnd');
      expect(map['chat.message']).toBe('PromptSubmit');
      expect(map['event:session.idle']).toBe('ResponseComplete');
      expect(map['tool.execute.before']).toBe('PreToolUse');
      expect(map['tool.execute.after']).toBe('PostToolUse');
      expect(map['permission.ask']).toBe('PermissionRequest');
      expect(map['chat.params']).toBe('PreModel');
      expect(map['experimental.session.compacting']).toBe('PreCompact');
      expect(map['event:session.compacted']).toBe('PostCompact');
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

    it('does not register MCP even when mcpServerPath provided', async () => {
      const result = await installProvider.install({
        projectDir: '/tmp/test-project',
        mcpServerPath: '/path/to/mcp-server.js',
      });
      expect(result.mcpRegistered).toBe(false);
    });
  });

  describe('uninstall', () => {
    it('handles uninstall when not installed', async () => {
      await expect(installProvider.uninstall()).resolves.toBeUndefined();
    });
  });
});
