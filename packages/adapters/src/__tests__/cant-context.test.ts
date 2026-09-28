/**
 * Unit tests for the shared CANT context builder.
 *
 * Tests cover:
 * - discoverCantFiles: finds .cant files, handles missing dirs
 * - resolveThreeTierPaths: tiers resolve through @cleocode/paths on every platform
 * - discoverCantFilesMultiTier: 3-tier merge with override semantics
 * - readMemoryBridge: reads file, handles missing/empty
 * - buildMemoryBridgeBlock: wraps content in labeled section
 * - buildMentalModelInjection: pure function, numbered list, empty input
 * - buildCantEnrichedPrompt: full pipeline, fallback on failure
 *
 * @task T555
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildCantEnrichedPrompt,
  buildMemoryBridgeBlock,
  buildMentalModelInjection,
  discoverCantFiles,
  discoverCantFilesMultiTier,
  readIdentityFile,
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
  const PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform');

  function stubPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  beforeEach(() => {
    vi.stubEnv('CLEO_HOME', undefined);
    vi.stubEnv('CLEO_CONFIG_HOME', undefined);
  });

  afterEach(() => {
    if (PLATFORM) Object.defineProperty(process, 'platform', PLATFORM);
    vi.unstubAllEnvs();
  });

  it('returns project tier pointing to .cleo/cant/', () => {
    const paths = resolveThreeTierPaths('/my/project');
    expect(paths.project).toBe(join('/my/project', '.cleo', 'cant'));
  });

  it('global tier is <getCleoHome()>/cant and user tier is <CLEO config>/cant', () => {
    vi.stubEnv('CLEO_HOME', '/opt/cleo-data');
    vi.stubEnv('CLEO_CONFIG_HOME', '/opt/cleo-config');
    const paths = resolveThreeTierPaths('/my/project');
    expect(paths.global).toBe(join('/opt/cleo-data', 'cant'));
    expect(paths.user).toBe(join('/opt/cleo-config', 'cant'));
  });

  it('macOS: global and user tiers are under ~/Library, not the XDG dirs (T12602)', () => {
    stubPlatform('darwin');
    vi.stubEnv('XDG_DATA_HOME', '/custom/data');
    vi.stubEnv('XDG_CONFIG_HOME', '/custom/config');
    const paths = resolveThreeTierPaths('/my/project');
    expect(paths.global).toBe(join(getCleoHome(), 'cant'));
    expect(paths.global).toBe(join(homedir(), 'Library', 'Application Support', 'cleo', 'cant'));
    expect(paths.user).toBe(join(homedir(), 'Library', 'Preferences', 'cleo', 'cant'));
  });

  it('Windows: global tier is under %LOCALAPPDATA% (T12602)', () => {
    stubPlatform('win32');
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\me\\AppData\\Local');
    vi.stubEnv('XDG_DATA_HOME', '/custom/data');
    const paths = resolveThreeTierPaths('/my/project');
    expect(paths.global).toBe(join(getCleoHome(), 'cant'));
    expect(paths.global.startsWith('C:\\Users\\me\\AppData\\Local')).toBe(true);
  });

  it('Linux: honours XDG_DATA_HOME and XDG_CONFIG_HOME', () => {
    stubPlatform('linux');
    vi.stubEnv('XDG_DATA_HOME', '/custom/data');
    vi.stubEnv('XDG_CONFIG_HOME', '/custom/config');
    const paths = resolveThreeTierPaths('/my/project');
    expect(paths.global).toBe(join('/custom/data', 'cleo', 'cant'));
    expect(paths.user).toBe(join('/custom/config', 'cleo', 'cant'));
  });
});

// ---------------------------------------------------------------------------
// readIdentityFile — global tier (T12602)
// ---------------------------------------------------------------------------

describe('readIdentityFile', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads the global CLEOOS-IDENTITY.md from getCleoHome(), not $XDG_DATA_HOME/cleo', () => {
    const cleoHome = join(tempDir, 'cleo-home');
    mkdirSync(cleoHome, { recursive: true });
    writeFileSync(join(cleoHome, 'CLEOOS-IDENTITY.md'), 'global identity');
    vi.stubEnv('CLEO_HOME', cleoHome);
    vi.stubEnv('XDG_DATA_HOME', join(tempDir, 'empty-xdg'));

    expect(readIdentityFile(join(tempDir, 'project'))).toBe('global identity');
  });
});

// ---------------------------------------------------------------------------
// discoverCantFilesMultiTier
// ---------------------------------------------------------------------------

describe('discoverCantFilesMultiTier', () => {
  beforeEach(() => {
    // Point the global/user tiers at empty temp subdirs on every platform.
    vi.stubEnv('CLEO_HOME', join(tempDir, 'cleo-home'));
    vi.stubEnv('CLEO_CONFIG_HOME', join(tempDir, 'cleo-config'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('discovers files from the global tier under getCleoHome() (T12602)', () => {
    const globalCant = join(tempDir, 'cleo-home', 'cant');
    mkdirSync(globalCant, { recursive: true });
    writeFileSync(join(globalCant, 'global.cant'), 'team: global');

    const result = discoverCantFilesMultiTier(tempDir);
    expect(result.stats.global).toBe(1);
    expect(result.files).toEqual([join(globalCant, 'global.cant')]);
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
