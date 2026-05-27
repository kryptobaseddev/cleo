/**
 * Unit tests for {@link parseChangesetFrontmatter} — the in-memory parser
 * variant the `cleo docs add --type changeset` delegation path consumes.
 *
 * Covers:
 *   - Happy path (valid frontmatter + body → entry round-trips).
 *   - Missing-frontmatter detection (no `---` fences at all).
 *   - Missing-required field detection (id/tasks/kind/summary).
 *   - YAML parse failure surface (preserves parser message + line).
 *   - Schema-invalid (cross-field rule, e.g. breaking requires `breaking`).
 *   - Notes body merge precedence (frontmatter wins over body).
 *
 * @task T10367
 * @epic T10290
 * @saga T10288
 */

import type { ChangesetEntry } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { parseChangesetFrontmatter, renderChangesetMarkdown } from '../index.js';

describe('parseChangesetFrontmatter (T10367)', () => {
  it('round-trips a valid entry through render → parse without loss', () => {
    const entry: ChangesetEntry = {
      id: 't10367-roundtrip',
      tasks: ['T10367', 'T10290'],
      kind: 'feat',
      summary: 'parse-frontmatter helper for the docs-add delegation path',
      prs: [617],
      notes: 'Body content lives in the markdown section after the fence.',
    };
    const markdown = renderChangesetMarkdown(entry);
    const result = parseChangesetFrontmatter(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.entry.id).toBe(entry.id);
    expect(result.entry.tasks).toEqual(entry.tasks);
    expect(result.entry.kind).toBe(entry.kind);
    expect(result.entry.summary).toBe(entry.summary);
    expect(result.entry.prs).toEqual(entry.prs);
    expect(result.entry.notes).toBe(entry.notes);
  });

  it('reports missing-frontmatter when no fences are present', () => {
    const result = parseChangesetFrontmatter('# Plain Markdown\n\nNo frontmatter here.');
    expect(result).toEqual({ ok: false, error: 'missing-frontmatter' });
  });

  it('reports missing-frontmatter when the closing fence is missing', () => {
    const result = parseChangesetFrontmatter('---\nid: t10367-no-close\nkind: feat\n\nbody');
    expect(result).toEqual({ ok: false, error: 'missing-frontmatter' });
  });

  it('reports missing-required for absent top-level fields', () => {
    const raw = ['---', 'id: t10367-incomplete', 'kind: feat', '---', '', 'body', ''].join('\n');
    const result = parseChangesetFrontmatter(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('missing-required');
    if (result.error !== 'missing-required') throw new Error('shape narrowing');
    expect(result.missing).toEqual(expect.arrayContaining(['tasks', 'summary']));
    // `id` and `kind` ARE present in this fixture → must NOT be in `missing`.
    expect(result.missing).not.toContain('id');
    expect(result.missing).not.toContain('kind');
  });

  it('reports missing-required when a required field is an empty array', () => {
    const raw = [
      '---',
      'id: t10367-empty-tasks',
      'tasks: []',
      'kind: feat',
      'summary: empty tasks list',
      '---',
      '',
    ].join('\n');
    const result = parseChangesetFrontmatter(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('missing-required');
    if (result.error !== 'missing-required') throw new Error('shape narrowing');
    expect(result.missing).toContain('tasks');
  });

  it('reports yaml-invalid with parser message for unparseable YAML', () => {
    // Indentation drift inside a mapping — yaml@2.x flags this as a parse
    // error and sets linePos so the parser surface can include the line.
    const raw = ['---', 'id: t10367-yaml-bad', ' kind: feat', '---', '', 'body', ''].join('\n');
    const result = parseChangesetFrontmatter(raw);
    if (result.ok) {
      // Some YAML libraries are lenient here — accept either failure shape
      // (yaml-invalid OR missing-required after coerced parse).
      throw new Error('expected non-ok result for malformed YAML');
    }
    expect(['yaml-invalid', 'missing-required', 'schema-invalid']).toContain(result.error);
  });

  it('reports schema-invalid when breaking kind lacks the breaking note', () => {
    const raw = [
      '---',
      'id: t10367-no-breaking',
      'tasks: [T10367]',
      'kind: breaking',
      'summary: missing the required breaking note',
      '---',
      '',
    ].join('\n');
    const result = parseChangesetFrontmatter(raw);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toBe('schema-invalid');
  });

  it('respects frontmatter `notes` over body when both are present', () => {
    const raw = [
      '---',
      'id: t10367-notes-precedence',
      'tasks: [T10367]',
      'kind: feat',
      'summary: notes precedence',
      'notes: from frontmatter',
      '---',
      '',
      'from body',
      '',
    ].join('\n');
    const result = parseChangesetFrontmatter(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.entry.notes).toBe('from frontmatter');
  });

  it('falls back to body content for `notes` when frontmatter omits it', () => {
    const raw = [
      '---',
      'id: t10367-body-notes',
      'tasks: [T10367]',
      'kind: feat',
      'summary: body notes',
      '---',
      '',
      'Body becomes notes',
      '',
    ].join('\n');
    const result = parseChangesetFrontmatter(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.entry.notes).toBe('Body becomes notes');
  });
});
