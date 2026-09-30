/**
 * Pure checks for manifest identity validation (T12829).
 *
 * @task T12829
 */

import { describe, expect, it } from 'vitest';
import {
  isManifestTaskId,
  manifestEntryIdProblem,
  manifestFileProblem,
  manifestIdentityIssues,
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
  ])('rejects %j', (file) => {
    expect(manifestFileProblem(file, ROOT)).not.toBeNull();
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
