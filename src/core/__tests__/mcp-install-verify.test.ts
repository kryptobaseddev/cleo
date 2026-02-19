/**
 * T4695: Verify CLEO MCP server auto-installed to detected providers.
 *
 * Tests that the mcp-install command and init code correctly:
 * 1. Uses CAAMP adapter for provider detection
 * 2. Generates correct MCP server entries based on env mode
 * 3. The CAAMP adapter properly wraps all CAAMP operations
 *
 * @task T4695
 * @epic T4663
 */

import { describe, it, expect } from 'vitest';
import { detectEnvMode, generateMcpServerEntry } from '../mcp/index.js';
import {
  providerList,
  providerCount,
  providerDetect,
  providerInstalled,
  registryVersion,
  mcpConfigPath,
  providerGet,
  caampResolveAlias,
} from '../caamp/index.js';

describe('MCP server auto-install verification (T4695)', () => {
  describe('Environment detection', () => {
    it('detectEnvMode returns a valid mode', () => {
      const env = detectEnvMode();
      expect(['dev-ts', 'prod-npm', 'unknown']).toContain(env.mode);
      expect(env).toHaveProperty('source');
    });

    it('dev-ts mode generates node command with dist/mcp/index.js', () => {
      const entry = generateMcpServerEntry({ mode: 'dev-ts', source: '/test/project' });
      expect(entry.command).toBe('node');
      expect((entry.args as string[])![0]).toContain('dist/mcp/index.js');
    });

    it('prod-npm mode generates cleo-mcp command', () => {
      const entry = generateMcpServerEntry({ mode: 'prod-npm', source: null });
      expect(entry.command).toBe('cleo-mcp');
      expect(entry.args).toEqual([]);
    });

    it('unknown mode falls back to cleo-mcp', () => {
      const entry = generateMcpServerEntry({ mode: 'unknown', source: null });
      expect(entry.command).toBe('cleo-mcp');
    });
  });

  describe('CAAMP adapter provider operations', () => {
    it('providerList returns success with providers array', () => {
      const result = providerList();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(result.data!.length).toBeGreaterThan(0);
    });

    it('providerCount returns success with count', () => {
      const result = providerCount();
      expect(result.success).toBe(true);
      expect(result.data!.count).toBeGreaterThan(0);
    });

    it('providerDetect returns success with detection results', () => {
      const result = providerDetect();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('providerInstalled returns success with installed providers', () => {
      const result = providerInstalled();
      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('registryVersion returns a valid version string', () => {
      const result = registryVersion();
      expect(result.success).toBe(true);
      expect(typeof result.data!.version).toBe('string');
      expect(result.data!.version.length).toBeGreaterThan(0);
    });

    it('providerGet returns data for known provider', () => {
      // claude-code is always in the registry
      const result = providerGet('claude-code');
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.data!.id).toBe('claude-code');
    });

    it('providerGet returns error for unknown provider', () => {
      const result = providerGet('nonexistent-provider-xyz');
      expect(result.success).toBe(false);
      expect(result.error!.code).toBe('E_CAAMP_PROVIDER_NOT_FOUND');
    });

    it('caampResolveAlias resolves known aliases', () => {
      // claude should resolve to claude-code
      const resolved = caampResolveAlias('claude');
      expect(resolved).toBe('claude-code');
    });

    it('mcpConfigPath returns path for known provider', () => {
      const result = mcpConfigPath('claude-code', 'project');
      expect(result.success).toBe(true);
      // Path may be null if not configured, but the operation should succeed
    });
  });

  describe('CAAMP adapter exports completeness', () => {
    it('all expected functions are exported from caamp/index', async () => {
      const caampExports = await import('../caamp/index.js');
      const expectedFunctions = [
        'providerList',
        'providerGet',
        'providerDetect',
        'providerInstalled',
        'providerCount',
        'registryVersion',
        'mcpList',
        'mcpListAll',
        'mcpInstall',
        'mcpRemove',
        'mcpConfigPath',
        'injectionCheck',
        'injectionCheckAll',
        'injectionUpdate',
        'injectionUpdateAll',
        'batchInstallWithRollback',
        'dualScopeConfigure',
        'caampResolveAlias',
        'caampBuildServerConfig',
        'caampGenerateInjectionContent',
        'caampGetInstructionFiles',
      ];

      for (const fn of expectedFunctions) {
        expect(typeof (caampExports as Record<string, unknown>)[fn]).toBe('function');
      }
    });
  });
});
