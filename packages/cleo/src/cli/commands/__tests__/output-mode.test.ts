/**
 * Unit tests for the `--output {envelope|id|table|count|silent}` flag
 * renderer (T9930 · Saga T9855 · E9.3).
 *
 * Exercises {@link renderOutputMode} directly against representative
 * envelope shapes (single-task add/show, list of tasks, generic
 * ListResponse, bare id payloads). Subprocess end-to-end coverage is
 * provided by the stdout-discipline integration suite under
 * `packages/cleo/__tests__/integration/`.
 *
 * @task T9930
 * @epic T9855
 */

import { describe, expect, it } from 'vitest';
import { renderOutputMode, renderSummary } from '../../renderers/output-mode.js';

describe('renderOutputMode — id', () => {
  it('extracts id from a single-task envelope ({task: {id}})', () => {
    const out = renderOutputMode('id', { task: { id: 'T9930', title: 'x', priority: 'medium' } });
    expect(out.text).toBe('T9930');
  });

  it('extracts ids from a list envelope ({tasks: [...]})', () => {
    const out = renderOutputMode('id', {
      tasks: [
        { id: 'T1', title: 'a' },
        { id: 'T2', title: 'b' },
        { id: 'T3', title: 'c' },
      ],
      total: 3,
    });
    expect(out.text).toBe('T1\nT2\nT3');
  });

  it('extracts ids from a generic ListResponse ({items: [...]})', () => {
    const out = renderOutputMode('id', {
      items: [{ id: 'A1' }, { id: 'A2' }],
    });
    expect(out.text).toBe('A1\nA2');
  });

  it('falls back to bare {id: ...}', () => {
    const out = renderOutputMode('id', { id: 'S-42' });
    expect(out.text).toBe('S-42');
  });

  it('emits NOTHING (not prose) for an unrecognised shape, with a typed reason', () => {
    // gh#1317: `--output id` is contracted to one ID per line, so an empty
    // result must be an EMPTY STREAM. This previously returned the sentence
    // `No ids.`, which a `while read` loop consumes as the ids `No` and `ids.`.
    const out = renderOutputMode('id', { value: 7, foo: 'bar' });
    expect(out.text).toBe('');
    expect(out.text).not.toContain('No ids');
    expect(out.emptyReason).toBe('no-renderable-ids');
  });

  it('skips list entries that lack an id', () => {
    const out = renderOutputMode('id', {
      tasks: [{ id: 'T1' }, { title: 'no-id' }, { id: 'T3' }],
    });
    expect(out.text).toBe('T1\nT3');
  });
});

describe('renderOutputMode — count', () => {
  // (T10599) When a listing carries no distinct `filtered` field, `total` wins
  // over the returned-rows length. This preserves the documented pagination
  // contract: a page of 2 returned rows out of a 17-match read reports 17.
  it('honours explicit `total` over array length', () => {
    const out = renderOutputMode('count', {
      tasks: [{ id: 'T1' }, { id: 'T2' }],
      total: 17,
    });
    expect(out.text).toBe('17');
  });

  // (T11481 · DHQ-034) Filtered-vs-total semantic. A `tasks.list` envelope is
  // `{tasks, total, filtered}` where `total` is the GLOBAL project task count
  // and `filtered` is the filter-aware match count. `--output count` on a
  // filtered listing (`list --parent X`, `list --status Y`) MUST report the
  // FILTERED match count — not the global total.
  it('(T11481) prefers `filtered` over the global `total` for a filtered listing', () => {
    const out = renderOutputMode('count', {
      tasks: [{ id: 'T1' }, { id: 'T2' }],
      total: 2554, // global project task count
      filtered: 19, // filter-aware match count
    });
    expect(out.text).toBe('19');
  });

  // (T11481 · DHQ-034) Pagination must NOT be confused with the match count.
  // A Saga `bindingSource:'saga.groups'` page can bind `tasks.length=10` while
  // `filtered=19`; count mode reports the match count (19), not the page size.
  it('(T11481) prefers `filtered` over the returned-rows length under pagination', () => {
    const out = renderOutputMode('count', {
      tasks: Array.from({ length: 10 }, (_, i) => ({ id: `T${i}` })),
      total: 2554,
      filtered: 19,
      bindingSource: 'saga.groups',
    });
    expect(out.text).toBe('19');
  });

  it('(T10599 AC1) honours minimal mutate `count` for dry-run add-batch output', () => {
    const out = renderOutputMode('count', {
      count: 3,
      created: ['T???', 'T???', 'T???'],
      ids: ['T???', 'T???', 'T???'],
      dryRun: true,
      wouldCreate: 3,
      insertedCount: 0,
      validatedCount: 3,
    });

    expect(out.text).toBe('3');
  });

  it('(T10599 AC1) prefers paginated `total` over mutate-style `count` when both exist', () => {
    const out = renderOutputMode('count', {
      total: 17,
      count: 3,
      tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
    });

    expect(out.text).toBe('17');
  });

  it('falls back to tasks.length when total is missing', () => {
    const out = renderOutputMode('count', {
      tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
    });
    expect(out.text).toBe('3');
  });

  it('counts items[] when no tasks key is present', () => {
    const out = renderOutputMode('count', { items: [{ id: 'A' }, { id: 'B' }] });
    expect(out.text).toBe('2');
  });

  it('reports 1 for a single-task envelope', () => {
    const out = renderOutputMode('count', { task: { id: 'X' } });
    expect(out.text).toBe('1');
  });

  it('reports 0 for an unrecognised shape', () => {
    const out = renderOutputMode('count', { foo: 'bar' });
    expect(out.text).toBe('0');
  });
});

describe('renderOutputMode — table', () => {
  it('renders a list of tasks as id/status/priority/title columns', () => {
    const out = renderOutputMode('table', {
      tasks: [
        { id: 'T1', status: 'pending', priority: 'high', title: 'Short title' },
        { id: 'T2', status: 'in_progress', priority: 'medium', title: 'Another' },
      ],
    });
    const text = out.text ?? '';
    expect(text).toContain('id');
    expect(text).toContain('status');
    expect(text).toContain('priority');
    expect(text).toContain('title');
    expect(text).toContain('T1');
    expect(text).toContain('pending');
    expect(text).toContain('high');
    expect(text).toContain('Short title');
    expect(text).toContain('T2');
    expect(text).toContain('in_progress');
  });

  it('truncates titles longer than 60 chars with an ellipsis', () => {
    const longTitle = 'a'.repeat(80);
    const out = renderOutputMode('table', {
      tasks: [{ id: 'T1', status: 'pending', priority: 'high', title: longTitle }],
    });
    const text = out.text ?? '';
    // Truncated form ends with ellipsis; the raw 80-char string MUST NOT
    // appear (otherwise the truncation cap is broken).
    expect(text).not.toContain(longTitle);
    expect(text).toContain('…');
  });

  it('falls back to a generic field/value table for non-list payloads', () => {
    const out = renderOutputMode('table', { sessionId: 'sess-1', activeTask: 'T9930' });
    const text = out.text ?? '';
    expect(text).toContain('field');
    expect(text).toContain('value');
    expect(text).toContain('sessionId');
    expect(text).toContain('sess-1');
    expect(text).toContain('activeTask');
    expect(text).toContain('T9930');
  });

  it('emits NOTHING for an empty list — TSV with zero rows is zero bytes', () => {
    // gh#1317, the `--output table` half: prose in a TSV stream is as wrong as
    // prose in an ID stream, and the issue only named the ID case.
    const out = renderOutputMode('table', { tasks: [] });
    expect(out.text).toBe('');
    expect(out.text).not.toContain('No rows');
    expect(out.emptyReason).toBe('no-renderable-records');
  });
});

describe('renderOutputMode — silent', () => {
  it('returns null text (caller must NOT write to stdout)', () => {
    const out = renderOutputMode('silent', {
      tasks: [{ id: 'T1' }, { id: 'T2' }],
      total: 2,
    });
    expect(out.text).toBeNull();
    expect(out.emptyReason).toBe('silent-mode');
  });

  it('returns null even for a single-record envelope', () => {
    const out = renderOutputMode('silent', { task: { id: 'X' } });
    expect(out.text).toBeNull();
    expect(out.emptyReason).toBe('silent-mode');
  });
});

describe('renderOutputMode — envelope', () => {
  it('throws E_RENDERER_UNSUPPORTED — envelope mode must be handled by the caller', () => {
    expect(() => renderOutputMode('envelope', { task: { id: 'T1' } })).toThrow(
      /Unsupported output renderer: envelope/,
    );
    try {
      renderOutputMode('bogus' as never, { task: { id: 'T1' } });
      throw new Error('expected renderOutputMode to throw');
    } catch (err) {
      expect((err as { code?: string }).code).toBe('E_RENDERER_UNSUPPORTED');
    }
  });
});

// ---------------------------------------------------------------------------
// T12067 — `results`-shaped envelopes (`cleo find`)
// ---------------------------------------------------------------------------

describe('renderOutputMode — {results: [...]} envelopes (T12067)', () => {
  /**
   * The exact shape `tasks.find` emits: a `results` array beside a
   * pre-pagination `total`. Before T12067 only `total` was recognised, so
   * `--output count` reported a non-zero number while `id`/`table`/`summary`
   * all reported empty against the SAME payload.
   */
  const findEnvelope = {
    results: [
      { id: 'T9911', title: 'cleo saga tree <id> recursive hierarchy', status: 'pending' },
      { id: 'T9849', title: 'Feature gh-404: cleo saga tree <id>', status: 'done' },
    ],
    total: 2,
  };

  it('extracts ids from a find envelope', () => {
    expect(renderOutputMode('id', findEnvelope).text).toBe('T9911\nT9849');
  });

  it('renders a find envelope as a table', () => {
    const out = renderOutputMode('table', findEnvelope).text ?? '';
    expect(out).toContain('T9911');
    expect(out).toContain('T9849');
    expect(out).not.toBe('No rows.');
  });

  it('renders a find envelope as a summary', () => {
    const out = renderSummary(findEnvelope).text ?? '';
    expect(out).toContain('T9911 [pending]');
    expect(out).toContain('T9849 [done]');
  });

  it('counts a find envelope from its explicit total', () => {
    expect(renderOutputMode('count', findEnvelope).text).toBe('2');
  });

  it('never disagrees across modes — count>0 implies id/table/summary non-empty', () => {
    const count = Number(renderOutputMode('count', findEnvelope).text);
    expect(count).toBeGreaterThan(0);
    for (const mode of ['id', 'table'] as const) {
      const out = renderOutputMode(mode, findEnvelope);
      expect(out.emptyReason, `${mode} must not be empty when count=${count}`).toBeUndefined();
    }
    expect(renderSummary(findEnvelope).emptyReason).toBeUndefined();
  });

  it('falls back to the results length when no total is present', () => {
    expect(renderOutputMode('count', { results: [{ id: 'A' }, { id: 'B' }] }).text).toBe('2');
  });

  it('reports empty for a genuinely empty result set — via emptyReason, not prose', () => {
    // The reason survives; only its DESTINATION changes. `--output count`
    // already answered `0` for this same query, which is the asymmetry that
    // made the defect visible (gh#1317).
    const out = renderOutputMode('id', { results: [], total: 0 });
    expect(out.text).toBe('');
    expect(out.emptyReason).toBe('no-renderable-ids');
  });

  it('prefers tasks over results when an envelope carries both', () => {
    const out = renderOutputMode('id', { tasks: [{ id: 'T1' }], results: [{ id: 'R1' }] });
    expect(out.text).toBe('T1');
  });
});

// ---------------------------------------------------------------------------
// T12077 — {suggestions: [...]} envelopes (`cleo next`)
// ---------------------------------------------------------------------------

describe('renderOutputMode — {suggestions: [...]} envelopes (T12077)', () => {
  /**
   * The exact shape `tasks.next` emits. `suggestions` was absent from the
   * renderer's LOCAL key list even after T12067 added `results`, so
   * `cleo next --output id` reported "No ids." against an envelope holding
   * 836 candidates. The list now comes from the contracts SSoT.
   */
  const nextEnvelope = {
    suggestions: [
      { id: 'T12034', title: 'CI shard-2: eliminate BRAIN writer flakes', status: 'pending' },
      { id: 'T1738', title: 'Design CleoOS harness architecture', status: 'pending' },
    ],
    totalCandidates: 836,
  };

  it('extracts ids from a next envelope', () => {
    expect(renderOutputMode('id', nextEnvelope).text).toBe('T12034\nT1738');
  });

  it('renders a next envelope as a table', () => {
    const out = renderOutputMode('table', nextEnvelope).text ?? '';
    expect(out).toContain('T12034');
    expect(out).not.toBe('No rows.');
  });

  it('renders a next envelope as a summary', () => {
    expect(renderSummary(nextEnvelope).text ?? '').toContain('T12034 [pending]');
  });

  it('never disagrees across modes for a next envelope', () => {
    for (const mode of ['id', 'table'] as const) {
      expect(renderOutputMode(mode, nextEnvelope).emptyReason, mode).toBeUndefined();
    }
    expect(renderSummary(nextEnvelope).emptyReason).toBeUndefined();
  });
});
