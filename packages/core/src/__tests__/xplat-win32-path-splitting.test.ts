/**
 * Absolute OS paths are split with `path`, not on '/' (T12608).
 *
 * `node:path` is replaced with `path.win32` for every module under test, which
 * is what those modules get on Windows. `'C:\\a\\b.md'.split('/')` returns the
 * whole string, so the old code returned full paths where a file or directory
 * name was expected.
 *
 * `node:fs` reads are served from an in-memory fixture map for the Windows
 * paths, which do not exist on the host running the test.
 *
 * @task T12608
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const fixtures = vi.hoisted(() => new Map<string, string>());

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual.win32, default: actual.win32 };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    const fixture = fixtures.get(String(args[0]));
    return fixture ?? actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

vi.mock('../store/json.js', () => ({
  readJson: async (filePath: string) =>
    fixtures.has(filePath) ? JSON.parse(fixtures.get(filePath) ?? 'null') : null,
}));

import { parseAdrFile } from '../adrs/parse.js';
import { scanFile, scanSkill } from '../skills/skills-guard.js';
import { extractPackageMeta } from '../store/import-logging.js';
import { isUnderRoot } from '../store/portable-bundle-relocate.js';

afterEach(() => {
  fixtures.clear();
});

describe('Windows path shapes (T12608)', () => {
  it('parseAdrFile derives the ADR id from the file name, not the full path', () => {
    const file = 'C:\\repo\\.cleo\\adrs\\ADR-012-cross-platform.md';
    fixtures.set(file, '# ADR-012: Cross platform\n\n**Status**: accepted\n');

    const record = parseAdrFile(file, 'C:\\repo');

    expect(record.id).toBe('ADR-012');
    expect(record.file).toBe(file);
  });

  it('parseAdrFile treats a drive-rooted path as absolute', () => {
    const file = 'D:\\elsewhere\\ADR-003-x.md';
    fixtures.set(file, '# ADR-003: X\n');
    // Old: `filePath.startsWith('/')` was false, so it read join(projectRoot, filePath).
    expect(parseAdrFile(file, 'C:\\repo').id).toBe('ADR-003');
  });

  it('scanSkill names the skill by its directory name', () => {
    const result = scanSkill('C:\\Users\\me\\.agents\\skills\\ct-demo', 'random/unknown');
    expect(result.skillName).toBe('ct-demo');
  });

  it('scanFile renders the file name and recognises SKILL.md', () => {
    const file = 'C:\\skills\\ct-demo\\SKILL.md';
    fixtures.set(file, 'rm -rf /\n');

    const findings = scanFile(file);

    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) expect(f.file).toBe('SKILL.md');
  });

  it('extractPackageMeta reports the export file name', async () => {
    const file = 'C:\\exports\\tasks-export.json';
    fixtures.set(file, JSON.stringify({ _meta: { taskCount: 2 } }));

    const meta = await extractPackageMeta(file);

    expect(meta.sourceFile).toBe('tasks-export.json');
    expect(meta.taskCount).toBe(2);
  });
});

describe('isUnderRoot boundary is separator-agnostic (T12608)', () => {
  it('Windows paths: C:\\p\\a is under C:\\p, C:\\pa is not', () => {
    expect(isUnderRoot('C:\\p\\a\\b.db', 'C:\\p')).toBe(true);
    expect(isUnderRoot('C:\\p', 'C:\\p')).toBe(true);
    expect(isUnderRoot('C:\\pa\\b.db', 'C:\\p')).toBe(false);
  });

  it('POSIX paths are unchanged', () => {
    expect(isUnderRoot('/a/b/c', '/a/b')).toBe(true);
    expect(isUnderRoot('/a/bc', '/a/b')).toBe(false);
  });

  it('a root with a trailing separator still matches its children', () => {
    expect(isUnderRoot('C:\\x', 'C:\\')).toBe(true);
    expect(isUnderRoot('/x', '/')).toBe(true);
  });
});
