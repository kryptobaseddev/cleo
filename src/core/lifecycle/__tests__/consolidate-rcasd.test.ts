/**
 * Tests for RCASD consolidation migration.
 * @task T5200
 * @epic T4798
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveEpicFromFilename,
  resolveEpicFromContent,
  normalizeDirectoryNames,
  consolidateRcasd,
  migrateConsensusFiles,
  migrateContributionFiles,
  migrateLooseFiles,
} from '../consolidate-rcasd.js';

let testDir: string;
let cleoDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'cleo-consolidate-'));
  cleoDir = join(testDir, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(() => {
  delete process.env['CLEO_DIR'];
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveEpicFromFilename', () => {
  it('extracts epic ID from T####-* pattern', () => {
    expect(resolveEpicFromFilename('T4869-checkpoint-consensus.json')).toBe('T4869');
  });

  it('extracts epic ID from T####_* pattern', () => {
    expect(resolveEpicFromFilename('T2190_session-a.json')).toBe('T2190');
  });

  it('returns null for names without T#### prefix', () => {
    expect(resolveEpicFromFilename('README.md')).toBeNull();
  });

  it('returns null for names without separator after ID', () => {
    expect(resolveEpicFromFilename('T4869.json')).toBeNull();
  });

  it('handles long task IDs', () => {
    expect(resolveEpicFromFilename('T12345-long-name.md')).toBe('T12345');
  });
});

describe('resolveEpicFromContent', () => {
  it('resolves from @task annotation (highest priority)', () => {
    const content = '/** @task T5200 */\nconst x = 1;';
    expect(resolveEpicFromContent(content)).toBe('T5200');
  });

  it('resolves from @epic annotation', () => {
    const content = '/** @epic T4798 */\nmodule stuff;';
    expect(resolveEpicFromContent(content)).toBe('T4798');
  });

  it('resolves from JSON task field', () => {
    const content = '{"task": "T3000", "data": "value"}';
    expect(resolveEpicFromContent(content)).toBe('T3000');
  });

  it('resolves from JSON epicId field', () => {
    const content = '{"epicId": "T4500", "status": "done"}';
    expect(resolveEpicFromContent(content)).toBe('T4500');
  });

  it('falls back to first T#### in content', () => {
    const content = 'This references T8888 in the text.';
    expect(resolveEpicFromContent(content)).toBe('T8888');
  });

  it('returns null when no T#### found', () => {
    const content = 'No task references here.';
    expect(resolveEpicFromContent(content)).toBeNull();
  });

  it('prefers @task annotation over JSON field', () => {
    const content = '/** @task T1111 */\n{"task": "T2222"}';
    expect(resolveEpicFromContent(content)).toBe('T1111');
  });
});

describe('normalizeDirectoryNames', () => {
  it('renames suffixed directories to normalized epic IDs', () => {
    const epicDir = join(cleoDir, 'rcasd', 'T4881_install-channels');
    mkdirSync(epicDir, { recursive: true });

    const records = normalizeDirectoryNames();

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('success');
    expect(records[0]!.type).toBe('rename');
    expect(existsSync(join(cleoDir, 'rcasd', 'T4881'))).toBe(true);
  });

  it('skips directories that are already normalized', () => {
    mkdirSync(join(cleoDir, 'rcasd', 'T001'), { recursive: true });

    const records = normalizeDirectoryNames();

    expect(records).toHaveLength(0);
  });

  it('returns dry-run records without renaming', () => {
    const epicDir = join(cleoDir, 'rcasd', 'T4881_suffix');
    mkdirSync(epicDir, { recursive: true });

    const records = normalizeDirectoryNames({ dryRun: true });

    expect(records).toHaveLength(1);
    expect(records[0]!.reason).toBe('dry-run');
    // Original directory should still exist
    expect(existsSync(epicDir)).toBe(true);
  });
});

describe('migrateConsensusFiles', () => {
  it('migrates consensus files to epic subdirectory', () => {
    // Create consensus source directory
    const consensusDir = join(cleoDir, 'consensus');
    mkdirSync(consensusDir, { recursive: true });
    writeFileSync(
      join(consensusDir, 'T4869-checkpoint-consensus.json'),
      '{"task": "T4869"}',
    );

    const records = migrateConsensusFiles();

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('success');
    expect(
      existsSync(join(cleoDir, 'rcasd', 'T4869', 'consensus', 'T4869-checkpoint-consensus.json')),
    ).toBe(true);
  });

  it('returns empty array when consensus directory does not exist', () => {
    const records = migrateConsensusFiles();
    expect(records).toEqual([]);
  });

  it('skips files without resolvable epic ID', () => {
    const consensusDir = join(cleoDir, 'consensus');
    mkdirSync(consensusDir, { recursive: true });
    writeFileSync(join(consensusDir, 'random-notes.txt'), 'no epic here');

    const records = migrateConsensusFiles();

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('skipped');
    expect(records[0]!.reason).toBe('could not resolve epic ID');
  });
});

describe('migrateContributionFiles', () => {
  it('migrates contribution files to epic subdirectory', () => {
    const contribDir = join(cleoDir, 'contributions');
    mkdirSync(contribDir, { recursive: true });
    writeFileSync(
      join(contribDir, 'T5000-session-a.json'),
      '{"task": "T5000"}',
    );

    const records = migrateContributionFiles();

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('success');
    expect(
      existsSync(join(cleoDir, 'rcasd', 'T5000', 'contributions', 'T5000-session-a.json')),
    ).toBe(true);
  });

  it('returns empty array when contributions directory does not exist', () => {
    const records = migrateContributionFiles();
    expect(records).toEqual([]);
  });
});

describe('migrateLooseFiles', () => {
  it('migrates loose research files into epic research subdirectory', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(rcasdDir, { recursive: true });
    writeFileSync(join(rcasdDir, 'T4881_install-research.md'), '# Research for install channels');

    const records = migrateLooseFiles();

    expect(records).toHaveLength(1);
    expect(records[0]!.status).toBe('success');
    expect(
      existsSync(join(rcasdDir, 'T4881', 'research', 'T4881_install-research.md')),
    ).toBe(true);
  });

  it('returns empty when no loose files exist', () => {
    mkdirSync(join(cleoDir, 'rcasd'), { recursive: true });
    const records = migrateLooseFiles();
    expect(records).toEqual([]);
  });
});

describe('consolidateRcasd', () => {
  it('runs all migration steps and returns summary', () => {
    // Set up old structure
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(join(rcasdDir, 'T4881_install-channels'), { recursive: true });
    writeFileSync(join(rcasdDir, 'T5200_spec-notes.md'), '# Spec notes');

    const consensusDir = join(cleoDir, 'consensus');
    mkdirSync(consensusDir, { recursive: true });
    writeFileSync(
      join(consensusDir, 'T4869-consensus-report.json'),
      '{"task": "T4869"}',
    );

    const contribDir = join(cleoDir, 'contributions');
    mkdirSync(contribDir, { recursive: true });
    writeFileSync(
      join(contribDir, 'T5000-session-a.json'),
      '{"task": "T5000"}',
    );

    const result = consolidateRcasd();

    expect(result.dryRun).toBe(false);
    expect(result.totalErrors).toBe(0);
    expect(result.totalMoved).toBeGreaterThan(0);
    expect(result.moves.length).toBeGreaterThan(0);
  });

  it('dry run returns MoveRecords without actual moves', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(join(rcasdDir, 'T4881_suffix'), { recursive: true });
    writeFileSync(join(rcasdDir, 'T5200_notes.md'), '# Notes');

    const result = consolidateRcasd({ dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.moves.length).toBeGreaterThan(0);
    // Verify the original files are still in place (not moved)
    expect(existsSync(join(rcasdDir, 'T4881_suffix'))).toBe(true);
    expect(existsSync(join(rcasdDir, 'T5200_notes.md'))).toBe(true);
  });

  it('normalizes directory names as first step', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(join(rcasdDir, 'T4881_install-channels'), { recursive: true });
    writeFileSync(
      join(rcasdDir, 'T4881_install-channels', 'some-file.md'),
      '# Content',
    );

    consolidateRcasd();

    expect(existsSync(join(rcasdDir, 'T4881'))).toBe(true);
    expect(existsSync(join(rcasdDir, 'T4881_install-channels'))).toBe(false);
  });

  it('injects frontmatter into migrated markdown files', () => {
    const rcasdDir = join(cleoDir, 'rcasd');
    mkdirSync(rcasdDir, { recursive: true });
    writeFileSync(join(rcasdDir, 'T4881_research-notes.md'), '# Research\n\nFindings here.');

    consolidateRcasd();

    const movedPath = join(rcasdDir, 'T4881', 'research', 'T4881_research-notes.md');
    expect(existsSync(movedPath)).toBe(true);

    const content = readFileSync(movedPath, 'utf-8');
    expect(content).toContain('---');
    expect(content).toContain('epic: T4881');
    expect(content).toContain('stage: research');
    expect(content).toContain('# Research');
  });

  it('returns zero moves when nothing to migrate', () => {
    mkdirSync(join(cleoDir, 'rcasd'), { recursive: true });

    const result = consolidateRcasd();

    expect(result.moves).toHaveLength(0);
    expect(result.totalMoved).toBe(0);
    expect(result.totalSkipped).toBe(0);
    expect(result.totalErrors).toBe(0);
  });
});
