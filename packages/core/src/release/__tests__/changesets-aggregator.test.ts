/**
 * Tests for deterministic zero-token release-note rendering.
 *
 * @task T9753
 * @task T10471
 */

import type { ChangesetEntry } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { aggregateChangesetsForRelease } from '../changesets-aggregator.js';

function entry(overrides: Partial<ChangesetEntry> & { id: string }): ChangesetEntry {
  return {
    id: overrides.id,
    tasks: overrides.tasks ?? ['T1234'],
    kind: overrides.kind ?? 'feat',
    summary: overrides.summary ?? `Summary for ${overrides.id}`,
    prs: overrides.prs,
    notes: overrides.notes,
    breaking: overrides.breaking,
    releaseNotes: overrides.releaseNotes,
  } as ChangesetEntry;
}

function renderedSections(markdown: string): string[] {
  return markdown
    .split('\n')
    .filter((line) => line.startsWith('### '))
    .map((line) => line.replace('### ', ''));
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

  it('renders strict release-note sections in deterministic Keep-a-Changelog order', () => {
    const result = aggregateChangesetsForRelease({
      entries: [
        entry({ id: 'fix', kind: 'fix', tasks: ['T9002'], summary: 'Stop the bleed.' }),
        entry({ id: 'feat', kind: 'feat', tasks: ['T9001'], summary: 'New API endpoint.' }),
        entry({ id: 'docs', kind: 'docs', tasks: ['T9003'], summary: 'Update README.' }),
      ],
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    expect(result.entryCount).toBe(3);
    expect(result.kinds.size).toBe(3);
    expect(result.markdown).toContain('## v2026.6.0 — 2026-05-20');
    expect(renderedSections(result.markdown)).toEqual([
      'Added',
      'Changed',
      'Fixed',
      'Deprecated',
      'Removed',
      'Security',
      'BREAKING CHANGES',
    ]);
    expect(result.markdown).toContain('- New API endpoint. _(provenance: [T9001](');
    expect(result.markdown).toContain('- Stop the bleed. _(provenance: [T9002](');
    expect(result.markdown).toContain('- Update README. _(provenance: [T9003](');
  });

  it('uses releaseNotes metadata for section, target, impact, migration, and inclusion', () => {
    const result = aggregateChangesetsForRelease({
      entries: [
        entry({
          id: 'security-note',
          kind: 'fix',
          tasks: ['T10471'],
          prs: [431],
          summary: 'Fallback summary.',
          releaseNotes: {
            section: 'security',
            targets: ['@cleocode/core'],
            impact: 'Renderer emits operator-safe deterministic release notes.',
            migration: 'No migration required.',
          },
        }),
        entry({
          id: 'hidden',
          kind: 'chore',
          tasks: ['T9999'],
          summary: 'Internal-only cleanup.',
          releaseNotes: { includeInChangelog: false },
        }),
      ],
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    expect(result.entryCount).toBe(1);
    expect(result.markdown).toContain(
      '- **@cleocode/core:** Renderer emits operator-safe deterministic release notes.',
    );
    expect(result.markdown).toContain(
      '_(provenance: [T10471](https://github.com/kryptobaseddev/cleo/search?q=T10471&type=commits); [#431](https://github.com/kryptobaseddev/cleo/pull/431))_',
    );
    expect(result.markdown).not.toContain('Internal-only cleanup.');
  });

  it('renders breaking entries in the strict BREAKING CHANGES section with migration text', () => {
    const result = aggregateChangesetsForRelease({
      entries: [
        entry({ id: 'feat', kind: 'feat', tasks: ['T1001'], summary: 'New feature.' }),
        entry({
          id: 'breaking',
          kind: 'breaking',
          tasks: ['T1002'],
          summary: 'Remove legacy API.',
          breaking: 'Callers must switch to the new `v2` endpoint. The old endpoint returns 410.',
        }),
      ],
      version: 'v2026.6.0',
      date: '2026-05-20',
    });

    const breakingIdx = result.markdown.indexOf('### BREAKING CHANGES');
    const featureIdx = result.markdown.indexOf('New feature.');
    expect(breakingIdx).toBeGreaterThan(featureIdx);
    expect(result.markdown).toContain('  Migration:');
    expect(result.markdown).toContain(
      '  Callers must switch to the new `v2` endpoint. The old endpoint returns 410.',
    );
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

  it('preserves input order within a section bucket so on-disk filename ordering survives', () => {
    const result = aggregateChangesetsForRelease({
      entries: [
        entry({ id: 'a', kind: 'feat', tasks: ['T1'], summary: 'first feature.' }),
        entry({ id: 'b', kind: 'feat', tasks: ['T2'], summary: 'second feature.' }),
        entry({ id: 'c', kind: 'feat', tasks: ['T3'], summary: 'third feature.' }),
      ],
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
