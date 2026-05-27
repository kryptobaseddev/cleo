/**
 * Tests for the CLEO-native changeset parser.
 *
 * @epic T9738
 * @task T9738
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangesetYamlInvalidError } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseChangesetDir, parseChangesetFile } from '../parser.js';

describe('parseChangesetFile', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-changesets-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Helper — write `content` to `<tmpDir>/<name>` and return the path. */
  const writeEntry = (name: string, content: string): string => {
    const path = join(tmpDir, name);
    writeFileSync(path, content, 'utf8');
    return path;
  };

  it('parses a valid minimal entry', () => {
    const path = writeEntry(
      'happy-path.md',
      [
        '---',
        'id: happy-path',
        'tasks: [T1234]',
        'kind: fix',
        'summary: Stop the bleed.',
        '---',
        '',
      ].join('\n'),
    );

    const entry = parseChangesetFile(path);
    expect(entry.id).toBe('happy-path');
    expect(entry.tasks).toEqual(['T1234']);
    expect(entry.kind).toBe('fix');
    expect(entry.summary).toBe('Stop the bleed.');
    expect(entry.notes).toBeUndefined();
    expect(entry.prs).toBeUndefined();
  });

  it('captures markdown body as `notes`', () => {
    const path = writeEntry(
      'with-notes.md',
      [
        '---',
        'id: with-notes',
        'tasks: [T9999]',
        'kind: refactor',
        'summary: Untangle the monolith.',
        'prs: [123, 456]',
        '---',
        '',
        'Longer explanation here.',
        '',
        'Multiple paragraphs survive.',
        '',
      ].join('\n'),
    );

    const entry = parseChangesetFile(path);
    expect(entry.prs).toEqual([123, 456]);
    expect(entry.notes).toBe('Longer explanation here.\n\nMultiple paragraphs survive.');
  });

  it('accepts the E-#### display form for task IDs', () => {
    const path = writeEntry(
      'epic-id.md',
      [
        '---',
        'id: epic-id',
        'tasks: [E-9738, T9738-A]',
        'kind: docs',
        'summary: Document the new format.',
        '---',
      ].join('\n'),
    );

    const entry = parseChangesetFile(path);
    expect(entry.tasks).toEqual(['E-9738', 'T9738-A']);
  });

  it('throws when frontmatter is missing a required field (summary)', () => {
    const path = writeEntry(
      'missing-summary.md',
      ['---', 'id: missing-summary', 'tasks: [T1]', 'kind: fix', '---'].join('\n'),
    );

    expect(() => parseChangesetFile(path)).toThrow(/summary/);
  });

  it('throws when `kind` is not in the allowed enum', () => {
    const path = writeEntry(
      'bad-kind.md',
      ['---', 'id: bad-kind', 'tasks: [T1]', 'kind: misc', 'summary: Unknown bucket.', '---'].join(
        '\n',
      ),
    );

    expect(() => parseChangesetFile(path)).toThrow(/kind/);
  });

  it('throws when `tasks` is empty', () => {
    const path = writeEntry(
      'no-tasks.md',
      ['---', 'id: no-tasks', 'tasks: []', 'kind: fix', 'summary: Orphan change.', '---'].join(
        '\n',
      ),
    );

    expect(() => parseChangesetFile(path)).toThrow(/tasks/);
  });

  it('throws when a task ID is malformed', () => {
    const path = writeEntry(
      'bad-task-id.md',
      [
        '---',
        'id: bad-task-id',
        'tasks: [TASK-123]',
        'kind: fix',
        'summary: Wrong prefix.',
        '---',
      ].join('\n'),
    );

    expect(() => parseChangesetFile(path)).toThrow(/task ID/);
  });

  it('throws when breaking entry has no migration note', () => {
    const path = writeEntry(
      'breaking-no-note.md',
      [
        '---',
        'id: breaking-no-note',
        'tasks: [T1]',
        'kind: breaking',
        'summary: Major rename.',
        '---',
      ].join('\n'),
    );

    expect(() => parseChangesetFile(path)).toThrow(/breaking/);
  });

  it('throws when opening frontmatter fence is missing', () => {
    const path = writeEntry('no-fence.md', 'id: no-fence\ntasks: [T1]\nkind: fix\n');

    expect(() => parseChangesetFile(path)).toThrow(/opening '---' frontmatter fence/);
  });

  it('throws when closing frontmatter fence is missing', () => {
    const path = writeEntry(
      'unclosed.md',
      ['---', 'id: unclosed', 'tasks: [T1]', 'kind: fix', 'summary: Forgot the fence.'].join('\n'),
    );

    expect(() => parseChangesetFile(path)).toThrow(/closing '---' frontmatter fence/);
  });

  it('throws when filename slug does not match `id`', () => {
    const path = writeEntry(
      'expected-slug.md',
      ['---', 'id: different-slug', 'tasks: [T1]', 'kind: fix', 'summary: Mismatch.', '---'].join(
        '\n',
      ),
    );

    expect(() => parseChangesetFile(path)).toThrow(/does not match filename slug/);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T10105 — fail-loud YAML parse (v2026.5.100 silent-skip repro)
  // ─────────────────────────────────────────────────────────────────────────

  it('throws ChangesetYamlInvalidError when summary has an unquoted colon (v5.100 repro)', () => {
    const path = writeEntry(
      'v5100-repro.md',
      [
        '---',
        'id: v5100-repro',
        'tasks: [T1]',
        'kind: feat',
        'summary: feat(T1): unquoted colon eats the entry',
        '---',
      ].join('\n'),
    );

    let captured: unknown;
    try {
      parseChangesetFile(path);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ChangesetYamlInvalidError);
    const e = captured as ChangesetYamlInvalidError;
    expect(e.code).toBe('E_CHANGESET_YAML_INVALID');
    expect(e.details.file).toBe(path);
    expect(e.details.line).toBeTypeOf('number');
    expect(e.details.line).toBeGreaterThan(0);
    expect(e.details.parserMessage).toMatch(/.+/);
    expect(e.message).toMatch(/v5100-repro\.md/);
    expect(e.message).toMatch(/invalid YAML frontmatter/);
  });

  it('throws ChangesetYamlInvalidError when frontmatter is structurally broken YAML', () => {
    const path = writeEntry('broken-yaml.md', ['---', '  [unmatched: bracket', '---'].join('\n'));

    expect(() => parseChangesetFile(path)).toThrow(ChangesetYamlInvalidError);
  });
});

describe('parseChangesetDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-changesets-dir-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses every `.md` file in alphabetical order, excluding README.md', () => {
    writeFileSync(
      join(tmpDir, 'README.md'),
      '# Should be ignored\nnot a valid changeset\n',
      'utf8',
    );
    writeFileSync(join(tmpDir, 'config.json'), '{}', 'utf8');
    writeFileSync(
      join(tmpDir, 'b-second.md'),
      ['---', 'id: b-second', 'tasks: [T2]', 'kind: fix', 'summary: Second.', '---'].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(tmpDir, 'a-first.md'),
      ['---', 'id: a-first', 'tasks: [T1]', 'kind: feat', 'summary: First.', '---'].join('\n'),
      'utf8',
    );

    const entries = parseChangesetDir(tmpDir);
    expect(entries.map((e) => e.id)).toEqual(['a-first', 'b-second']);
  });

  it('returns empty array when directory has only README.md', () => {
    writeFileSync(join(tmpDir, 'README.md'), '# Empty\n', 'utf8');
    expect(parseChangesetDir(tmpDir)).toEqual([]);
  });
});
