/**
 * Unit tests for the shared CANT context builder.
 *
 * Tests cover:
 * - discoverCantFiles: finds .cant files, handles missing dirs
 * - resolveThreeTierPaths: XDG-compliant paths with env var overrides
 * - discoverCantFilesMultiTier: 3-tier merge with override semantics
 * - readMemoryBridge: reads file, handles missing/empty
 * - buildMemoryBridgeBlock: wraps content in labeled section
 * - buildMentalModelInjection: pure function, numbered list, empty input
 * - buildCantEnrichedPrompt: full pipeline, fallback on failure
 *
 * @task T555
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildCantEnrichedPrompt,
  buildMemoryBridgeBlock,
  buildMentalModelInjection,
  discoverCantFiles,
  discoverCantFilesMultiTier,
  readMemoryBridge,
  resolveThreeTierPaths,
} from '../cant-context.js';

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `cleo-cant-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// discoverCantFiles
// ---------------------------------------------------------------------------

describe('discoverCantFiles', () => {
  it('finds .cant files recursively', () => {
    const cantDir = join(tempDir, 'cant');
    mkdirSync(join(cantDir, 'agents'), { recursive: true });
    writeFileSync(join(cantDir, 'team.cant'), 'team: test');
    writeFileSync(join(cantDir, 'agents', 'worker.cant'), 'agent: worker');
    writeFileSync(join(cantDir, 'agents', 'README.md'), 'ignored');

    const files = discoverCantFiles(cantDir);
    expect(files).toHaveLength(2);
    expect(files.some((f) => f.endsWith('team.cant'))).toBe(true);
    expect(files.some((f) => f.endsWith('worker.cant'))).toBe(true);
  });

  it('returns empty array for non-existent directory', () => {
    const files = discoverCantFiles(join(tempDir, 'does-not-exist'));
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveThreeTierPaths
// ---------------------------------------------------------------------------

describe('resolveThreeTierPaths', () => {
  it('returns project tier pointing to .cleo/cant/', () => {
    const paths = resolveThreeTierPaths('/my/project');
    expect(paths.project).toBe('/my/project/.cleo/cant');
  });

  it('respects XDG_DATA_HOME for global tier', () => {
    const originalXdg = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = '/custom/data';
    try {
      const paths = resolveThreeTierPaths('/my/project');
      expect(paths.global).toBe('/custom/data/cleo/cant');
    } finally {
      if (originalXdg) process.env['XDG_DATA_HOME'] = originalXdg;
      else delete process.env['XDG_DATA_HOME'];
    }
  });

  it('respects XDG_CONFIG_HOME for user tier', () => {
    const originalXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = '/custom/config';
    try {
      const paths = resolveThreeTierPaths('/my/project');
      expect(paths.user).toBe('/custom/config/cleo/cant');
    } finally {
      if (originalXdg) process.env['XDG_CONFIG_HOME'] = originalXdg;
      else delete process.env['XDG_CONFIG_HOME'];
    }
  });
});

// ---------------------------------------------------------------------------
// discoverCantFilesMultiTier
// ---------------------------------------------------------------------------

describe('discoverCantFilesMultiTier', () => {
  let origXdgData: string | undefined;
  let origXdgConfig: string | undefined;

  beforeEach(() => {
    // Override XDG paths so global/user tiers point to empty temp subdirs
    origXdgData = process.env['XDG_DATA_HOME'];
    origXdgConfig = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_DATA_HOME'] = join(tempDir, 'xdg-data');
    process.env['XDG_CONFIG_HOME'] = join(tempDir, 'xdg-config');
  });

  afterEach(() => {
    if (origXdgData) process.env['XDG_DATA_HOME'] = origXdgData;
    else delete process.env['XDG_DATA_HOME'];
    if (origXdgConfig) process.env['XDG_CONFIG_HOME'] = origXdgConfig;
    else delete process.env['XDG_CONFIG_HOME'];
  });

  it('discovers files from project tier', () => {
    const cantDir = join(tempDir, '.cleo', 'cant');
    mkdirSync(cantDir, { recursive: true });
    writeFileSync(join(cantDir, 'team.cant'), 'team: test');

    const result = discoverCantFilesMultiTier(tempDir);
    expect(result.files).toHaveLength(1);
    expect(result.stats.project).toBe(1);
  });

  it('returns empty when no tiers have .cant files', () => {
    const result = discoverCantFilesMultiTier(tempDir);
    expect(result.files).toHaveLength(0);
    expect(result.stats.merged).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readMemoryBridge
// ---------------------------------------------------------------------------

describe('readMemoryBridge', () => {
  it('returns null when file does not exist', () => {
    expect(readMemoryBridge(tempDir)).toBeNull();
  });

  it('returns content when file exists', () => {
    const cleoDir = join(tempDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'memory-bridge.md'), '# Memory Bridge\nTest content');

    const result = readMemoryBridge(tempDir);
    expect(result).toContain('Memory Bridge');
    expect(result).toContain('Test content');
  });

  it('returns null for empty file', () => {
    const cleoDir = join(tempDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'memory-bridge.md'), '');

    expect(readMemoryBridge(tempDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildMemoryBridgeBlock
// ---------------------------------------------------------------------------

describe('buildMemoryBridgeBlock', () => {
  it('wraps content in labeled section markers', () => {
    const result = buildMemoryBridgeBlock('Test content');
    expect(result).toContain('===== CLEO MEMORY BRIDGE =====');
    expect(result).toContain('Test content');
    expect(result).toContain('===== END MEMORY BRIDGE =====');
  });
});

// ---------------------------------------------------------------------------
// buildMentalModelInjection
// ---------------------------------------------------------------------------

describe('buildMentalModelInjection', () => {
  it('returns empty string for empty observations', () => {
    expect(buildMentalModelInjection('test-agent', [])).toBe('');
  });

  it('builds numbered list with preamble', () => {
    const result = buildMentalModelInjection('code-worker', [
      { id: 'O-001', type: 'observation', title: 'Tests pass', date: '2026-04-14' },
      { id: 'O-002', type: 'pattern', title: 'Use vitest' },
    ]);

    expect(result).toContain('MENTAL MODEL (validate-on-load)');
    expect(result).toContain('Agent: code-worker');
    expect(result).toContain('1. [O-001] (observation) [2026-04-14]: Tests pass');
    expect(result).toContain('2. [O-002] (pattern): Use vitest');
    expect(result).toContain('END MENTAL MODEL');
  });
});

// ---------------------------------------------------------------------------
// buildCantEnrichedPrompt
// ---------------------------------------------------------------------------

describe('buildCantEnrichedPrompt', () => {
  it('returns basePrompt unchanged when no .cant files exist', async () => {
    const result = await buildCantEnrichedPrompt({
      projectDir: tempDir,
      basePrompt: 'Execute the task.',
    });
    expect(result).toBe('Execute the task.');
  });

  it('appends memory bridge when .cleo/memory-bridge.md exists', async () => {
    const cleoDir = join(tempDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'memory-bridge.md'), '# Bridge\nRecent decisions here');

    const result = await buildCantEnrichedPrompt({
      projectDir: tempDir,
      basePrompt: 'Execute the task.',
    });

    expect(result).toContain('Execute the task.');
    expect(result).toContain('CLEO MEMORY BRIDGE');
    expect(result).toContain('Recent decisions here');
  });

  it('includes both memory bridge and base prompt without duplication', async () => {
    const cleoDir = join(tempDir, '.cleo');
    mkdirSync(cleoDir, { recursive: true });
    writeFileSync(join(cleoDir, 'memory-bridge.md'), 'Bridge content');

    const result = await buildCantEnrichedPrompt({
      projectDir: tempDir,
      basePrompt: 'My prompt',
    });

    // Base prompt should appear exactly once at the start
    expect(result.startsWith('My prompt')).toBe(true);
    // Should not duplicate the prompt
    expect(result.indexOf('My prompt')).toBe(result.lastIndexOf('My prompt'));
  });
});
