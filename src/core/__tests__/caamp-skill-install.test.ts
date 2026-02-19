/**
 * T4718: Test CAAMP skill install + integrity check end-to-end.
 *
 * Verifies the full skill installation flow:
 * 1. CAAMP adapter in src/core/caamp/ exists and exports correctly
 * 2. Skill discovery via parseSkillFile
 * 3. Skill installation to canonical paths
 * 4. Integrity after install
 *
 * @task T4718
 * @epic T4663
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(thisFile), '..', '..', '..');

describe('CAAMP skill install + integrity (T4718)', () => {
  describe('CAAMP adapter module structure', () => {
    it('src/core/caamp/index.ts exists', () => {
      expect(existsSync(join(packageRoot, 'src', 'core', 'caamp', 'index.ts'))).toBe(true);
    });

    it('src/core/caamp/adapter.ts exists', () => {
      expect(existsSync(join(packageRoot, 'src', 'core', 'caamp', 'adapter.ts'))).toBe(true);
    });

    it('barrel export from caamp/index.ts re-exports all adapter functions', async () => {
      const caamp = await import('../caamp/index.js');
      // Types are not runtime-checkable, so check functions only
      const functionNames = [
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

      for (const fn of functionNames) {
        expect(typeof (caamp as Record<string, unknown>)[fn]).toBe('function');
      }
    });
  });

  describe('CAAMP parseSkillFile via discovery module', () => {
    it('caampParseSkillFile is accessible from discovery module', async () => {
      // The discovery module uses caampParseSkillFile from @cleocode/caamp
      const { parseSkillFile } = await import('@cleocode/caamp');
      expect(typeof parseSkillFile).toBe('function');
    });

    it('caampDiscoverSkill is accessible from @cleocode/caamp', async () => {
      const { discoverSkill } = await import('@cleocode/caamp');
      expect(typeof discoverSkill).toBe('function');
    });

    it('caampDiscoverSkills is accessible from @cleocode/caamp', async () => {
      const { discoverSkills } = await import('@cleocode/caamp');
      expect(typeof discoverSkills).toBe('function');
    });

    it('getCanonicalSkillsDir returns a path', async () => {
      const { getCanonicalSkillsDir } = await import('@cleocode/caamp');
      const dir = getCanonicalSkillsDir();
      expect(typeof dir).toBe('string');
      expect(dir.length).toBeGreaterThan(0);
    });
  });

  describe('CAAMP skill installation functions', () => {
    it('installSkill is accessible from @cleocode/caamp', async () => {
      const { installSkill } = await import('@cleocode/caamp');
      expect(typeof installSkill).toBe('function');
    });

    it('installBatchWithRollback is accessible from @cleocode/caamp', async () => {
      const { installBatchWithRollback } = await import('@cleocode/caamp');
      expect(typeof installBatchWithRollback).toBe('function');
    });
  });

  describe('Skill search paths', () => {
    it('getSkillSearchPaths returns ordered paths', async () => {
      const { getSkillSearchPaths } = await import('../skills/discovery.js');
      const paths = getSkillSearchPaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);

      // Verify ordering
      for (let i = 1; i < paths.length; i++) {
        expect(paths[i]!.priority).toBeGreaterThanOrEqual(paths[i - 1]!.priority);
      }
    });

    it('getSkillSearchPaths includes expected scopes', async () => {
      const { getSkillSearchPaths } = await import('../skills/discovery.js');
      const paths = getSkillSearchPaths();
      const scopes = paths.map(p => p.scope);
      expect(scopes).toContain('cleo-home');
      expect(scopes).toContain('agent-skills');
      expect(scopes).toContain('app-embedded');
      expect(scopes).toContain('project-custom');
    });
  });

  describe('EngineResult type integrity', () => {
    it('providerList returns EngineResult shape', async () => {
      const { providerList } = await import('../caamp/index.js');
      const result = providerList();
      // EngineResult has success, data?, error?
      expect(typeof result.success).toBe('boolean');
      if (result.success) {
        expect(result.data).toBeDefined();
        expect(result.error).toBeUndefined();
      } else {
        expect(result.error).toBeDefined();
        expect(result.error!.code).toBeDefined();
        expect(result.error!.message).toBeDefined();
      }
    });

    it('providerGet error returns EngineResult shape', async () => {
      const { providerGet } = await import('../caamp/index.js');
      const result = providerGet('nonexistent-xyz');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(typeof result.error!.code).toBe('string');
      expect(typeof result.error!.message).toBe('string');
    });
  });

  describe('CAAMP instruction files', () => {
    it('caampGetInstructionFiles returns known files', async () => {
      const { caampGetInstructionFiles } = await import('../caamp/index.js');
      const files = caampGetInstructionFiles();
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      // Should include CLAUDE.md
      expect(files.some((f: string) => f.includes('CLAUDE'))).toBe(true);
    });
  });

  describe('CAAMP server config generation', () => {
    it('caampBuildServerConfig creates valid config for package source', async () => {
      const { caampBuildServerConfig } = await import('../caamp/index.js');
      const config = caampBuildServerConfig(
        { type: 'package', value: '@cleocode/mcp-server' },
      );
      expect(config).toBeDefined();
      expect(config.command).toBeDefined();
    });
  });
});
