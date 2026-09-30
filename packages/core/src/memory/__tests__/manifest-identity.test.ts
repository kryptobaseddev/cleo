/**
 * Pure checks for manifest identity validation (T12829).
 *
 * @task T12829
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isManifestTaskId,
  manifestEntryIdProblem,
  manifestFileProblem,
  manifestIdentityIssues,
  readContainedFile,
  resolveContainedFile,
} from '../manifest-identity.js';

const ROOT = '/project';

describe('isManifestTaskId', () => {
  it.each(['T1', 'T12829', 'T-RECONCILE-FOLLOWUP-v2026.5.63-6', 'T932EP'])('accepts %s', (id) => {
    expect(isManifestTaskId(id)).toBe(true);
  });

  it.each([
    ['a JSON blob', JSON.stringify({ k: 'v' })],
    ['a traversal', '../../x'],
    ['a path', 'T1/../x'],
    ['whitespace', 'T1 2'],
    ['a very long value', `T${'1'.repeat(600)}`],
    ['no T prefix', '12829'],
    ['empty', ''],
    ['a non-string', 42],
  ])('rejects %s', (_label, id) => {
    expect(isManifestTaskId(id)).toBe(false);
  });
});

describe('manifestEntryIdProblem', () => {
  it('accepts shorthand-generated ids', () => {
    expect(manifestEntryIdProblem('T12829-implementation-20260929120000')).toBeNull();
    expect(manifestEntryIdProblem('T1171-w2a-10-audit')).toBeNull();
  });

  it.each([
    '../x',
    'a/b',
    'a\\b',
    '.hidden',
    'a b',
    'a\nb',
    'a'.repeat(201),
    '',
  ])('rejects %j', (id) => {
    expect(manifestEntryIdProblem(id)).not.toBeNull();
  });
});

describe('manifestFileProblem', () => {
  it.each([
    '.cleo/agent-outputs/T1-implementation-1.md',
    'out/T1.md',
    'cleo://docs/some-slug',
  ])('accepts %s', (file) => {
    expect(manifestFileProblem(file, ROOT)).toBeNull();
  });

  it.each([
    '../secret.txt',
    '.cleo/agent-outputs/../../../x.md',
    '.',
    `out/${'a'.repeat(256)}.md`,
    'out/a\u0000.md',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'C:/Windows/win.ini',
    'C:win.ini',
    'c:',
    'out\\a.md',
    '..\\secret.txt',
    '\\\\server\\share\\x.md',
    '//server/share/x.md',
  ])('rejects %j', (file) => {
    expect(manifestFileProblem(file, ROOT)).not.toBeNull();
  });
});

describe('resolveContainedFile / readContainedFile (symlinks)', () => {
  let base: string;
  let proj: string;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-contained-')));
    proj = join(base, 'proj');
    mkdirSync(join(proj, 'out'), { recursive: true });
    mkdirSync(join(base, 'outside'));
    writeFileSync(join(base, 'outside', 'secret.txt'), 'SECRET-OUTSIDE');
    writeFileSync(join(proj, 'out', 'real.md'), 'IN-PROJECT');
    writeFileSync(join(base, 'proj-evil.txt'), 'SIBLING');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('reads a plain in-project file', () => {
    expect(readContainedFile(proj, 'out/real.md')).toMatchObject({
      status: 'ok',
      content: 'IN-PROJECT',
    });
  });

  it('refuses an in-project symlink to an outside directory', () => {
    symlinkSync('../outside', join(proj, 'link'));
    expect(manifestFileProblem('link/secret.txt', proj)).toBeNull(); // lexical check passes
    expect(resolveContainedFile(proj, 'link/secret.txt').status).toBe('unsafe');
    const read = readContainedFile(proj, 'link/secret.txt');
    expect(read.status).toBe('unsafe');
    expect(JSON.stringify(read)).not.toContain('SECRET-OUTSIDE');
  });

  it('refuses an in-project symlink to an outside file', () => {
    symlinkSync(join(base, 'outside', 'secret.txt'), join(proj, 'secret.md'));
    expect(readContainedFile(proj, 'secret.md').status).toBe('unsafe');
  });

  it('is separator-safe: a sibling sharing the root prefix is outside', () => {
    symlinkSync(join(base, 'proj-evil.txt'), join(proj, 'evil.md'));
    expect(readContainedFile(proj, 'evil.md').status).toBe('unsafe');
  });

  it('allows an in-project symlink to an in-project file', () => {
    symlinkSync('out/real.md', join(proj, 'alias.md'));
    expect(readContainedFile(proj, 'alias.md')).toMatchObject({
      status: 'ok',
      content: 'IN-PROJECT',
      realPath: join(proj, 'out', 'real.md'),
    });
  });

  it('treats a dangling symlink and a missing file as not-found', () => {
    symlinkSync('../outside/nope.txt', join(proj, 'dangling.md'));
    expect(readContainedFile(proj, 'dangling.md')).toEqual({ status: 'not-found' });
    expect(readContainedFile(proj, 'out/missing.md')).toEqual({ status: 'not-found' });
  });

  it('fails reading a directory and refuses a URI reference', () => {
    expect(() => readContainedFile(proj, 'out')).toThrow(/EISDIR/);
    expect(resolveContainedFile(proj, 'cleo://docs/x').status).toBe('unsafe');
  });
});

describe('manifestIdentityIssues', () => {
  it('reports each bad field and truncates huge values', () => {
    const blob = JSON.stringify({ k: 'a'.repeat(900) });
    const issues = manifestIdentityIssues(
      { id: blob, linked_tasks: [blob], file: `.cleo/agent-outputs/${blob}.md` },
      ROOT,
    );
    expect(issues.map((i) => i.field)).toEqual(['id', 'linked_tasks', 'file']);
    for (const issue of issues) {
      expect(issue.code).toBe('E_VALIDATION');
      expect(issue.value.length).toBeLessThan(160);
    }
  });

  it('does not check an absent file', () => {
    expect(manifestIdentityIssues({ id: 'ok', linked_tasks: ['T1'] }, ROOT)).toEqual([]);
  });
});
