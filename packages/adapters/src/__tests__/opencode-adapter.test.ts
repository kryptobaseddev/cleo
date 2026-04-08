/**
 * Unit tests for @cleocode/adapter-opencode
 *
 * Tests the OpenCodeAdapter, OpenCodeHookProvider,
 * OpenCodeSpawnProvider, and OpenCodeInstallProvider.
 *
 * @task T5240
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createOpenCodeAdapter as createAdapter,
  OpenCodeAdapter,
  OpenCodeHookProvider,
  OpenCodeInstallProvider,
  OpenCodeSpawnProvider,
} from '@cleocode/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
    expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
    expect(adapter.capabilities.instructionFilePattern).toBe('AGENTS.md');
  });

  it('supports 10 hook events (10/16 CAAMP)', () => {
    const events = adapter.capabilities.supportedHookEvents;
    expect(events).toHaveLength(10);
    expect(events).toContain('SessionStart');
    expect(events).toContain('SessionEnd');
    expect(events).toContain('PromptSubmit');
    expect(events).toContain('ResponseComplete');
    expect(events).toContain('PreToolUse');
    expect(events).toContain('PostToolUse');
    expect(events).toContain('PermissionRequest');
    expect(events).toContain('PreModel');
    expect(events).toContain('PreCompact');
    expect(events).toContain('PostCompact');
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

  it('maps experimental.session.compacting to PreCompact', () => {
    expect(hooks.mapProviderEvent('experimental.session.compacting')).toBe('PreCompact');
  });

  it('maps event:session.compacted to PostCompact', () => {
    expect(hooks.mapProviderEvent('event:session.compacted')).toBe('PostCompact');
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

  it('exposes event map with 10 entries', () => {
    const map = hooks.getEventMap();
    expect(Object.keys(map)).toHaveLength(10);
    expect(map['event:session.created']).toBe('SessionStart');
    expect(map['tool.execute.after']).toBe('PostToolUse');
    expect(map['chat.message']).toBe('PromptSubmit');
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

  it('install returns expected shape', async () => {
    const result = await install.install({
      projectDir: testDir,
    });

    expect(result.success).toBe(true);
    expect(result.instructionFileUpdated).toBe(true);
  });

  it('uninstall is a no-op', async () => {
    await expect(install.uninstall()).resolves.toBeUndefined();
  });
});

describe('createAdapter factory', () => {
  it('returns an OpenCodeAdapter instance', () => {
    const adapter = createAdapter();
    expect(adapter).toBeInstanceOf(OpenCodeAdapter);
    expect(adapter.id).toBe('opencode');
  });
});
