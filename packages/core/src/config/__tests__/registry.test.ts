/**
 * Tests for the SSoT config registry — `resolveCleoConfig` + helpers.
 *
 * Uses a temporary XDG_DATA_HOME to isolate the global `~/.cleo/config.json`
 * path resolved by `@cleocode/paths.getCleoHome()`, and a per-test temp
 * project root for the project-scoped cascade entries.
 *
 * @task T9878
 * @saga T9855
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEO_CONFIG_MANIFEST } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ZodTypeAny, z } from 'zod';
import {
  checkDrift,
  getConfigValue,
  loadProjectContext,
  loadProjectInfo,
  resolveCleoConfig,
  validateConfig,
} from '../registry.js';

// ---------------------------------------------------------------------------
// Isolation harness
// ---------------------------------------------------------------------------

// vitest's per-fork setup (vitest.setup.ts) pins CLEO_HOME to a sandbox dir so
// no test can clobber the developer's real ~/.cleo. To redirect the global
// config file resolved by @cleocode/paths.getCleoHome(), we override
// CLEO_HOME (which `createPlatformPathsResolver` honours as the data-dir
// override) for the lifetime of each test, then restore it.
const SAVED_CLEO_HOME = process.env['CLEO_HOME'];
let cleoHomeRoot: string;
let projectRoot: string;

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

beforeEach(() => {
  cleoHomeRoot = uniqueDir('cleo-registry-home');
  projectRoot = uniqueDir('cleo-registry-proj');
  mkdirSync(cleoHomeRoot, { recursive: true });
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
  process.env['CLEO_HOME'] = cleoHomeRoot;
});

afterEach(() => {
  if (SAVED_CLEO_HOME === undefined) {
    delete process.env['CLEO_HOME'];
  } else {
    process.env['CLEO_HOME'] = SAVED_CLEO_HOME;
  }
  rmSync(cleoHomeRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

function writeGlobalConfig(obj: unknown): void {
  writeFileSync(join(cleoHomeRoot, 'config.json'), JSON.stringify(obj));
}

function writeProjectConfig(obj: unknown): void {
  writeFileSync(join(projectRoot, '.cleo', 'config.json'), JSON.stringify(obj));
}

function writeProjectInfo(obj: unknown): void {
  writeFileSync(join(projectRoot, '.cleo', 'project-info.json'), JSON.stringify(obj));
}

function writeProjectContext(obj: unknown): void {
  writeFileSync(join(projectRoot, '.cleo', 'project-context.json'), JSON.stringify(obj));
}

// ---------------------------------------------------------------------------
// resolveCleoConfig — precedence
// ---------------------------------------------------------------------------

describe('resolveCleoConfig', () => {
  it('merged scope: project overrides global at every key path', async () => {
    writeGlobalConfig({
      release: { branchModel: 'feat-to-main', autoPush: true },
      logging: { level: 'info' },
      onlyGlobal: 'g',
    });
    writeProjectConfig({
      release: { branchModel: 'release-branches' },
      logging: { level: 'debug' },
      onlyProject: 'p',
    });
    const merged = await resolveCleoConfig({ scope: 'merged', projectRoot });
    expect(merged['release']).toEqual({ branchModel: 'release-branches', autoPush: true });
    expect(merged['logging']).toEqual({ level: 'debug' });
    expect(merged['onlyGlobal']).toBe('g');
    expect(merged['onlyProject']).toBe('p');
  });

  it('global scope: returns only the global file unmodified', async () => {
    writeGlobalConfig({ a: 1 });
    writeProjectConfig({ a: 2, b: 3 });
    const result = await resolveCleoConfig({ scope: 'global', projectRoot });
    expect(result).toEqual({ a: 1 });
  });

  it('project scope: returns only the project file unmodified', async () => {
    writeGlobalConfig({ a: 1 });
    writeProjectConfig({ a: 2, b: 3 });
    const result = await resolveCleoConfig({ scope: 'project', projectRoot });
    expect(result).toEqual({ a: 2, b: 3 });
  });

  it('missing files: returns {} for both global and project on missing', async () => {
    // no files written at all
    expect(await resolveCleoConfig({ scope: 'global', projectRoot })).toEqual({});
    expect(await resolveCleoConfig({ scope: 'project', projectRoot })).toEqual({});
    expect(await resolveCleoConfig({ scope: 'merged', projectRoot })).toEqual({});
  });

  it('malformed JSON: throws with the file path embedded', async () => {
    writeFileSync(join(projectRoot, '.cleo', 'config.json'), '{ this is not json');
    await expect(resolveCleoConfig({ scope: 'project', projectRoot })).rejects.toThrow(
      /Invalid JSON in .+\.cleo\/config\.json:/,
    );
  });

  it('top-level non-object JSON: rejected with helpful message', async () => {
    writeFileSync(join(projectRoot, '.cleo', 'config.json'), '[1, 2, 3]');
    await expect(resolveCleoConfig({ scope: 'project', projectRoot })).rejects.toThrow(
      /expected an object at top level/,
    );
  });

  it('deep-merge does not mutate the source files on subsequent resolves', async () => {
    writeGlobalConfig({ nested: { keep: true } });
    writeProjectConfig({ nested: { add: 1 } });
    const a = await resolveCleoConfig({ scope: 'merged', projectRoot });
    const b = await resolveCleoConfig({ scope: 'merged', projectRoot });
    expect(a).toEqual({ nested: { keep: true, add: 1 } });
    expect(b).toEqual({ nested: { keep: true, add: 1 } });
    // Mutating one result MUST not affect the other.
    (a['nested'] as Record<string, unknown>)['add'] = 999;
    expect((b['nested'] as Record<string, unknown>)['add']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Metadata loaders
// ---------------------------------------------------------------------------

describe('metadata loaders', () => {
  it('loadProjectInfo: returns null when absent', async () => {
    expect(await loadProjectInfo(projectRoot)).toBeNull();
  });

  it('loadProjectInfo: returns parsed contents when present', async () => {
    writeProjectInfo({ name: 'cleocode', version: '1.0.0' });
    expect(await loadProjectInfo(projectRoot)).toEqual({ name: 'cleocode', version: '1.0.0' });
  });

  it('loadProjectContext: returns null when absent', async () => {
    expect(await loadProjectContext(projectRoot)).toBeNull();
  });

  it('loadProjectContext: returns parsed contents when present', async () => {
    writeProjectContext({ detectedAt: '2026-05-24T00:00:00Z', primaryType: 'node' });
    expect(await loadProjectContext(projectRoot)).toEqual({
      detectedAt: '2026-05-24T00:00:00Z',
      primaryType: 'node',
    });
  });
});

// ---------------------------------------------------------------------------
// getConfigValue
// ---------------------------------------------------------------------------

describe('getConfigValue', () => {
  it('resolves a dotted key against the merged cascade by default', async () => {
    writeGlobalConfig({ release: { branchModel: 'feat-to-main' } });
    writeProjectConfig({ release: { branchModel: 'release-branches' } });
    const v = await getConfigValue<string>('release.branchModel', { projectRoot });
    expect(v).toBe('release-branches');
  });

  it('returns undefined for missing keys', async () => {
    writeProjectConfig({ a: 1 });
    expect(await getConfigValue('does.not.exist', { projectRoot })).toBeUndefined();
  });

  it('honours scope=global to bypass project overrides', async () => {
    writeGlobalConfig({ x: 'g' });
    writeProjectConfig({ x: 'p' });
    expect(await getConfigValue('x', { scope: 'global', projectRoot })).toBe('g');
    expect(await getConfigValue('x', { scope: 'project', projectRoot })).toBe('p');
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('returns ok=true when manifest has no attached schema', async () => {
    writeProjectConfig({ anything: 'goes' });
    // CLEO_CONFIG_MANIFEST.schema is undefined in the built-in entries.
    expect(CLEO_CONFIG_MANIFEST.schema).toBeUndefined();
    const result = await validateConfig('project', projectRoot);
    expect(result).toEqual({ ok: true, issues: [] });
  });

  it('returns ok=true when the file does not exist', async () => {
    const result = await validateConfig('project', projectRoot);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('returns issues when a schema is attached and parse fails', async () => {
    // Temporarily attach a schema to CLEO_CONFIG_MANIFEST for this test.
    const originalSchema = CLEO_CONFIG_MANIFEST.schema;
    const mutable = CLEO_CONFIG_MANIFEST as { schema?: ZodTypeAny | null };
    mutable.schema = z.object({ requiredField: z.string() });
    try {
      writeProjectConfig({ wrongField: 1 });
      const result = await validateConfig('project', projectRoot);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]).toMatch(/requiredField/);
    } finally {
      mutable.schema = originalSchema;
    }
  });
});

// ---------------------------------------------------------------------------
// checkDrift — staleness gate
// ---------------------------------------------------------------------------

describe('checkDrift', () => {
  it('staleness-gate: fresh detectedAt → no drift', async () => {
    writeProjectContext({ detectedAt: new Date().toISOString() });
    const result = await checkDrift('metadata', projectRoot);
    expect(result.drift).toBe(false);
  });

  it('staleness-gate: detectedAt > 30 days old → drift', async () => {
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    writeProjectContext({ detectedAt: oldDate });
    const result = await checkDrift('metadata', projectRoot);
    expect(result.drift).toBe(true);
    expect(result.reason).toMatch(/staleness-gate/);
  });

  it('staleness-gate: missing detectedAt → drift', async () => {
    writeProjectContext({ noDetectedAt: true });
    const result = await checkDrift('metadata', projectRoot);
    expect(result.drift).toBe(true);
    expect(result.reason).toMatch(/missing or non-string detectedAt/);
  });

  it('staleness-gate: missing file → no drift (consumer decides whether to scan)', async () => {
    // no project-context.json written
    const result = await checkDrift('metadata', projectRoot);
    expect(result.drift).toBe(false);
  });

  it('schema-validate scope for project/global: no schema → no drift', async () => {
    writeProjectConfig({ anything: 'goes' });
    expect(await checkDrift('project', projectRoot)).toEqual({ drift: false });
    expect(await checkDrift('global', projectRoot)).toEqual({ drift: false });
  });
});
