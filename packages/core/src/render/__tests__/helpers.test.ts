/**
 * Tests for the shared --human format helpers introduced as the audit-driven
 * follow-up to T9393. Covers:
 *   - ANSI-aware width math (visibleLength, padVisible, truncateVisible)
 *   - kvBlock colon alignment
 *   - dataTable column sizing + truncation + total-width capping
 *   - pagerFooter visibility rules (suppresses 1-of-1, fires on pagination/filter)
 *   - metaFooter surfaces _nexus + deprecated + duration_ms
 *
 * Migrated from `packages/cleo/src/cli/renderers/__tests__/format-helpers.test.ts`
 * alongside the helpers themselves (T10129 · pure structural move).
 *
 * @task T9393
 * @task T10129
 */

import { describe, expect, it } from 'vitest';
import {
  dataTable,
  kvBlock,
  metaFooter,
  padVisible,
  pagerFooter,
  truncated,
  truncateString,
  truncateVisible,
  visibleLength,
} from '../helpers.js';

describe('visibleLength', () => {
  it('ignores ANSI color escapes', () => {
    expect(visibleLength('\x1b[31mfoo\x1b[0m')).toBe(3);
  });
  it('counts plain text', () => {
    expect(visibleLength('hello')).toBe(5);
  });
});

describe('padVisible / truncateVisible', () => {
  it('pads to visible width preserving ANSI', () => {
    expect(padVisible('\x1b[31mok\x1b[0m', 5)).toBe('\x1b[31mok\x1b[0m   ');
  });
  it('truncates with ellipsis past max', () => {
    expect(truncateVisible('hello world', 8)).toBe('hello w…');
  });
  it('returns string as-is when within max', () => {
    expect(truncateVisible('abc', 8)).toBe('abc');
  });
});

describe('kvBlock', () => {
  it('aligns colons to widest key', () => {
    const out = kvBlock([
      ['Status', 'pending'],
      ['Priority', 'high'],
    ]);
    const lines = out.split('\n');
    // The colon-rendered position should be identical for both lines.
    const stripped = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const colon1 = (stripped[0] ?? '').indexOf(':');
    const colon2 = (stripped[1] ?? '').indexOf(':');
    expect(colon1).toBe(colon2);
    expect(colon1).toBeGreaterThan(0);
  });
  it('returns empty string for empty input', () => {
    expect(kvBlock([])).toBe('');
  });
});

describe('dataTable', () => {
  it('renders header + aligned rows', () => {
    const rows = [
      { id: 'T001', title: 'short' },
      { id: 'T9999', title: 'longer title here' },
    ];
    const out = dataTable(
      rows,
      [
        { header: 'ID', get: (r) => r.id },
        { header: 'Title', get: (r) => r.title },
      ],
      { indent: 0, totalWidth: 100 },
    );
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
    const lines = stripped.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ID\s+Title\s*$/);
    expect(lines[1]).toContain('T001');
    expect(lines[2]).toContain('T9999');
  });

  it('truncates cells past maxWidth with ellipsis', () => {
    const out = dataTable(
      [{ title: 'this title is too long for the column' }],
      [{ header: 'Title', get: (r) => r.title, maxWidth: 12 }],
      { indent: 0, showHeader: false, totalWidth: 50 },
    );
    const stripped = out.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped.length).toBeLessThanOrEqual(12);
    expect(stripped).toContain('…');
  });

  it('returns empty string for empty rows', () => {
    expect(dataTable([], [{ header: 'X', get: () => '' }])).toBe('');
  });
});

describe('pagerFooter', () => {
  it('suppresses footer when payload is complete and no filter is active', () => {
    expect(pagerFooter({ shown: 5, page: { total: 5 } })).toBe('');
    expect(pagerFooter({ shown: 5, total: 5 })).toBe('');
  });

  it('fires when hasMore is true', () => {
    const out = pagerFooter({
      shown: 3,
      page: { mode: 'offset', limit: 3, offset: 0, hasMore: true, total: 100 },
    });
    expect(out).toContain('3 of 100');
    expect(out).toContain('--limit 3');
    expect(out).toContain('--json for full set');
  });

  it('fires when filtered differs from total', () => {
    const out = pagerFooter({ shown: 10, total: 10, filtered: 7 });
    expect(out).toContain('7 after filter');
  });
});

describe('metaFooter', () => {
  it('returns empty string for empty/undefined meta', () => {
    expect(metaFooter(undefined)).toBe('');
    expect(metaFooter({})).toBe('');
  });

  it('renders _nexus scope chip', () => {
    const out = metaFooter({
      _nexus: { scope: 'project', projectName: 'cleocode' },
      duration_ms: 42,
    });
    expect(out).toContain('scope=project');
    expect(out).toContain('project=cleocode');
    expect(out).toContain('42 ms');
  });

  it('truncates long projectId slug', () => {
    const out = metaFooter({
      _nexus: { scope: 'project', projectId: 'L21udC9wcm9qZWN0cy9jbGVvY29kZQ' },
    });
    // Slug truncates to 13 chars + ellipsis (see metaFooter implementation).
    expect(out).toMatch(/project=L21udC9wcm9qZ…/);
  });

  it('renders deprecated warning with replacement', () => {
    const out = metaFooter({
      deprecated: {
        since: 'v2026.6.5',
        removeIn: 'v2026.8.0',
        replacement: 'cleo graph context',
      },
    });
    expect(out).toContain('deprecated');
    expect(out).toContain('since v2026.6.5');
    expect(out).toContain('cleo graph context');
  });

  it('suppresses 0 ms duration chip', () => {
    const out = metaFooter({ _nexus: { scope: 'project' }, duration_ms: 0 });
    expect(out).not.toContain('0 ms');
  });
});

describe('truncated', () => {
  it('returns full array when within max', () => {
    const r = truncated([1, 2, 3], 5);
    expect(r.items).toEqual([1, 2, 3]);
    expect(r.footer).toBe('');
  });

  it('slices and emits footer summary when over max', () => {
    const r = truncated([1, 2, 3, 4, 5, 6, 7, 8], 3);
    expect(r.items).toEqual([1, 2, 3]);
    expect(r.footer).toContain('and 5 more');
  });
});

describe('truncateString (T11353 — shared scalar-string truncation SSoT)', () => {
  it('returns the string unchanged when within max', () => {
    expect(truncateString('hello', 5)).toBe('hello');
    expect(truncateString('hi', 10)).toBe('hi');
  });

  it('truncates with a single-glyph ellipsis, length never exceeds max', () => {
    const out = truncateString('a very long title', 8);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(8);
    expect(out).toBe('a very …'.slice(0, 7) + '…');
  });

  it('honors a custom ASCII ellipsis (parity with cleo-startup style)', () => {
    const out = truncateString('a very long title', 8, '...');
    expect(out.endsWith('...')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(8);
  });

  it('collapses null / undefined / empty to an empty string', () => {
    expect(truncateString(null, 10)).toBe('');
    expect(truncateString(undefined, 10)).toBe('');
    expect(truncateString('', 10)).toBe('');
  });

  it('returns empty for non-positive max', () => {
    expect(truncateString('abc', 0)).toBe('');
    expect(truncateString('abc', -1)).toBe('');
  });

  it('hard-slices when the ellipsis alone would overflow the budget', () => {
    // ellipsis '...' (len 3) cannot fit in max=2 → hard slice.
    expect(truncateString('abcdef', 2, '...')).toBe('ab');
  });

  it('matches the legacy slice(0, max-1)+… behavior of the replaced helpers', () => {
    // The output-mode / briefing / public-api helpers all did this.
    expect(truncateString('abcdef', 4)).toBe('abc…');
  });
});
