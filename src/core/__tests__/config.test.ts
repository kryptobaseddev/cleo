/**
 * Tests for config engine.
 * @epic T4454
 * @task T4458
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, getConfigValue } from '../config.js';

describe('loadConfig', () => {
  let tempDir: string;
  const origHome = process.env['CLEO_HOME'];
  const origDir = process.env['CLEO_DIR'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-config-test-'));
    // Point to a non-existent global config
    process.env['CLEO_HOME'] = join(tempDir, 'global');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
    else delete process.env['CLEO_HOME'];
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
    // Clean up any env vars we set
    delete process.env['CLEO_FORMAT'];
  });

  it('returns defaults when no config files exist', async () => {
    const projectDir = join(tempDir, 'project');
    process.env['CLEO_DIR'] = join(projectDir, '.cleo');
    const config = await loadConfig(projectDir);
    expect(config.output.defaultFormat).toBe('json');
    expect(config.hierarchy.maxDepth).toBe(3);
    expect(config.hierarchy.maxSiblings).toBe(7);
    expect(config.backup.maxSafetyBackups).toBe(5);
  });

  it('merges project config over defaults', async () => {
    const cleoDir = join(tempDir, 'project', '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        version: '2.10.0',
        _meta: { schemaVersion: '2.10.0' },
        output: { defaultFormat: 'text' },
      }),
    );
    process.env['CLEO_DIR'] = cleoDir;
    const config = await loadConfig(join(tempDir, 'project'));
    expect(config.output.defaultFormat).toBe('text');
    // Other defaults preserved
    expect(config.hierarchy.maxDepth).toBe(3);
  });

  it('environment variables override config files', async () => {
    const cleoDir = join(tempDir, 'project', '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        version: '2.10.0',
        _meta: { schemaVersion: '2.10.0' },
        output: { defaultFormat: 'text' },
      }),
    );
    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_FORMAT'] = 'markdown';
    const config = await loadConfig(join(tempDir, 'project'));
    expect(config.output.defaultFormat).toBe('markdown');
  });

  it('merges global config under project config', async () => {
    // Create global config
    const globalDir = join(tempDir, 'global');
    await mkdir(globalDir, { recursive: true });
    await writeFile(
      join(globalDir, 'config.json'),
      JSON.stringify({
        version: '2.10.0',
        _meta: { schemaVersion: '2.10.0' },
        hierarchy: { maxSiblings: 10 },
      }),
    );
    process.env['CLEO_HOME'] = globalDir;

    // Create project config that overrides one value
    const cleoDir = join(tempDir, 'project', '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        version: '2.10.0',
        _meta: { schemaVersion: '2.10.0' },
        hierarchy: { maxDepth: 5 },
      }),
    );
    process.env['CLEO_DIR'] = cleoDir;

    const config = await loadConfig(join(tempDir, 'project'));
    // Project config wins for maxDepth
    expect(config.hierarchy.maxDepth).toBe(5);
    // Global config provides maxSiblings
    expect(config.hierarchy.maxSiblings).toBe(10);
  });
});

describe('getConfigValue', () => {
  let tempDir: string;
  const origHome = process.env['CLEO_HOME'];
  const origDir = process.env['CLEO_DIR'];

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-config-test-'));
    process.env['CLEO_HOME'] = join(tempDir, 'global');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    if (origHome !== undefined) process.env['CLEO_HOME'] = origHome;
    else delete process.env['CLEO_HOME'];
    if (origDir !== undefined) process.env['CLEO_DIR'] = origDir;
    else delete process.env['CLEO_DIR'];
    delete process.env['CLEO_FORMAT'];
  });

  it('returns default value with source tracking', async () => {
    const projectDir = join(tempDir, 'project');
    process.env['CLEO_DIR'] = join(projectDir, '.cleo');
    const result = await getConfigValue<number>('hierarchy.maxDepth', projectDir);
    expect(result.value).toBe(3);
    expect(result.source).toBe('default');
  });

  it('returns env value with source tracking', async () => {
    const projectDir = join(tempDir, 'project');
    process.env['CLEO_DIR'] = join(projectDir, '.cleo');
    process.env['CLEO_FORMAT'] = 'table';
    const result = await getConfigValue<string>('output.defaultFormat', projectDir);
    expect(result.value).toBe('table');
    expect(result.source).toBe('env');
  });

  it('returns project config value with source tracking', async () => {
    const cleoDir = join(tempDir, 'project', '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        version: '2.10.0',
        _meta: { schemaVersion: '2.10.0' },
        hierarchy: { maxDepth: 5 },
      }),
    );
    process.env['CLEO_DIR'] = cleoDir;
    const result = await getConfigValue<number>('hierarchy.maxDepth', join(tempDir, 'project'));
    expect(result.value).toBe(5);
    expect(result.source).toBe('project');
  });
});
