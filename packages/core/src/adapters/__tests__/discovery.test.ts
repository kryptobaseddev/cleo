/**
 * Unit tests for adapter discovery.
 * @task T5240
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DetectionPattern } from '@cleocode/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { detectProvider, discoverAdapterManifests } from '../discovery.js';

describe('discoverAdapterManifests — installed package', () => {
  it.each([
    fileURLToPath(new URL('../../../../../', import.meta.url)),
    '/tmp/nonexistent-cleo-project',
  ])('discovers shipped adapters from %s without project adapter packages', (projectRoot) => {
    const manifests = discoverAdapterManifests(projectRoot);
    const claude = manifests.find((manifest) => manifest.id === 'claude-code');
    expect(claude?.provider).toBe('claude-code');
    expect(claude?.capabilities.supportsSpawn).toBe(true);
    expect(claude?.entryPoint).toBe('index.js');
    expect(existsSync(join(claude!.packagePath, 'index.ts'))).toBe(true);
    expect(new Set(manifests.map((manifest) => manifest.id)).size).toBe(manifests.length);
  });

  it('resolves shipped manifests to JavaScript entry points in an installed package layout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-installed-adapters-'));
    try {
      const source = new URL('../../../../adapters/src/manifests.ts', import.meta.url);
      const manifest = new URL(
        '../../../../adapters/src/providers/claude-code/manifest.json',
        import.meta.url,
      );
      mkdirSync(join(root, 'src', 'providers', 'claude-code'), { recursive: true });
      mkdirSync(join(root, 'dist'));
      writeFileSync(
        join(root, 'src', 'providers', 'claude-code', 'manifest.json'),
        readFileSync(manifest),
      );
      const modulePath = join(root, 'dist', 'manifests.mjs');
      writeFileSync(modulePath, stripTypeScriptTypes(readFileSync(source, 'utf8')));
      const installed: typeof import('@cleocode/adapters/manifests') = await import(
        pathToFileURL(modulePath).href
      );
      expect(installed.getProviderManifests()).toMatchObject([
        {
          id: 'claude-code',
          packagePath: join(root, 'dist', 'providers', 'claude-code'),
          entryPoint: 'index.js',
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the installed adapter authoritative over a project manifest with the same id', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleo-adapter-precedence-'));
    try {
      const dir = join(root, 'packages', 'adapters', 'claude-code');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({ id: 'claude-code', provider: 'project-override' }),
      );
      const manifests = discoverAdapterManifests(root);
      expect(manifests.filter((manifest) => manifest.id === 'claude-code')).toHaveLength(1);
      expect(manifests.find((manifest) => manifest.id === 'claude-code')?.provider).toBe(
        'claude-code',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('detectProvider — unit', () => {
  beforeEach(() => {
    // Clean up any test env vars
    delete process.env.TEST_CLEO_ADAPTER_DETECT;
  });

  it('returns false for empty patterns', () => {
    expect(detectProvider([])).toBe(false);
  });

  it('detects env pattern when env var is set', () => {
    process.env.TEST_CLEO_ADAPTER_DETECT = '1';
    const patterns: DetectionPattern[] = [
      { type: 'env', pattern: 'TEST_CLEO_ADAPTER_DETECT', description: 'Test env var' },
    ];
    expect(detectProvider(patterns)).toBe(true);
    delete process.env.TEST_CLEO_ADAPTER_DETECT;
  });

  it('returns false for env pattern when env var is not set', () => {
    const patterns: DetectionPattern[] = [
      { type: 'env', pattern: 'NONEXISTENT_VAR_CLEO_TEST', description: 'Missing var' },
    ];
    expect(detectProvider(patterns)).toBe(false);
  });

  it('detects file pattern when file exists', () => {
    const patterns: DetectionPattern[] = [
      { type: 'file', pattern: tmpdir(), description: 'tmp directory exists' },
    ];
    expect(detectProvider(patterns)).toBe(true);
  });

  it('returns false for file pattern when file does not exist', () => {
    const patterns: DetectionPattern[] = [
      { type: 'file', pattern: '/nonexistent/path/cleo-test', description: 'Missing file' },
    ];
    expect(detectProvider(patterns)).toBe(false);
  });

  it('returns true if any pattern matches', () => {
    const patterns: DetectionPattern[] = [
      { type: 'env', pattern: 'NONEXISTENT_VAR_1', description: 'Miss' },
      { type: 'file', pattern: tmpdir(), description: 'Hit' },
    ];
    expect(detectProvider(patterns)).toBe(true);
  });
});
