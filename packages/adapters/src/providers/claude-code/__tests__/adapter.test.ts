/**
 * Tests for the Claude Code adapter package.
 *
 * @task T5240
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../adapter.js';
import { ClaudeCodeHookProvider } from '../hooks.js';
import { ClaudeCodeInstallProvider } from '../install.js';
import { ClaudeCodeSpawnProvider } from '../spawn.js';

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
    promisify: (fn: unknown) => {
      // Return a mock for exec that simulates 'which claude' succeeding
      return vi.fn().mockResolvedValue({ stdout: '/usr/local/bin/claude', stderr: '' });
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (typeof path === 'string' && path.includes('.claude')) return true;
      if (typeof path === 'string' && path.includes('.mcp.json')) return false;
      if (typeof path === 'string' && path.includes('CLAUDE.md')) return false;
      return false;
    }),
    readFileSync: vi.fn(() => '{}'),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

describe('ClaudeCodeAdapter', () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
  });

  afterEach(async () => {
    if (adapter.isInitialized()) {
      await adapter.dispose();
    }
    vi.restoreAllMocks();
  });

  describe('identity', () => {
    it('has correct id', () => {
      expect(adapter.id).toBe('claude-code');
    });

    it('has correct name', () => {
      expect(adapter.name).toBe('Claude Code');
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

    it('supports instruction files with CLAUDE.md pattern', () => {
      expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
      expect(adapter.capabilities.instructionFilePattern).toBe('CLAUDE.md');
    });

    it('declares expected hook events (14 CAAMP canonical events)', () => {
      expect(adapter.capabilities.supportedHookEvents).toContain('SessionStart');
      expect(adapter.capabilities.supportedHookEvents).toContain('SessionEnd');
      expect(adapter.capabilities.supportedHookEvents).toContain('PromptSubmit');
      expect(adapter.capabilities.supportedHookEvents).toContain('ResponseComplete');
      expect(adapter.capabilities.supportedHookEvents).toContain('PreToolUse');
      expect(adapter.capabilities.supportedHookEvents).toContain('PostToolUse');
      expect(adapter.capabilities.supportedHookEvents).toContain('PostToolUseFailure');
      expect(adapter.capabilities.supportedHookEvents).toContain('PermissionRequest');
      expect(adapter.capabilities.supportedHookEvents).toContain('SubagentStart');
      expect(adapter.capabilities.supportedHookEvents).toContain('SubagentStop');
      expect(adapter.capabilities.supportedHookEvents).toContain('PreCompact');
      expect(adapter.capabilities.supportedHookEvents).toContain('PostCompact');
      expect(adapter.capabilities.supportedHookEvents).toContain('Notification');
      expect(adapter.capabilities.supportedHookEvents).toContain('ConfigChange');
      expect(adapter.capabilities.supportedHookEvents).toHaveLength(14);
    });
  });

  describe('sub-providers', () => {
    it('provides a hook provider', () => {
      expect(adapter.hooks).toBeInstanceOf(ClaudeCodeHookProvider);
    });

    it('provides a spawn provider', () => {
      expect(adapter.spawn).toBeInstanceOf(ClaudeCodeSpawnProvider);
    });

    it('provides an install provider', () => {
      expect(adapter.install).toBeInstanceOf(ClaudeCodeInstallProvider);
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
      expect(status.provider).toBe('claude-code');
      expect(status.details?.error).toBe('Adapter not initialized');
    });

    it('returns health status with provider id', async () => {
      await adapter.initialize('/tmp/test-project');
      const status = await adapter.healthCheck();
      expect(status.provider).toBe('claude-code');
      expect(typeof status.healthy).toBe('boolean');
    });
  });
});

describe('ClaudeCodeHookProvider', () => {
  let hooks: ClaudeCodeHookProvider;

  beforeEach(() => {
    hooks = new ClaudeCodeHookProvider();
  });

  describe('mapProviderEvent', () => {
    it('maps SessionStart to SessionStart (identity)', () => {
      expect(hooks.mapProviderEvent('SessionStart')).toBe('SessionStart');
    });

    it('maps PostToolUse to PostToolUse (identity)', () => {
      expect(hooks.mapProviderEvent('PostToolUse')).toBe('PostToolUse');
    });

    it('maps UserPromptSubmit to PromptSubmit', () => {
      expect(hooks.mapProviderEvent('UserPromptSubmit')).toBe('PromptSubmit');
    });

    it('maps Stop to ResponseComplete', () => {
      expect(hooks.mapProviderEvent('Stop')).toBe('ResponseComplete');
    });

    it('maps PreToolUse to PreToolUse (identity)', () => {
      expect(hooks.mapProviderEvent('PreToolUse')).toBe('PreToolUse');
    });

    it('maps PermissionRequest to PermissionRequest (identity)', () => {
      expect(hooks.mapProviderEvent('PermissionRequest')).toBe('PermissionRequest');
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
    it('returns all 14 mapped events', () => {
      const map = hooks.getEventMap();
      expect(Object.keys(map)).toHaveLength(14);
      expect(map.SessionStart).toBe('SessionStart');
      expect(map.SessionEnd).toBe('SessionEnd');
      expect(map.UserPromptSubmit).toBe('PromptSubmit');
      expect(map.Stop).toBe('ResponseComplete');
      expect(map.PreToolUse).toBe('PreToolUse');
      expect(map.PostToolUse).toBe('PostToolUse');
      expect(map.PostToolUseFailure).toBe('PostToolUseFailure');
      expect(map.PermissionRequest).toBe('PermissionRequest');
      expect(map.SubagentStart).toBe('SubagentStart');
      expect(map.SubagentStop).toBe('SubagentStop');
      expect(map.PreCompact).toBe('PreCompact');
      expect(map.PostCompact).toBe('PostCompact');
      expect(map.Notification).toBe('Notification');
      expect(map.ConfigChange).toBe('ConfigChange');
    });
  });
});

describe('ClaudeCodeSpawnProvider', () => {
  let spawn: ClaudeCodeSpawnProvider;

  beforeEach(() => {
    spawn = new ClaudeCodeSpawnProvider();
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

describe('ClaudeCodeInstallProvider', () => {
  let installProvider: ClaudeCodeInstallProvider;

  beforeEach(() => {
    installProvider = new ClaudeCodeInstallProvider();
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
