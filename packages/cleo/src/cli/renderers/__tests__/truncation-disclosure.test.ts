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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setFormatContext } from '../../format-context.js';
import { setOutputMode } from '../../output-context.js';
import { cliOutput } from '../index.js';
import {
  detectTruncation,
  formatTaskPopulation,
  formatTruncationWarning,
  renderOutputMode,
} from '../output-mode.js';

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
  it('names the counts and the remedy the CALLING COMMAND actually has', () => {
    const text = formatTruncationWarning({ returned: 10, total: 1075 }, 'id', '--all');
    expect(text).toContain('TRUNCATED');
    expect(text).toContain('--output id returned 10 of 1075 matching rows');
    expect(text).toContain('--all');
  });

  /**
   * The previous revision of the test above asserted `--all` and `--limit 0`
   * UNCONDITIONALLY, which pinned a defect rather than a behaviour.
   *
   * This warning is emitted from the generic `cliOutput`, which every command
   * reaches — `cleo find` included. On `find` both halves of that advice are
   * wrong: no `all` arg is declared, and `--limit 0` is `slice(0, 0)`, i.e.
   * ZERO rows. Worse in composition: once the unknown-flag guard lands, the
   * suggested `--all` becomes a hard E_UNKNOWN_FLAG exit — the CLI refusing the
   * invocation it had just printed.
   *
   * So the remedy is supplied by the command that owns the flag, and a command
   * that does not own one gets paging advice that is true everywhere.
   */
  it('never names --all when the command did not declare it', () => {
    const text = formatTruncationWarning({ returned: 20, total: 260 }, 'id');
    expect(text).toContain('TRUNCATED');
    expect(text).toContain('--output id returned 20 of 260 matching rows');
    expect(text).not.toContain('--all');
    expect(text).toContain('--limit');
    expect(text).toContain('--offset');
  });

  it('never suggests --limit 0, which means "zero rows" on find', () => {
    expect(formatTruncationWarning({ returned: 20, total: 260 }, 'id')).not.toContain('--limit 0');
    expect(formatTruncationWarning({ returned: 10, total: 1075 }, 'id', '--all')).not.toContain(
      '--limit 0',
    );
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

describe('canonical population render parity (T12200)', () => {
  it('count equals emitted IDs and table rows while total matched remains explicit', () => {
    const data = {
      tasks: [
        { id: 'T1', title: 'one' },
        { id: 'T2', title: 'two' },
      ],
      total: 99,
      filtered: 13,
      population: {
        matched: 13,
        returned: 2,
        truncated: true,
        limit: 2,
        offset: 0,
        archive: 'excluded',
      },
    };
    expect(renderOutputMode('count', data).text).toBe('2');
    expect(renderOutputMode('id', data).text).toBe('T1\nT2');
    expect(renderOutputMode('table', data).text).toContain('T1');
    expect(renderOutputMode('table', data).text).toContain('T2');
    expect(detectTruncation(data)).toEqual({ returned: 2, total: 13 });
    expect(formatTaskPopulation(data)).toBe(
      'cleo: population matched=13 returned=2 truncated=true archive=excluded limit=2 offset=0',
    );
  });
  it('empty pages disclose existing matches and archive scope', () => {
    const data = {
      results: [],
      total: 4,
      population: {
        matched: 4,
        returned: 0,
        truncated: true,
        limit: null,
        offset: 9,
        archive: 'included',
      },
    };
    expect(renderOutputMode('count', data).text).toBe('0');
    expect(formatTaskPopulation(data)).toContain(
      'matched=4 returned=0 truncated=true archive=included limit=all offset=9',
    );
  });
});

describe('population disclosure at the actual renderer funnel', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setOutputMode('envelope');
    setFormatContext({ format: 'json', source: 'default', quiet: false });
  });
  it.each([
    'id',
    'count',
    'table',
    'silent',
    'human',
  ] as const)('preserves population on %s without polluting stdout', (mode) => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    if (mode === 'human') setFormatContext({ format: 'human', source: 'flag', quiet: false });
    else setOutputMode(mode);
    cliOutput(
      {
        tasks: [{ id: 'T1', title: 'one', status: 'pending', priority: 'medium' }],
        total: 30,
        filtered: 3,
        population: {
          matched: 3,
          returned: 1,
          truncated: true,
          archive: 'excluded',
          limit: 1,
          offset: 0,
        },
      },
      { command: 'list', operation: 'tasks.list' },
    );
    expect(stderr.mock.calls.flat().join('')).toContain(
      'population matched=3 returned=1 truncated=true archive=excluded',
    );
    expect(stdout.mock.calls.flat().join('')).not.toContain('population matched=');
  });
  it.each([
    'id',
    'count',
    'table',
    'silent',
    'human',
  ] as const)('explains explicit fuzzy row identity and fields on %s', (mode) => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    if (mode === 'human') setFormatContext({ format: 'human', source: 'flag', quiet: false });
    else setOutputMode(mode);
    cliOutput(
      {
        results: [
          {
            id: 'T7',
            title: 'unrelated',
            status: 'pending',
            match: {
              kind: 'fuzzy',
              fields: ['description'],
              terms: [],
              reason: 'Explicit subsequence',
            },
          },
        ],
        total: 1,
        searchType: 'fuzzy',
      },
      { command: 'find', operation: 'tasks.find' },
    );
    expect(stderr.mock.calls.flat().join('')).toContain('searchType=fuzzy');
    expect(stderr.mock.calls.flat().join('')).toContain(
      'match id=T7 kind=fuzzy fields=description',
    );
  });
});
