/**
 * Unit tests for @cleocode/adapter-cursor
 *
 * Tests the CursorAdapter, CursorHookProvider, and CursorInstallProvider.
 * Cursor has no spawn support, so no spawn provider tests.
 *
 * @task T5240
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CursorAdapter, CursorHookProvider, CursorInstallProvider, createCursorAdapter as createAdapter, } from '@cleocode/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
describe('CursorAdapter', () => {
    let adapter;
    beforeEach(() => {
        adapter = new CursorAdapter();
    });
    it('has correct identity fields', () => {
        expect(adapter.id).toBe('cursor');
        expect(adapter.name).toBe('Cursor');
        expect(adapter.version).toBe('1.0.0');
    });
    it('does not support hooks', () => {
        expect(adapter.capabilities.supportsHooks).toBe(false);
        expect(adapter.capabilities.supportedHookEvents).toHaveLength(0);
    });
    it('does not support spawn', () => {
        expect(adapter.capabilities.supportsSpawn).toBe(false);
    });
    it('supports install, MCP, and instruction files', () => {
        expect(adapter.capabilities.supportsInstall).toBe(true);
        expect(adapter.capabilities.supportsMcp).toBe(true);
        expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
        expect(adapter.capabilities.instructionFilePattern).toBe('.cursor/rules/*.mdc');
    });
    it('has no spawn provider', () => {
        expect(adapter.spawn).toBeUndefined();
    });
    it('exposes hooks and install providers', () => {
        expect(adapter.hooks).toBeInstanceOf(CursorHookProvider);
        expect(adapter.install).toBeInstanceOf(CursorInstallProvider);
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
        expect(health.provider).toBe('cursor');
        expect(health.details?.error).toBe('Adapter not initialized');
    });
    it('reports health based on .cursor/ presence', async () => {
        const testDir = join(tmpdir(), `cursor-health-${Date.now()}`);
        mkdirSync(join(testDir, '.cursor'), { recursive: true });
        try {
            await adapter.initialize(testDir);
            const health = await adapter.healthCheck();
            expect(health.provider).toBe('cursor');
            expect(health.details?.configDirExists).toBe(true);
        }
        finally {
            rmSync(testDir, { recursive: true, force: true });
        }
    });
});
describe('CursorHookProvider', () => {
    let hooks;
    beforeEach(() => {
        hooks = new CursorHookProvider();
    });
    it('returns null for all events (no hook support)', () => {
        expect(hooks.mapProviderEvent('SessionStart')).toBeNull();
        expect(hooks.mapProviderEvent('PostToolUse')).toBeNull();
        expect(hooks.mapProviderEvent('Stop')).toBeNull();
        expect(hooks.mapProviderEvent('')).toBeNull();
        expect(hooks.mapProviderEvent('anything')).toBeNull();
    });
    it('tracks registration state', async () => {
        expect(hooks.isRegistered()).toBe(false);
        await hooks.registerNativeHooks('/tmp/test');
        expect(hooks.isRegistered()).toBe(true);
        await hooks.unregisterNativeHooks();
        expect(hooks.isRegistered()).toBe(false);
    });
});
describe('CursorInstallProvider', () => {
    let install;
    let testDir;
    beforeEach(() => {
        install = new CursorInstallProvider();
        testDir = join(tmpdir(), `cleo-cursor-test-${Date.now()}`);
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
    it('creates .cursor/rules/cleo.mdc with @-references', async () => {
        await install.ensureInstructionReferences(testDir);
        const mdcPath = join(testDir, '.cursor', 'rules', 'cleo.mdc');
        expect(existsSync(mdcPath)).toBe(true);
        const content = readFileSync(mdcPath, 'utf-8');
        expect(content).toContain('alwaysApply: true');
        expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
        expect(content).toContain('@.cleo/memory-bridge.md');
    });
    it('uses MDC frontmatter format', async () => {
        await install.ensureInstructionReferences(testDir);
        const mdcPath = join(testDir, '.cursor', 'rules', 'cleo.mdc');
        const content = readFileSync(mdcPath, 'utf-8');
        expect(content).toMatch(/^---\n/);
        expect(content).toContain('description: CLEO task management protocol references');
        expect(content).toContain('globs: "**/*"');
    });
    it('is idempotent for modern rules', async () => {
        await install.ensureInstructionReferences(testDir);
        const mdcPath = join(testDir, '.cursor', 'rules', 'cleo.mdc');
        const first = readFileSync(mdcPath, 'utf-8');
        await install.ensureInstructionReferences(testDir);
        const second = readFileSync(mdcPath, 'utf-8');
        expect(first).toBe(second);
    });
    it('appends to legacy .cursorrules if it exists', async () => {
        const legacyPath = join(testDir, '.cursorrules');
        writeFileSync(legacyPath, '# Project Rules\nUse TypeScript.\n', 'utf-8');
        await install.ensureInstructionReferences(testDir);
        const content = readFileSync(legacyPath, 'utf-8');
        expect(content).toContain('# Project Rules');
        expect(content).toContain('Use TypeScript.');
        expect(content).toContain('@~/.cleo/templates/CLEO-INJECTION.md');
        expect(content).toContain('@.cleo/memory-bridge.md');
    });
    it('does not create legacy .cursorrules if it does not exist', async () => {
        await install.ensureInstructionReferences(testDir);
        expect(existsSync(join(testDir, '.cursorrules'))).toBe(false);
    });
    it('does not duplicate references in legacy .cursorrules', async () => {
        const legacyPath = join(testDir, '.cursorrules');
        writeFileSync(legacyPath, '@~/.cleo/templates/CLEO-INJECTION.md\n@.cleo/memory-bridge.md\n', 'utf-8');
        await install.ensureInstructionReferences(testDir);
        const content = readFileSync(legacyPath, 'utf-8');
        const injectionCount = content.split('@~/.cleo/templates/CLEO-INJECTION.md').length - 1;
        expect(injectionCount).toBe(1);
    });
    it('registers MCP server in .cursor/mcp.json', async () => {
        const result = await install.install({
            projectDir: testDir,
            mcpServerPath: '/path/to/cleo-mcp.js',
        });
        expect(result.success).toBe(true);
        expect(result.mcpRegistered).toBe(true);
        expect(result.instructionFileUpdated).toBe(true);
        const mcpPath = join(testDir, '.cursor', 'mcp.json');
        expect(existsSync(mcpPath)).toBe(true);
        const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        expect(config.mcpServers.cleo).toEqual({
            command: 'node',
            args: ['/path/to/cleo-mcp.js'],
        });
    });
    it('uninstall removes MCP server from .cursor/mcp.json', async () => {
        await install.install({
            projectDir: testDir,
            mcpServerPath: '/path/to/cleo-mcp.js',
        });
        await install.uninstall();
        const mcpPath = join(testDir, '.cursor', 'mcp.json');
        const config = JSON.parse(readFileSync(mcpPath, 'utf-8'));
        expect(config.mcpServers.cleo).toBeUndefined();
    });
    it('uninstall is no-op when not installed', async () => {
        await expect(install.uninstall()).resolves.toBeUndefined();
    });
});
describe('createAdapter factory', () => {
    it('returns a CursorAdapter instance', () => {
        const adapter = createAdapter();
        expect(adapter).toBeInstanceOf(CursorAdapter);
        expect(adapter.id).toBe('cursor');
    });
});
//# sourceMappingURL=cursor-adapter.test.js.map