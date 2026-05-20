/**
 * Tests for {@link aggregateChangesetsForRelease} — CLEO-native changesets
 * aggregator (T9753).
 *
 * Covers:
 *  - Empty input → empty markdown
 *  - Mixed kinds → grouped + ordered output
 *  - Breaking entry floats to the top with migration note
 *  - Task IDs rendered as `(T1234)` anchors
 *  - PR numbers appended as `(#42)` anchors when present
 *
 * @task T9753
 * @epic T9752
 */

import type { ChangesetEntry } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { aggregateChangesetsForRelease } from '../changesets-aggregator.js';

/**
 * Build a minimal ChangesetEntry for test fixtures. Overrides win.
 */
function entry(overrides: Partial<ChangesetEntry> & { id: string }): ChangesetEntry {
  return {
    id: overrides.id,
    tasks: overrides.tasks ?? ['T1234'],
    kind: overrides.kind ?? 'feat',
    summary: overrides.summary ?? `Summary for ${overrides.id}`,
    prs: overrides.prs,
    notes: overrides.notes,
    breaking: overrides.breaking,
  } as ChangesetEntry;
}

describe('aggregateChangesetsForRelease', () => {
  it('returns empty markdown + zero count for empty input', () => {
    const result = aggregateChangesetsForRelease({
      entries: [],
      version: 'v2026.6.0',
      date: '2026-05-20',
    });
    expect(result.markdown).toBe('');
    expect(result.entryCount).toBe(0);
    expect(result.kinds.size).toBe(0);
  });

  it('renders 5 mixed-kind entries with grouped section headers + task anchors', () => {
    const entries: ChangesetEntry[] = [
      entry({ id: 'one', kind: 'feat', tasks: ['T9001'], summary: 'New API endpoint.' }),
      entry({ id: 'two', kind: 'fix', tasks: ['T9002'], summary: 'Stop the bleed.' }),
      entry({ id: 'three', kind: 'docs', tasks: ['T9003'], summary: 'Update README.' }),
      entry({ id: 'four', kind: 'refactor', tasks: ['T9004'], summary: 'Untangle.' }),
      entry({ id: 'five', kind: 'chore', tasks: ['T9005'], summary: 'Bump deps.' }),
    ];

    const result = aggregateChangesetsForRelease({
      entries,
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    expect(result.entryCount).toBe(5);
    expect(result.kinds.size).toBe(5);
    expect(result.markdown).toContain('## v2026.6.0 — 2026-05-20');
    expect(result.markdown).toContain('### Features');
    expect(result.markdown).toContain('### Fixes');
    expect(result.markdown).toContain('### Documentation');
    expect(result.markdown).toContain('### Refactors');
    expect(result.markdown).toContain('### Chores');
    // Each summary line includes the task-ID anchor.
    expect(result.markdown).toContain('- New API endpoint. (T9001)');
    expect(result.markdown).toContain('- Stop the bleed. (T9002)');
    expect(result.markdown).toContain('- Update README. (T9003)');
    expect(result.markdown).toContain('- Untangle. (T9004)');
    expect(result.markdown).toContain('- Bump deps. (T9005)');
  });

  it('renders kind sections in canonical order: feat → fix → perf → refactor → docs → test → chore', () => {
    const entries: ChangesetEntry[] = [
      // Intentionally pass in reversed order to verify the renderer reorders.
      entry({ id: 'a', kind: 'chore', tasks: ['T1'], summary: 'chore.' }),
      entry({ id: 'b', kind: 'test', tasks: ['T2'], summary: 'test.' }),
      entry({ id: 'c', kind: 'docs', tasks: ['T3'], summary: 'docs.' }),
      entry({ id: 'd', kind: 'refactor', tasks: ['T4'], summary: 'refactor.' }),
      entry({ id: 'e', kind: 'perf', tasks: ['T5'], summary: 'perf.' }),
      entry({ id: 'f', kind: 'fix', tasks: ['T6'], summary: 'fix.' }),
      entry({ id: 'g', kind: 'feat', tasks: ['T7'], summary: 'feat.' }),
    ];

    const result = aggregateChangesetsForRelease({
      entries,
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    const sections = result.markdown
      .split('\n')
      .filter((line) => line.startsWith('### '))
      .map((line) => line.replace('### ', ''));

    expect(sections).toEqual([
      'Features',
      'Fixes',
      'Performance',
      'Refactors',
      'Documentation',
      'Tests',
      'Chores',
    ]);
  });

  it('floats a breaking entry to the TOP with its migration note rendered inline', () => {
    const entries: ChangesetEntry[] = [
      entry({ id: 'one', kind: 'feat', tasks: ['T1001'], summary: 'New feature.' }),
      entry({
        id: 'two',
        kind: 'breaking',
        tasks: ['T1002'],
        summary: 'Remove legacy API.',
        breaking: 'Callers must switch to the new `v2` endpoint. The old endpoint returns 410.',
      }),
      entry({ id: 'three', kind: 'fix', tasks: ['T1003'], summary: 'Fix race.' }),
    ];

    const result = aggregateChangesetsForRelease({
      entries,
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    // BREAKING section must precede Features section in the output.
    const breakingIdx = result.markdown.indexOf('### BREAKING CHANGES');
    const featuresIdx = result.markdown.indexOf('### Features');
    expect(breakingIdx).toBeGreaterThanOrEqual(0);
    expect(featuresIdx).toBeGreaterThan(breakingIdx);

    // Migration note appears indented under the breaking bullet.
    expect(result.markdown).toContain('  Migration:');
    expect(result.markdown).toContain(
      '  Callers must switch to the new `v2` endpoint. The old endpoint returns 410.',
    );
  });

  it('appends PR anchors after task IDs when present', () => {
    const entries: ChangesetEntry[] = [
      entry({
        id: 'one',
        kind: 'fix',
        tasks: ['T9686-A', 'T9686-B'],
        prs: [324, 325],
        summary: 'Two tasks, two PRs.',
      }),
    ];

    const result = aggregateChangesetsForRelease({
      entries,
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    expect(result.markdown).toContain('- Two tasks, two PRs. (T9686-A) (T9686-B) (#324) (#325)');
  });

  it('appends optional release title to the section header when provided', () => {
    const result = aggregateChangesetsForRelease({
      entries: [entry({ id: 'one', kind: 'feat', summary: 'X.' })],
      version: 'v2026.6.0',
      date: '2026-05-20',
      title: 'June Release',
    });

    expect(result.markdown).toContain('## v2026.6.0 — 2026-05-20 — June Release');
  });

  it('omits the BREAKING section when no breaking entries are present', () => {
    const result = aggregateChangesetsForRelease({
      entries: [entry({ id: 'one', kind: 'feat', summary: 'A feature.' })],
      version: 'v2026.6.0',
      date: '2026-05-20',
    });
    expect(result.markdown).not.toContain('BREAKING');
  });

  it('preserves input order within a kind bucket so on-disk filename ordering survives', () => {
    const entries: ChangesetEntry[] = [
      entry({ id: 'a', kind: 'feat', tasks: ['T1'], summary: 'first feature.' }),
      entry({ id: 'b', kind: 'feat', tasks: ['T2'], summary: 'second feature.' }),
      entry({ id: 'c', kind: 'feat', tasks: ['T3'], summary: 'third feature.' }),
    ];

    const result = aggregateChangesetsForRelease({
      entries,
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    const firstIdx = result.markdown.indexOf('first feature.');
    const secondIdx = result.markdown.indexOf('second feature.');
    const thirdIdx = result.markdown.indexOf('third feature.');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});
