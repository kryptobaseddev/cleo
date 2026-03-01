/**
 * Tests for RCASD canonical path helpers.
 * @task T5200
 * @epic T4798
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  normalizeEpicId,
  getEpicDir,
  getRcasdBaseDir,
  getStagePath,
  ensureStagePath,
  getLooseResearchFiles,
  listEpicDirs,
  findEpicDir,
  getManifestPath,
  findManifestPath,
} from '../rcasd-paths.js';

let testDir: string;
let cleoDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cleo-rcasd-paths-'));
  cleoDir = join(testDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(() => {
  delete process.env['CLEO_DIR'];
  rmSync(testDir, { recursive: true, force: true });
});

describe('normalizeEpicId', () => {
  it('strips suffix from T####_descriptor', () => {
    expect(normalizeEpicId('T4881_install-channels')).toBe('T4881');
  });

  it('returns already-normalized ID unchanged', () => {
    expect(normalizeEpicId('T4881')).toBe('T4881');
  });

  it('handles short IDs', () => {
    expect(normalizeEpicId('T123')).toBe('T123');
  });

  it('strips multi-word suffix', () => {
    expect(normalizeEpicId('T4881_multi_word_suffix')).toBe('T4881');
  });

  it('returns non-epic names as-is', () => {
    expect(normalizeEpicId('grade-campaign')).toBe('grade-campaign');
  });

  it('returns plain directory names as-is', () => {
    expect(normalizeEpicId('research')).toBe('research');
  });
});

describe('getRcasdBaseDir', () => {
  it('returns path ending in rcasd', () => {
    const base = getRcasdBaseDir();
    expect(base).toBe(join(cleoDir, 'rcasd'));
  });
});

describe('getEpicDir', () => {
  it('returns correct absolute path for an epic', () => {
    const dir = getEpicDir('T4881');
    expect(dir).toBe(join(cleoDir, 'rcasd', 'T4881'));
  });

  it('uses normalized ID when given a suffixed name', () => {
    const dir = getEpicDir('T4881_install-channels');
    expect(dir).toBe(join(cleoDir, 'rcasd', 'T4881'));
  });
});

describe('getStagePath', () => {
  it('maps architecture_decision to architecture subdirectory', () => {
    const path = getStagePath('T4881', 'architecture_decision');
    expect(path).toBe(join(cleoDir, 'rcasd', 'T4881', 'architecture'));
  });

  it('maps contribution to contributions subdirectory', () => {
    const path = getStagePath('T4881', 'contribution');
    expect(path).toBe(join(cleoDir, 'rcasd', 'T4881', 'contributions'));
  });

  it('maps research to research subdirectory', () => {
    const path = getStagePath('T4881', 'research');
    expect(path).toBe(join(cleoDir, 'rcasd', 'T4881', 'research'));
  });

  it('falls back to raw stage name for unmapped stages', () => {
    const path = getStagePath('T4881', 'custom-stage');
    expect(path).toBe(join(cleoDir, 'rcasd', 'T4881', 'custom-stage'));
  });
});

describe('ensureStagePath', () => {
  it('creates the stage directory if it does not exist', () => {
    mkdirSync(join(cleoDir, 'rcasd', 'T001'), { recursive: true });
    const path = ensureStagePath('T001', 'research');
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(join(cleoDir, 'rcasd', 'T001', 'research'));
  });

  it('returns existing directory without error', () => {
    const dir = join(cleoDir, 'rcasd', 'T001', 'consensus');
    mkdirSync(dir, { recursive: true });
    const path = ensureStagePath('T001', 'consensus');
    expect(path).toBe(dir);
  });
});

describe('findEpicDir', () => {
  it('finds exact match in rcasd/', () => {
    const epicDir = join(cleoDir, 'rcasd', 'T001');
    mkdirSync(epicDir, { recursive: true });
    expect(findEpicDir('T001')).toBe(epicDir);
  });

  it('finds suffixed directory matching normalized ID', () => {
    const epicDir = join(cleoDir, 'rcasd', 'T4881_install-channels');
    mkdirSync(epicDir, { recursive: true });
    expect(findEpicDir('T4881')).toBe(epicDir);
  });

  it('finds directory in legacy rcsd/', () => {
    const epicDir = join(cleoDir, 'rcsd', 'T200');
    mkdirSync(epicDir, { recursive: true });
    expect(findEpicDir('T200')).toBe(epicDir);
  });

  it('returns null when epic directory does not exist', () => {
    expect(findEpicDir('T9999')).toBeNull();
  });
});

describe('getManifestPath', () => {
  it('returns _manifest.json path under the epic directory', () => {
    const path = getManifestPath('T001');
    expect(path).toBe(join(cleoDir, 'rcasd', 'T001', '_manifest.json'));
  });
});

describe('findManifestPath', () => {
  it('returns manifest path when it exists', () => {
    const epicDir = join(cleoDir, 'rcasd', 'T001');
    mkdirSync(epicDir, { recursive: true });
    writeFileSync(join(epicDir, '_manifest.json'), '{}');
    expect(findManifestPath('T001')).toBe(join(epicDir, '_manifest.json'));
  });

  it('returns null when manifest does not exist', () => {
    const epicDir = join(cleoDir, 'rcasd', 'T001');
    mkdirSync(epicDir, { recursive: true });
    expect(findManifestPath('T001')).toBeNull();
  });

  it('returns null when epic directory does not exist', () => {
    expect(findManifestPath('T9999')).toBeNull();
  });
});

describe('getLooseResearchFiles', () => {
  it('finds loose T####_*.md files in rcasd root', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(rcasdDir, { recursive: true });
    writeFileSync(join(rcasdDir, 'T4881_install-research.md'), '# Research');
    writeFileSync(join(rcasdDir, 'T5200_spec-notes.md'), '# Notes');

    const files = getLooseResearchFiles();
    expect(files).toHaveLength(2);

    const epicIds = files.map((f) => f.epicId).sort();
    expect(epicIds).toEqual(['T4881', 'T5200']);
  });

  it('does not include files inside subdirectories', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    const subDir = join(rcasdDir, 'T001');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'T001_research.md'), '# Research');
    // Also put a loose file at root level
    writeFileSync(join(rcasdDir, 'T002_notes.md'), '# Notes');

    const files = getLooseResearchFiles();
    expect(files).toHaveLength(1);
    expect(files[0]!.epicId).toBe('T002');
  });

  it('ignores non-matching filenames', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(rcasdDir, { recursive: true });
    writeFileSync(join(rcasdDir, 'README.md'), '# README');
    writeFileSync(join(rcasdDir, 'notes.txt'), 'notes');

    const files = getLooseResearchFiles();
    expect(files).toHaveLength(0);
  });

  it('returns empty array when rcasd directory does not exist', () => {
    const files = getLooseResearchFiles();
    expect(files).toEqual([]);
  });
});

describe('listEpicDirs', () => {
  it('lists epic directories from rcasd/', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(join(rcasdDir, 'T001'), { recursive: true });
    mkdirSync(join(rcasdDir, 'T002'), { recursive: true });

    const dirs = listEpicDirs();
    const ids = dirs.map((d) => d.epicId).sort();
    expect(ids).toEqual(['T001', 'T002']);
  });

  it('normalizes suffixed directory names in results', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(join(rcasdDir, 'T4881_install-channels'), { recursive: true });

    const dirs = listEpicDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.epicId).toBe('T4881');
    expect(dirs[0]!.dirName).toBe('T4881_install-channels');
  });

  it('includes directories from both rcasd/ and rcsd/', () => {
    mkdirSync(join(cleoDir, 'rcasd', 'T001'), { recursive: true });
    mkdirSync(join(cleoDir, 'rcsd', 'T002'), { recursive: true });

    const dirs = listEpicDirs();
    const ids = dirs.map((d) => d.epicId).sort();
    expect(ids).toEqual(['T001', 'T002']);
  });

  it('ignores non-epic directories', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(join(rcasdDir, 'T001'), { recursive: true });
    mkdirSync(join(rcasdDir, 'research'), { recursive: true });
    mkdirSync(join(rcasdDir, '.backups'), { recursive: true });

    const dirs = listEpicDirs();
    expect(dirs).toHaveLength(1);
    expect(dirs[0]!.epicId).toBe('T001');
  });

  it('returns empty array when no lifecycle directories exist', () => {
    const dirs = listEpicDirs();
    expect(dirs).toEqual([]);
  });
});
