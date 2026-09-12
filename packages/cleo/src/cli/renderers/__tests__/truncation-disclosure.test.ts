/**
 * Truncation disclosure for the enumeration render modes (T12123 · GH #1242).
 *
 * `cleo list --status pending --output count` reported 1075 while
 * `--output id` returned 10 for the same query, seconds apart, with no
 * `_truncated`, no `hasMore`, no `nextCursor`, and nothing on stderr — so a
 * page was indistinguishable from the whole set.
 *
 * Neither number was wrong: `count` is the filter-aware match count by design
 * (T11481 · DHQ-034) and the default page size is 10. The defect was that the
 * enumeration modes discarded the `page` metadata the envelope already carried.
 *
 * @task T12123
 */

import { describe, expect, it } from 'vitest';
import { detectTruncation, formatTruncationWarning } from '../output-mode.js';

/** The measured shape from the bug report: 10 of 1075 pending tasks. */
const TRUNCATED = {
  data: {
    tasks: Array.from({ length: 10 }, (_, i) => ({ id: `T${i + 1}`, title: `t${i}` })),
    total: 3173,
    filtered: 1075,
  },
  page: { mode: 'offset', limit: 10, offset: 0, hasMore: true, total: 1075 },
};

describe('detectTruncation (T12123)', () => {
  it('detects the reported 10-of-1075 skew', () => {
    expect(detectTruncation(TRUNCATED.data, TRUNCATED.page)).toEqual({
      returned: 10,
      total: 1075,
    });
  });

  it('prefers the envelope page over the payload counts', () => {
    const facts = detectTruncation(
      { tasks: [{ id: 'T1' }], filtered: 5 },
      {
        mode: 'offset',
        limit: 1,
        offset: 0,
        hasMore: true,
        total: 9,
      },
    );
    expect(facts).toEqual({ returned: 1, total: 9 });
  });

  it('falls back to `filtered` when no page is supplied, so the warning can never contradict --output count', () => {
    // `filtered` is the exact field `--output count` prints (extractCount).
    expect(detectTruncation(TRUNCATED.data)).toEqual({ returned: 10, total: 1075 });
  });

  it('reports nothing for a complete result', () => {
    expect(
      detectTruncation({ tasks: [{ id: 'T1' }, { id: 'T2' }], total: 2, filtered: 2 }),
    ).toBeNull();
  });

  it('reports nothing for an empty result', () => {
    expect(detectTruncation({ tasks: [], total: 0, filtered: 0 })).toBeNull();
  });

  it('does not treat the global `total` as the match count when `filtered` is present', () => {
    // `total` is every task in the project; `filtered` is what the query
    // matched. Using `total` would warn on every filtered query that excluded
    // anything — crying wolf until the warning is ignored.
    expect(detectTruncation({ tasks: [{ id: 'T1' }], total: 3173, filtered: 1 })).toBeNull();
  });

  it('uses `total` only when there is no filter dimension', () => {
    expect(detectTruncation({ items: [{ id: 'A' }], total: 4 })).toEqual({
      returned: 1,
      total: 4,
    });
  });

  it('ignores non-collection payloads', () => {
    expect(detectTruncation({ task: { id: 'T1' } })).toBeNull();
    expect(detectTruncation(null)).toBeNull();
    expect(detectTruncation('nope')).toBeNull();
  });

  it('does not warn when a page says hasMore but the totals do not exceed what was returned', () => {
    const facts = detectTruncation(
      { tasks: [{ id: 'T1' }] },
      {
        mode: 'offset',
        limit: 1,
        offset: 0,
        hasMore: true,
        total: 1,
      },
    );
    expect(facts).toBeNull();
  });
});

describe('formatTruncationWarning (T12123)', () => {
  it('names the counts and the exact remedy', () => {
    const text = formatTruncationWarning({ returned: 10, total: 1075 }, 'id');
    expect(text).toContain('TRUNCATED');
    expect(text).toContain('--output id returned 10 of 1075 matching rows');
    expect(text).toContain('--all');
    expect(text).toContain('--limit 0');
  });

  it('names --summary correctly rather than as an --output value', () => {
    expect(formatTruncationWarning({ returned: 10, total: 1075 }, 'summary')).toContain(
      '--summary returned 10 of 1075',
    );
  });

  it('names table mode', () => {
    expect(formatTruncationWarning({ returned: 2, total: 40 }, 'table')).toContain(
      '--output table returned 2 of 40',
    );
  });
});
