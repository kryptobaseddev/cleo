/**
 * Unit tests for @cleocode/adapter-claude-code
 *
 * Tests the ClaudeCodeAdapter, ClaudeCodeHookProvider,
 * ClaudeCodeSpawnProvider, and ClaudeCodeInstallProvider.
 *
 * @task T5240
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter, ClaudeCodeHookProvider, ClaudeCodeInstallProvider, ClaudeCodeSpawnProvider, createClaudeCodeAdapter as createAdapter, } from '@cleocode/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
describe('ClaudeCodeAdapter', () => {
    let adapter;
    beforeEach(() => {
        adapter = new ClaudeCodeAdapter();
    });
    it('has correct identity fields', () => {
        expect(adapter.id).toBe('claude-code');
        expect(adapter.name).toBe('Claude Code');
        expect(adapter.version).toBe('1.0.0');
    });
    it('has correct capabilities', () => {
        expect(adapter.capabilities.supportsHooks).toBe(true);
        expect(adapter.capabilities.supportsSpawn).toBe(true);
        expect(adapter.capabilities.supportsInstall).toBe(true);
        expect(adapter.capabilities.supportsMcp).toBe(true);
        expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
        expect(adapter.capabilities.instructionFilePattern).toBe('CLAUDE.md');
        expect(adapter.capabilities.supportedHookEvents).toContain('onSessionStart');
        expect(adapter.capabilities.supportedHookEvents).toContain('onSessionEnd');
        expect(adapter.capabilities.supportedHookEvents).toContain('onToolComplete');
    });
    it('exposes hooks, spawn, and install providers', () => {
        expect(adapter.hooks).toBeInstanceOf(ClaudeCodeHookProvider);
        expect(adapter.spawn).toBeInstanceOf(ClaudeCodeSpawnProvider);
        expect(adapter.install).toBeInstanceOf(ClaudeCodeInstallProvider);
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
        expect(health.provider).toBe('claude-code');
        expect(health.details?.error).toBe('Adapter not initialized');
    });
    it('reports health after initialization', async () => {
        await adapter.initialize('/tmp/test-project');
        const health = await adapter.healthCheck();
        expect(health.provider).toBe('claude-code');
        // healthy depends on whether `claude` CLI is available in the test env
        expect(typeof health.healthy).toBe('boolean');
    });
});
describe('ClaudeCodeHookProvider', () => {
    let hooks;
    beforeEach(() => {
        hooks = new ClaudeCodeHookProvider();
    });
    it('maps SessionStart to onSessionStart', () => {
        expect(hooks.mapProviderEvent('SessionStart')).toBe('onSessionStart');
    });
    it('maps PostToolUse to onToolComplete', () => {
        expect(hooks.mapProviderEvent('PostToolUse')).toBe('onToolComplete');
    });
    it('maps UserPromptSubmit to onPromptSubmit', () => {
        expect(hooks.mapProviderEvent('UserPromptSubmit')).toBe('onPromptSubmit');
    });
    it('maps Stop to onSessionEnd', () => {
        expect(hooks.mapProviderEvent('Stop')).toBe('onSessionEnd');
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
    it('exposes event map for introspection', () => {
        const map = hooks.getEventMap();
        expect(map).toHaveProperty('SessionStart', 'onSessionStart');
        expect(map).toHaveProperty('PostToolUse', 'onToolComplete');
        expect(map).toHaveProperty('UserPromptSubmit', 'onPromptSubmit');
        expect(map).toHaveProperty('Stop', 'onSessionEnd');
        expect(Object.keys(map)).toHaveLength(4);
    });
});
describe('ClaudeCodeSpawnProvider', () => {
    let spawn;
    beforeEach(() => {
        spawn = new ClaudeCodeSpawnProvider();
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
describe('ClaudeCodeInstallProvider', () => {
    let install;
    let testDir;
    beforeEach(() => {
        install = new ClaudeCodeInstallProvider();
        testDir = join(tmpdir(), `cleo-adapter-test-${Date.now()}`);
        mkdirSync(testDir, { recursive: true });
    });
    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true, force: true });
        }
        catch {
            // cleanup best-effort
        }
    });
    it('creates CLAUDE.md with @-references', async () => {
        await install.ensureInstructionReferences(testDir);
        const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
        expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
        expect(content).toContain('@.cleo/memory-bridge.md');
    });
    it('appends missing references to existing CLAUDE.md', async () => {
        const existing = '# Project\n@AGENTS.md\n';
        writeFileSync(join(testDir, 'CLAUDE.md'), existing, 'utf-8');
        await install.ensureInstructionReferences(testDir);
        const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
        expect(content).toContain('# Project');
        expect(content).toContain('@AGENTS.md');
        expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
        expect(content).toContain('@.cleo/memory-bridge.md');
    });
    it('does not duplicate existing references', async () => {
        const existing = '@~/.cleo/templates/CLEO-INJECTION.md\n@.cleo/memory-bridge.md\n';
        writeFileSync(join(testDir, 'CLAUDE.md'), existing, 'utf-8');
        await install.ensureInstructionReferences(testDir);
        const content = readFileSync(join(testDir, 'CLAUDE.md'), 'utf-8');
        // Should not have duplicated lines
        const injectionCount = content.split('@~/.cleo/templates/CLEO-INJECTION.md').length - 1;
        expect(injectionCount).toBe(1);
    });
    it('registers MCP server in .mcp.json', async () => {
        const result = await install.install({
            projectDir: testDir,
            mcpServerPath: '/path/to/cleo-mcp.js',
        });
        expect(result.success).toBe(true);
        expect(result.mcpRegistered).toBe(true);
        expect(result.instructionFileUpdated).toBe(true);
        const mcpConfig = JSON.parse(readFileSync(join(testDir, '.mcp.json'), 'utf-8'));
        expect(mcpConfig.mcpServers.cleo).toEqual({
            command: 'node',
            args: ['/path/to/cleo-mcp.js'],
        });
    });
    it('uninstall removes MCP server from .mcp.json', async () => {
        await install.install({
            projectDir: testDir,
            mcpServerPath: '/path/to/cleo-mcp.js',
        });
        await install.uninstall();
        const mcpConfig = JSON.parse(readFileSync(join(testDir, '.mcp.json'), 'utf-8'));
        expect(mcpConfig.mcpServers.cleo).toBeUndefined();
    });
});
describe('createAdapter factory', () => {
    it('returns a ClaudeCodeAdapter instance', () => {
        const adapter = createAdapter();
        expect(adapter).toBeInstanceOf(ClaudeCodeAdapter);
        expect(adapter.id).toBe('claude-code');
    });
});
//# sourceMappingURL=claude-code-adapter.test.js.map