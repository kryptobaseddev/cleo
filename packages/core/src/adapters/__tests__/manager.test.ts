/**
 * Unit tests for AdapterManager, discovery, and detection.
 * @task T5240
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectProvider, discoverAdapterManifests } from '../discovery.js';
import { AdapterManager } from '../manager.js';

// --- Helpers ---

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `cleo-adapter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createManifest(dir: string, manifest: Record<string, unknown>): void {
  const adaptersDir = join(dir, 'packages', 'adapters', manifest.provider as string);
  mkdirSync(adaptersDir, { recursive: true });
  writeFileSync(join(adaptersDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

const MOCK_MANIFEST = {
  id: 'test-adapter',
  name: 'Test Adapter',
  version: '1.0.0',
  description: 'A test adapter',
  provider: 'test-provider',
  entryPoint: 'dist/index.js',
  capabilities: {
    supportsHooks: true,
    supportedHookEvents: ['SessionStart', 'Stop'],
    supportsSpawn: false,
    supportsInstall: true,
    supportsInstructionFiles: true,
    instructionFilePattern: 'CLAUDE.md',
  },
  detectionPatterns: [
    { type: 'env' as const, pattern: 'CLEO_TEST_ADAPTER_DETECT', description: 'Test env var' },
  ],
};

// --- Discovery tests ---

describe('discoverAdapterManifests', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty array when packages/adapters/ does not exist', () => {
    const result = discoverAdapterManifests(tempDir);
    expect(result).toEqual([]);
  });

  it('discovers a valid manifest.json', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    const result = discoverAdapterManifests(tempDir);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('test-adapter');
    expect(result[0].provider).toBe('test-provider');
  });

  it('discovers multiple adapters', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    createManifest(tempDir, {
      ...MOCK_MANIFEST,
      id: 'second-adapter',
      provider: 'second-provider',
    });
    const result = discoverAdapterManifests(tempDir);
    expect(result).toHaveLength(2);
  });

  it('skips directories without manifest.json', () => {
    const adaptersDir = join(tempDir, 'packages', 'adapters', 'no-manifest');
    mkdirSync(adaptersDir, { recursive: true });
    const result = discoverAdapterManifests(tempDir);
    expect(result).toHaveLength(0);
  });

  it('skips malformed manifest.json', () => {
    const adaptersDir = join(tempDir, 'packages', 'adapters', 'bad-adapter');
    mkdirSync(adaptersDir, { recursive: true });
    writeFileSync(join(adaptersDir, 'manifest.json'), 'not valid json{{{');
    const result = discoverAdapterManifests(tempDir);
    expect(result).toHaveLength(0);
  });
});

// --- Detection tests ---

describe('detectProvider', () => {
  it('returns false when no patterns match', () => {
    const result = detectProvider([
      { type: 'env', pattern: 'NONEXISTENT_CLEO_TEST_VAR_12345', description: 'test' },
    ]);
    expect(result).toBe(false);
  });

  it('detects env variable pattern', () => {
    process.env.CLEO_TEST_DETECT_VAR = '1';
    try {
      const result = detectProvider([
        { type: 'env', pattern: 'CLEO_TEST_DETECT_VAR', description: 'test' },
      ]);
      expect(result).toBe(true);
    } finally {
      delete process.env.CLEO_TEST_DETECT_VAR;
    }
  });

  it('detects file existence pattern', () => {
    const tempDir = makeTempDir();
    try {
      const testFile = join(tempDir, 'detect-marker');
      writeFileSync(testFile, '');
      const result = detectProvider([{ type: 'file', pattern: testFile, description: 'test' }]);
      expect(result).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns false for non-existent file pattern', () => {
    const result = detectProvider([
      { type: 'file', pattern: '/tmp/nonexistent-cleo-test-file-12345', description: 'test' },
    ]);
    expect(result).toBe(false);
  });

  it('returns true if any pattern matches', () => {
    process.env.CLEO_TEST_MULTI = '1';
    try {
      const result = detectProvider([
        { type: 'env', pattern: 'NONEXISTENT_VAR_12345', description: 'no match' },
        { type: 'env', pattern: 'CLEO_TEST_MULTI', description: 'matches' },
      ]);
      expect(result).toBe(true);
    } finally {
      delete process.env.CLEO_TEST_MULTI;
    }
  });

  it('returns false for empty patterns array', () => {
    const result = detectProvider([]);
    expect(result).toBe(false);
  });
});

// --- AdapterManager tests ---

describe('AdapterManager', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    AdapterManager.resetInstance();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    AdapterManager.resetInstance();
  });

  it('returns singleton instance', () => {
    const a = AdapterManager.getInstance(tempDir);
    const b = AdapterManager.getInstance(tempDir);
    expect(a).toBe(b);
  });

  it('resets singleton', () => {
    const a = AdapterManager.getInstance(tempDir);
    AdapterManager.resetInstance();
    const b = AdapterManager.getInstance(tempDir);
    expect(a).not.toBe(b);
  });

  it('lists empty adapters initially', () => {
    const manager = AdapterManager.getInstance(tempDir);
    expect(manager.listAdapters()).toEqual([]);
  });

  it('returns null for active when none set', () => {
    const manager = AdapterManager.getInstance(tempDir);
    expect(manager.getActive()).toBeNull();
    expect(manager.getActiveId()).toBeNull();
  });

  it('returns null for unknown adapter get', () => {
    const manager = AdapterManager.getInstance(tempDir);
    expect(manager.get('nonexistent')).toBeNull();
  });

  it('returns null for unknown manifest', () => {
    const manager = AdapterManager.getInstance(tempDir);
    expect(manager.getManifest('nonexistent')).toBeNull();
  });

  it('discover returns empty when no packages/adapters/ exists', () => {
    const manager = AdapterManager.getInstance(tempDir);
    const manifests = manager.discover();
    expect(manifests).toEqual([]);
  });

  it('discover finds adapters from packages/adapters/', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    const manager = AdapterManager.getInstance(tempDir);
    const manifests = manager.discover();
    expect(manifests).toHaveLength(1);
    expect(manifests[0].id).toBe('test-adapter');
  });

  it('getManifest returns manifest after discovery', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    const manager = AdapterManager.getInstance(tempDir);
    manager.discover();
    const manifest = manager.getManifest('test-adapter');
    expect(manifest).not.toBeNull();
    expect(manifest?.provider).toBe('test-provider');
  });

  it('detectActive returns IDs when env pattern matches', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    process.env.CLEO_TEST_ADAPTER_DETECT = '1';
    try {
      const manager = AdapterManager.getInstance(tempDir);
      manager.discover();
      const detected = manager.detectActive();
      expect(detected).toContain('test-adapter');
    } finally {
      delete process.env.CLEO_TEST_ADAPTER_DETECT;
    }
  });

  it('detectActive returns empty when no patterns match', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    const manager = AdapterManager.getInstance(tempDir);
    manager.discover();
    const detected = manager.detectActive();
    expect(detected).toEqual([]);
  });

  it('listAdapters returns info for all discovered manifests', () => {
    createManifest(tempDir, MOCK_MANIFEST);
    const manager = AdapterManager.getInstance(tempDir);
    manager.discover();
    const list = manager.listAdapters();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      id: 'test-adapter',
      name: 'Test Adapter',
      version: '1.0.0',
      provider: 'test-provider',
      healthy: false,
      active: false,
    });
  });

  it('activate throws for unknown adapter', async () => {
    const manager = AdapterManager.getInstance(tempDir);
    await expect(manager.activate('nonexistent')).rejects.toThrow(
      'Adapter manifest not found: nonexistent',
    );
  });

  it('healthCheck returns not-initialized for unknown adapter', async () => {
    const manager = AdapterManager.getInstance(tempDir);
    const status = await manager.healthCheck('nonexistent');
    expect(status.healthy).toBe(false);
    expect(status.details).toEqual({ error: 'Adapter not initialized' });
  });

  it('healthCheckAll returns empty map when no adapters initialized', async () => {
    const manager = AdapterManager.getInstance(tempDir);
    const results = await manager.healthCheckAll();
    expect(results.size).toBe(0);
  });

  it('dispose does nothing when no adapters', async () => {
    const manager = AdapterManager.getInstance(tempDir);
    await expect(manager.dispose()).resolves.toBeUndefined();
  });

  it('disposeAdapter does nothing for unknown adapter', async () => {
    const manager = AdapterManager.getInstance(tempDir);
    await expect(manager.disposeAdapter('nonexistent')).resolves.toBeUndefined();
  });
});
