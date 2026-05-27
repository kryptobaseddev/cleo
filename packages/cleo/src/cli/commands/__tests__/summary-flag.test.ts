/**
 * Unit tests for the `--summary` flag (T9932 · Saga T9855 · E9.5).
 *
 * Two layers:
 *  1. {@link renderSummary} direct — representative envelope shapes
 *     (single-task `cleo show`, list of tasks `cleo list`, generic SDK
 *     ListResponse, bare id payloads).
 *  2. `cliOutput` precedence — confirm `--summary` composes with the four
 *     `--output` modes from T9930 per the precedence rules in
 *     `summary-context.ts`:
 *       `--field`           > `--output non-envelope` > `--summary`
 *
 * @task T9932
 * @epic T9855
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFieldContext } from '../../field-context.js';
import { setFormatContext } from '../../format-context.js';
import { setOutputMode } from '../../output-context.js';
import { cliOutput } from '../../renderers/index.js';
import { renderSummary } from '../../renderers/output-mode.js';
import { setSummaryMode } from '../../summary-context.js';

// ---------------------------------------------------------------------------
// renderSummary — direct
// ---------------------------------------------------------------------------

describe('renderSummary — single record', () => {
  it('renders a single-task envelope ({task: {id, status, title}})', () => {
    const out = renderSummary({
      task: { id: 'T9932', status: 'in_progress', title: 'Summary flag' },
    });
    expect(out.text).toBe('T9932 [in_progress] Summary flag');
  });

  it('renders a bare record envelope ({id, status, title})', () => {
    const out = renderSummary({ id: 'S-42', status: 'pending', title: 'Bare' });
    expect(out.text).toBe('S-42 [pending] Bare');
  });

  it('uses empty brackets when status is missing', () => {
    const out = renderSummary({ task: { id: 'T1', title: 'No status' } });
    expect(out.text).toBe('T1 [] No status');
  });

  it('uses empty trailing slot when title is missing', () => {
    const out = renderSummary({ task: { id: 'T1', status: 'done' } });
    expect(out.text).toBe('T1 [done] ');
  });
});

describe('renderSummary — list', () => {
  it('renders one line per task in a {tasks: []} envelope', () => {
    const out = renderSummary({
      tasks: [
        { id: 'T1', status: 'pending', title: 'first' },
        { id: 'T2', status: 'in_progress', title: 'second' },
        { id: 'T3', status: 'done', title: 'third' },
      ],
      total: 3,
    });
    expect(out.text).toBe('T1 [pending] first\nT2 [in_progress] second\nT3 [done] third');
  });

  it('renders one line per item in a generic ListResponse ({items: []})', () => {
    const out = renderSummary({
      items: [
        { id: 'A1', status: 'pending', title: 'alpha' },
        { id: 'A2', status: 'done', title: 'beta' },
      ],
    });
    expect(out.text).toBe('A1 [pending] alpha\nA2 [done] beta');
  });

  it('skips list entries that lack an id (consistent with --output id)', () => {
    const out = renderSummary({
      tasks: [
        { id: 'T1', status: 'pending', title: 'first' },
        { status: 'orphan', title: 'no-id' },
        { id: 'T3', status: 'done', title: 'third' },
      ],
    });
    expect(out.text).toBe('T1 [pending] first\nT3 [done] third');
  });

  it('returns "No rows." for an empty {tasks: []}', () => {
    const out = renderSummary({ tasks: [] });
    expect(out.text).toBe('No rows.');
  });

  it('returns "No rows." when no rows in a list survive id-filtering', () => {
    const out = renderSummary({
      tasks: [{ status: 'orphan', title: 'a' }, { title: 'b' }],
    });
    expect(out.text).toBe('No rows.');
  });
});

describe('renderSummary — title truncation', () => {
  it('truncates titles longer than 60 chars with a trailing ellipsis', () => {
    const longTitle = 'x'.repeat(80);
    const out = renderSummary({ task: { id: 'T1', status: 'pending', title: longTitle } });
    expect(out.text).not.toContain(longTitle);
    expect(out.text).toContain('…');
    // Per renderSummaryRow contract: `<id> [<status>] <title-truncated-60>`.
    // truncate keeps max-1 chars + '…' when shortened, so the title cell is
    // exactly 60 chars wide (59 'x' + '…').
    const expectedTitleCell = 'x'.repeat(59) + '…';
    expect(out.text).toBe(`T1 [pending] ${expectedTitleCell}`);
  });

  it('leaves titles of exactly 60 chars untouched (no ellipsis)', () => {
    const sixtyChar = 'y'.repeat(60);
    const out = renderSummary({ task: { id: 'T1', status: 'done', title: sixtyChar } });
    expect(out.text).toBe(`T1 [done] ${sixtyChar}`);
    expect(out.text).not.toContain('…');
  });
});

describe('renderSummary — unrecognised shapes', () => {
  it('returns typed empty reason text for an object with no id / tasks / items / task key', () => {
    const out = renderSummary({ foo: 'bar', count: 7 });
    expect(out.text).toBe('No rows.');
    expect(out.emptyReason).toBe('no-renderable-records');
  });

  it('returns typed empty reason text for null', () => {
    const out = renderSummary(null);
    expect(out.text).toBe('No rows.');
    expect(out.emptyReason).toBe('no-renderable-records');
  });

  it('returns typed empty reason text for primitive data', () => {
    expect(renderSummary('a-string')).toMatchObject({
      text: 'No rows.',
      emptyReason: 'no-renderable-records',
    });
    expect(renderSummary(42)).toMatchObject({
      text: 'No rows.',
      emptyReason: 'no-renderable-records',
    });
  });
});

// ---------------------------------------------------------------------------
// cliOutput precedence — confirm --summary composes with --output modes
// ---------------------------------------------------------------------------

describe('cliOutput — --summary precedence with --output modes', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    // JSON format keeps the render path predictable (no human chrome).
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    setFieldContext({ mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });
    setOutputMode('envelope');
    setSummaryMode(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    setOutputMode('envelope');
    setSummaryMode(false);
  });

  function captured(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  it('--summary alone renders 1-line-per-record (envelope mode default)', () => {
    setSummaryMode(true);
    cliOutput(
      { task: { id: 'T9932', status: 'in_progress', title: 'Summary flag' } },
      { command: 'show' },
    );
    expect(captured()).toBe('T9932 [in_progress] Summary flag\n');
  });

  it('--summary list emits one line per task', () => {
    setSummaryMode(true);
    cliOutput(
      {
        tasks: [
          { id: 'T1', status: 'pending', title: 'first' },
          { id: 'T2', status: 'done', title: 'second' },
        ],
        total: 2,
      },
      { command: 'list' },
    );
    expect(captured()).toBe('T1 [pending] first\nT2 [done] second\n');
  });

  it('--summary + --output silent → silent wins (no stdout)', () => {
    setSummaryMode(true);
    setOutputMode('silent');
    cliOutput(
      { task: { id: 'T9932', status: 'pending', title: 'Summary flag' } },
      { command: 'show' },
    );
    expect(captured()).toBe('');
  });

  it('--summary + --output count → count wins (numeric output)', () => {
    setSummaryMode(true);
    setOutputMode('count');
    cliOutput({ tasks: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }], total: 3 }, { command: 'list' });
    expect(captured()).toBe('3\n');
  });

  it('--summary + --output id → id wins (one id per line)', () => {
    setSummaryMode(true);
    setOutputMode('id');
    cliOutput(
      {
        tasks: [
          { id: 'T1', title: 'a' },
          { id: 'T2', title: 'b' },
        ],
      },
      { command: 'list' },
    );
    expect(captured()).toBe('T1\nT2\n');
  });

  it('--summary + --output table → table wins (full ASCII table)', () => {
    setSummaryMode(true);
    setOutputMode('table');
    cliOutput(
      { tasks: [{ id: 'T1', status: 'pending', priority: 'high', title: 'first' }] },
      { command: 'list' },
    );
    const out = captured();
    // Table renderer emits a header line with all four columns.
    expect(out).toContain('id');
    expect(out).toContain('status');
    expect(out).toContain('priority');
    expect(out).toContain('title');
    expect(out).toContain('T1');
    // NOT the summary 1-line shape.
    expect(out).not.toBe('T1 [pending] first\n');
  });
});

describe('cliOutput — --summary + --field precedence', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    setFormatContext({ format: 'json', source: 'default', quiet: false });
    setFieldContext({ mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });
    setOutputMode('envelope');
    setSummaryMode(false);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    setFieldContext({ mvi: 'minimal', mviSource: 'default', expectsCustomMvi: false });
    setSummaryMode(false);
  });

  it('--field wins over --summary (single-field scalar)', () => {
    setSummaryMode(true);
    setFieldContext({
      mvi: 'minimal',
      mviSource: 'default',
      expectsCustomMvi: false,
      field: 'title',
    });
    cliOutput(
      { task: { id: 'T9932', status: 'in_progress', title: 'Summary flag' } },
      { command: 'show' },
    );
    const out = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    // --field extraction emits just the scalar, NOT the summary 1-liner.
    expect(out).toBe('Summary flag\n');
  });
});
