/**
 * Unit tests for @cleocode/adapter-opencode
 *
 * Tests the OpenCodeAdapter, OpenCodeHookProvider,
 * OpenCodeSpawnProvider, and OpenCodeInstallProvider.
 *
 * @task T5240
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OpenCodeAdapter,
  OpenCodeHookProvider,
  OpenCodeSpawnProvider,
  OpenCodeInstallProvider,
  createAdapter,
} from '@cleocode/adapter-opencode';

describe('OpenCodeAdapter', () => {
  let adapter: OpenCodeAdapter;

  beforeEach(() => {
    adapter = new OpenCodeAdapter();
  });

  it('has correct identity fields', () => {
    expect(adapter.id).toBe('opencode');
    expect(adapter.name).toBe('OpenCode');
    expect(adapter.version).toBe('1.0.0');
  });

  it('has correct capabilities', () => {
    expect(adapter.capabilities.supportsHooks).toBe(true);
    expect(adapter.capabilities.supportsSpawn).toBe(true);
    expect(adapter.capabilities.supportsInstall).toBe(true);
    expect(adapter.capabilities.supportsMcp).toBe(true);
    expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
    expect(adapter.capabilities.instructionFilePattern).toBe('AGENTS.md');
  });

  it('supports 6 hook events (6/8 CAAMP)', () => {
    const events = adapter.capabilities.supportedHookEvents;
    expect(events).toHaveLength(6);
    expect(events).toContain('onSessionStart');
    expect(events).toContain('onSessionEnd');
    expect(events).toContain('onToolStart');
    expect(events).toContain('onToolComplete');
    expect(events).toContain('onError');
    expect(events).toContain('onPromptSubmit');
  });

  it('exposes hooks, spawn, and install providers', () => {
    expect(adapter.hooks).toBeInstanceOf(OpenCodeHookProvider);
    expect(adapter.spawn).toBeInstanceOf(OpenCodeSpawnProvider);
    expect(adapter.install).toBeInstanceOf(OpenCodeInstallProvider);
  });

  it('tracks initialization state', async () => {
    expect(adapter.isInitialized()).toBe(false);
    await adapter.initialize('/tmp/test-project');
    expect(adapter.isInitialized()).toBe(true);
    expect(adapter.getProjectDir()).toBe('/tmp/test-project');
  });

  it('clears state on dispose', async () => {
    await adapter.initialize('/tmp/test-project');
    await adapter.dispose();
    expect(adapter.isInitialized()).toBe(false);
    expect(adapter.getProjectDir()).toBeNull();
  });

  it('reports unhealthy when not initialized', async () => {
    const health = await adapter.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.provider).toBe('opencode');
    expect(health.details?.error).toBe('Adapter not initialized');
  });

  it('reports health after initialization', async () => {
    await adapter.initialize('/tmp/test-project');
    const health = await adapter.healthCheck();
    expect(health.provider).toBe('opencode');
    expect(typeof health.healthy).toBe('boolean');
  });
});

describe('OpenCodeHookProvider', () => {
  let hooks: OpenCodeHookProvider;

  beforeEach(() => {
    hooks = new OpenCodeHookProvider();
  });

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

  it('tracks registration state', async () => {
    expect(hooks.isRegistered()).toBe(false);
    await hooks.registerNativeHooks('/tmp/test');
    expect(hooks.isRegistered()).toBe(true);
    await hooks.unregisterNativeHooks();
    expect(hooks.isRegistered()).toBe(false);
  });

  it('exposes event map with 6 entries', () => {
    const map = hooks.getEventMap();
    expect(Object.keys(map)).toHaveLength(6);
    expect(map['session.start']).toBe('onSessionStart');
    expect(map['tool.complete']).toBe('onToolComplete');
    expect(map['prompt.submit']).toBe('onPromptSubmit');
  });
});

describe('OpenCodeSpawnProvider', () => {
  let spawn: OpenCodeSpawnProvider;

  beforeEach(() => {
    spawn = new OpenCodeSpawnProvider();
  });

  it('canSpawn returns boolean', async () => {
    const result = await spawn.canSpawn();
    expect(typeof result).toBe('boolean');
  });

  it('listRunning returns empty array initially', async () => {
    const running = await spawn.listRunning();
    expect(running).toEqual([]);
  });

  it('terminate is no-op for unknown instance', async () => {
    await expect(spawn.terminate('nonexistent')).resolves.toBeUndefined();
  });
});

describe('OpenCodeInstallProvider', () => {
  let install: OpenCodeInstallProvider;
  let testDir: string;

  beforeEach(() => {
    install = new OpenCodeInstallProvider();
    testDir = join(tmpdir(), `cleo-opencode-test-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('creates AGENTS.md with @-references', async () => {
    await install.ensureInstructionReferences(testDir);
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
    expect(content).toContain('@.cleo/memory-bridge.md');
  });

  it('appends missing references to existing AGENTS.md', async () => {
    const existing = '# Project Agents\n\nSome content.\n';
    writeFileSync(join(testDir, 'AGENTS.md'), existing, 'utf-8');

    await install.ensureInstructionReferences(testDir);
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# Project Agents');
    expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
    expect(content).toContain('@.cleo/memory-bridge.md');
  });

  it('does not duplicate existing references', async () => {
    const existing = '@~/.cleo/templates/CLEO-INJECTION.md\n@.cleo/memory-bridge.md\n';
    writeFileSync(join(testDir, 'AGENTS.md'), existing, 'utf-8');

    await install.ensureInstructionReferences(testDir);
    const content = readFileSync(join(testDir, 'AGENTS.md'), 'utf-8');
    const injectionCount = content.split('@~/.cleo/templates/CLEO-INJECTION.md').length - 1;
    expect(injectionCount).toBe(1);
  });

  it('registers MCP server in .opencode/config.json', async () => {
    const result = await install.install({
      projectDir: testDir,
      mcpServerPath: '/path/to/cleo-mcp.js',
    });

    expect(result.success).toBe(true);
    expect(result.mcpRegistered).toBe(true);
    expect(result.instructionFileUpdated).toBe(true);

    const configPath = join(testDir, '.opencode', 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.cleo).toEqual({
      command: 'node',
      args: ['/path/to/cleo-mcp.js'],
    });
  });

  it('uninstall removes MCP server from .opencode/config.json', async () => {
    await install.install({
      projectDir: testDir,
      mcpServerPath: '/path/to/cleo-mcp.js',
    });

    await install.uninstall();

    const configPath = join(testDir, '.opencode', 'config.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(config.mcpServers.cleo).toBeUndefined();
  });
});

describe('createAdapter factory', () => {
  it('returns an OpenCodeAdapter instance', () => {
    const adapter = createAdapter();
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
    expect(adapter.id).toBe('opencode');
  });
});
