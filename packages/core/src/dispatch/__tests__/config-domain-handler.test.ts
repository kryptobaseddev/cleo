/**
 * Tests for the ConfigDomainHandler — the config-as-domain routing surface
 * over the ConfigManifest cascade resolver (T11917 · M5/AC3).
 *
 * Covers AC5: get / list / validate(rejects a bad value) / unset, plus the
 * scope-coercion guards and the idempotent-unset semantic.
 *
 * Uses a temporary CLEO_HOME to isolate the global `~/.cleo/config.json` path
 * resolved by `@cleocode/paths.getCleoHome()`, and a per-test temp project root
 * for the project-scoped cascade entries — mirrors `config/registry.test.ts`.
 *
 * @task T11917
 * @epic T11769
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEO_CONFIG_MANIFEST } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigDomainHandler } from '../config-domain-handler.js';

const SAVED_CLEO_HOME = process.env['CLEO_HOME'];
let cleoHomeRoot: string;
let projectRoot: string;
const handler = new ConfigDomainHandler();

function uniqueDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function writeGlobalConfig(obj: unknown): void {
  writeFileSync(join(cleoHomeRoot, 'config.json'), JSON.stringify(obj));
}

function writeProjectConfig(obj: unknown): void {
  writeFileSync(join(projectRoot, '.cleo', 'config.json'), JSON.stringify(obj));
}

function readProjectConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectRoot, '.cleo', 'config.json'), 'utf8'));
}

beforeEach(() => {
  cleoHomeRoot = uniqueDir('cleo-cfgdomain-home');
  projectRoot = uniqueDir('cleo-cfgdomain-proj');
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

// ---------------------------------------------------------------------------
// config.get
// ---------------------------------------------------------------------------

describe('ConfigDomainHandler.get', () => {
  it('resolves a nested value through the merged cascade (project wins)', async () => {
    writeGlobalConfig({ release: { branchModel: 'feat-to-main', autoPush: true } });
    writeProjectConfig({ release: { branchModel: 'release-branches' } });

    const result = await handler.get(projectRoot, 'release.branchModel');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data).toEqual({
      key: 'release.branchModel',
      scope: 'merged',
      value: 'release-branches',
      found: true,
    });
  });

  it('honours an explicit scope (global)', async () => {
    writeGlobalConfig({ a: 'g' });
    writeProjectConfig({ a: 'p' });

    const result = await handler.get(projectRoot, 'a', 'global');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.value).toBe('g');
    expect(result.data.scope).toBe('global');
  });

  it('reports found=false for an absent key (value=null)', async () => {
    writeProjectConfig({ a: 1 });
    const result = await handler.get(projectRoot, 'does.not.exist');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.found).toBe(false);
    expect(result.data.value).toBeNull();
  });

  it('rejects a missing key with E_INVALID_INPUT', async () => {
    const result = await handler.get(projectRoot, undefined);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });

  it('rejects an invalid scope with E_INVALID_INPUT', async () => {
    const result = await handler.get(projectRoot, 'a', 'bogus');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// config.list
// ---------------------------------------------------------------------------

describe('ConfigDomainHandler.list', () => {
  it('returns the full merged config plus flattened dot-notation keys', async () => {
    writeGlobalConfig({ logging: { level: 'info' }, onlyGlobal: 'g' });
    writeProjectConfig({ logging: { level: 'debug' }, onlyProject: 'p' });

    const result = await handler.list(projectRoot);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.scope).toBe('merged');
    expect(result.data.config['logging']).toEqual({ level: 'debug' });
    expect(result.data.config['onlyGlobal']).toBe('g');
    expect(result.data.keys).toEqual(['logging.level', 'onlyGlobal', 'onlyProject']);
  });

  it('lists only the project slice when scoped to project', async () => {
    writeGlobalConfig({ a: 1 });
    writeProjectConfig({ b: 2 });

    const result = await handler.list(projectRoot, 'project');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.config).toEqual({ b: 2 });
    expect(result.data.keys).toEqual(['b']);
  });

  it('rejects an invalid scope with E_INVALID_INPUT', async () => {
    const result = await handler.list(projectRoot, 'bogus');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// config.validate — rejects a bad value
// ---------------------------------------------------------------------------

describe('ConfigDomainHandler.validate', () => {
  it('reports ok=true when the project file passes its manifest schema', async () => {
    // Attach a schema to the project manifest entry for the lifetime of the test.
    const originalSchema = CLEO_CONFIG_MANIFEST.schema;
    (CLEO_CONFIG_MANIFEST as { schema?: unknown }).schema = z.object({
      logging: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']) }),
    });
    try {
      writeProjectConfig({ logging: { level: 'debug' } });
      const result = await handler.validate(projectRoot, 'project');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.ok).toBe(true);
      expect(result.data.issues).toEqual([]);
    } finally {
      (CLEO_CONFIG_MANIFEST as { schema?: unknown }).schema = originalSchema;
    }
  });

  it('REJECTS a bad value — ok=false with schema issues', async () => {
    const originalSchema = CLEO_CONFIG_MANIFEST.schema;
    (CLEO_CONFIG_MANIFEST as { schema?: unknown }).schema = z.object({
      logging: z.object({ level: z.enum(['debug', 'info', 'warn', 'error']) }),
    });
    try {
      // `level: 'LOUD'` is not in the enum — must be rejected.
      writeProjectConfig({ logging: { level: 'LOUD' } });
      const result = await handler.validate(projectRoot, 'project');
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('expected success');
      expect(result.data.ok).toBe(false);
      expect(result.data.issues.length).toBeGreaterThan(0);
      expect(result.data.issues.join(' ')).toContain('logging.level');
    } finally {
      (CLEO_CONFIG_MANIFEST as { schema?: unknown }).schema = originalSchema;
    }
  });

  it('rejects the merged scope with E_INVALID_INPUT (not single-file validatable)', async () => {
    const result = await handler.validate(projectRoot, 'merged');
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});

// ---------------------------------------------------------------------------
// config.unset
// ---------------------------------------------------------------------------

describe('ConfigDomainHandler.unset', () => {
  it('removes an existing key and persists the file (removed=true)', async () => {
    writeProjectConfig({ release: { branchModel: 'feat-to-main', autoPush: true }, keep: 'me' });

    const result = await handler.unset(projectRoot, 'release.branchModel');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data).toEqual({ key: 'release.branchModel', scope: 'project', removed: true });

    const persisted = readProjectConfig();
    expect(persisted['release']).toEqual({ autoPush: true });
    expect(persisted['keep']).toBe('me');
  });

  it('is idempotent — removing an absent key succeeds with removed=false', async () => {
    writeProjectConfig({ a: 1 });
    const result = await handler.unset(projectRoot, 'not.here');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('expected success');
    expect(result.data.removed).toBe(false);
    // File is left untouched.
    expect(readProjectConfig()).toEqual({ a: 1 });
  });

  it('rejects a missing key with E_INVALID_INPUT', async () => {
    const result = await handler.unset(projectRoot, undefined);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('expected failure');
    expect(result.error.code).toBe('E_INVALID_INPUT');
  });
});
