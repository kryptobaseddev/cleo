/**
 * Tests for the Cursor adapter package.
 *
 * @task T5240
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CursorAdapter } from '../adapter.js';
import { CursorHookProvider } from '../hooks.js';
import { CursorSpawnProvider } from '../spawn.js'; // spawn.ts still exists for direct use
import { CursorInstallProvider } from '../install.js';
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        existsSync: vi.fn((path) => {
            if (typeof path === 'string' && path.includes('.cursor'))
                return true;
            if (typeof path === 'string' && path.includes('.cursorrules'))
                return false;
            return false;
        }),
        readFileSync: vi.fn((path) => {
            if (typeof path === 'string' && path.includes('mcp.json')) {
                return JSON.stringify({ mcpServers: { cleo: { command: 'node', args: ['mcp.js'] } } });
            }
            return '{}';
        }),
        writeFileSync: vi.fn(),
        mkdirSync: vi.fn(),
    };
});
describe('CursorAdapter', () => {
    let adapter;
    beforeEach(() => {
        adapter = new CursorAdapter();
    });
    afterEach(async () => {
        if (adapter.isInitialized()) {
            await adapter.dispose();
        }
        vi.restoreAllMocks();
    });
    describe('identity', () => {
        it('has correct id', () => {
            expect(adapter.id).toBe('cursor');
        });
        it('has correct name', () => {
            expect(adapter.name).toBe('Cursor');
        });
        it('has correct version', () => {
            expect(adapter.version).toBe('1.0.0');
        });
    });
    describe('capabilities', () => {
        it('does not support hooks', () => {
            expect(adapter.capabilities.supportsHooks).toBe(false);
        });
        it('has no supported hook events', () => {
            expect(adapter.capabilities.supportedHookEvents).toHaveLength(0);
        });
        it('does not support spawn', () => {
            expect(adapter.capabilities.supportsSpawn).toBe(false);
        });
        it('supports install', () => {
            expect(adapter.capabilities.supportsInstall).toBe(true);
        });
        it('supports MCP', () => {
            expect(adapter.capabilities.supportsMcp).toBe(true);
        });
        it('supports instruction files with MDC pattern', () => {
            expect(adapter.capabilities.supportsInstructionFiles).toBe(true);
            expect(adapter.capabilities.instructionFilePattern).toBe('.cursor/rules/*.mdc');
        });
    });
    describe('sub-providers', () => {
        it('provides a hook provider (stub)', () => {
            expect(adapter.hooks).toBeInstanceOf(CursorHookProvider);
        });
        it('provides an install provider', () => {
            expect(adapter.install).toBeInstanceOf(CursorInstallProvider);
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
            expect(status.provider).toBe('cursor');
            expect(status.details?.error).toBe('Adapter not initialized');
        });
        it('returns health status with provider id', async () => {
            await adapter.initialize('/tmp/test-project');
            const status = await adapter.healthCheck();
            expect(status.provider).toBe('cursor');
            expect(typeof status.healthy).toBe('boolean');
        });
        it('checks for .cursor directory existence', async () => {
            await adapter.initialize('/tmp/test-project');
            const status = await adapter.healthCheck();
            expect(status.details?.configDirExists).toBeDefined();
        });
        it('checks for CURSOR_EDITOR env var', async () => {
            await adapter.initialize('/tmp/test-project');
            const status = await adapter.healthCheck();
            expect(status.details?.editorEnvSet).toBeDefined();
        });
    });
});
describe('CursorHookProvider', () => {
    let hooks;
    beforeEach(() => {
        hooks = new CursorHookProvider();
    });
    describe('mapProviderEvent', () => {
        it('returns null for any event (no hook support)', () => {
            expect(hooks.mapProviderEvent('session.start')).toBeNull();
            expect(hooks.mapProviderEvent('tool.complete')).toBeNull();
            expect(hooks.mapProviderEvent('any-event')).toBeNull();
            expect(hooks.mapProviderEvent('')).toBeNull();
        });
    });
    describe('registerNativeHooks', () => {
        it('completes without error and marks as registered', async () => {
            expect(hooks.isRegistered()).toBe(false);
            await hooks.registerNativeHooks('/tmp/project');
            expect(hooks.isRegistered()).toBe(true);
        });
    });
    describe('unregisterNativeHooks', () => {
        it('completes without error and marks as unregistered', async () => {
            await hooks.registerNativeHooks('/tmp/project');
            await hooks.unregisterNativeHooks();
            expect(hooks.isRegistered()).toBe(false);
        });
    });
});
describe('CursorSpawnProvider', () => {
    let spawnProvider;
    beforeEach(() => {
        spawnProvider = new CursorSpawnProvider();
    });
    describe('canSpawn', () => {
        it('returns false (spawn not supported)', async () => {
            const result = await spawnProvider.canSpawn();
            expect(result).toBe(false);
        });
    });
    describe('spawn', () => {
        it('throws an error explaining spawn is not supported', async () => {
            await expect(spawnProvider.spawn({
                taskId: 'T1234',
                prompt: 'test prompt',
            })).rejects.toThrow('Cursor does not support subagent spawning');
        });
    });
    describe('listRunning', () => {
        it('returns empty array', async () => {
            const running = await spawnProvider.listRunning();
            expect(running).toEqual([]);
        });
    });
    describe('terminate', () => {
        it('handles any instance id gracefully (no-op)', async () => {
            await expect(spawnProvider.terminate('any-id')).resolves.toBeUndefined();
        });
    });
});
describe('CursorInstallProvider', () => {
    let installProvider;
    beforeEach(() => {
        installProvider = new CursorInstallProvider();
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
        it('includes instruction files in details', async () => {
            const result = await installProvider.install({
                projectDir: '/tmp/test-project',
            });
            const files = result.details?.instructionFiles;
            expect(Array.isArray(files)).toBe(true);
            expect(files.some((f) => f.includes('cleo.mdc'))).toBe(true);
        });
    });
    describe('uninstall', () => {
        it('handles uninstall when not installed', async () => {
            await expect(installProvider.uninstall()).resolves.toBeUndefined();
        });
    });
    describe('ensureInstructionReferences', () => {
        it('completes without error', async () => {
            await expect(installProvider.ensureInstructionReferences('/tmp/test-project')).resolves.toBeUndefined();
        });
    });
});
describe('barrel exports', () => {
    it('exports createAdapter factory function', async () => {
        const module = await import('../index.js');
        expect(typeof module.createAdapter).toBe('function');
        const adapter = module.createAdapter();
        expect(adapter).toBeInstanceOf(CursorAdapter);
    });
    it('exports CursorAdapter as default', async () => {
        const module = await import('../index.js');
        expect(module.default).toBe(CursorAdapter);
    });
});
//# sourceMappingURL=adapter.test.js.map