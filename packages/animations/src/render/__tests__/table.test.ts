/**
 * Tests for renderTable — column-aligned rows with width-aware truncation.
 */

import type { TableResponse } from '@cleocode/contracts/render/table.js';
import { describe, expect, it } from 'vitest';
import { createAnimateContext, SILENT_CONTEXT } from '../../animate-context.js';
import { renderTable } from '../table.js';

const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

// noColorCtx is silenced by createAnimateContext (NO_COLOR halts rendering).
// To test the ASCII glyph path, pass `asciiBoxDrawing: true` while keeping the
// enabled context — that's the public knob for caller-driven ASCII output.

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

const TASK_TABLE: TableResponse<TaskRow> = {
  rows: [
    { id: 'T9832', title: 'Contracts foundation', status: 'done' },
    { id: 'T9836', title: 'Test helpers', status: 'done' },
    { id: 'T10128', title: 'Animations render primitives', status: 'in_progress' },
    { id: 'T9837', title: 'SSoT enforcement', status: 'pending' },
    { id: 'T9854', title: 'Saga rollup', status: 'pending' },
  ],
  schema: {
    columns: [
      { key: 'id', header: 'ID' },
      { key: 'title', header: 'Title' },
      { key: 'status', header: 'Status' },
    ],
  },
  total: 5,
};

describe('renderTable', () => {
  it('returns empty string when context is silent', () => {
    expect(renderTable(TASK_TABLE, { ctx: SILENT_CONTEXT })).toBe('');
  });

  it('renders the canonical 3-column task list at width 120', () => {
    expect(renderTable(TASK_TABLE, { ctx: enabledCtx, maxWidth: 120 })).toMatchInlineSnapshot(`
      "ID      Title                         Status
      ──────  ────────────────────────────  ───────────
      T9832   Contracts foundation          done
      T9836   Test helpers                  done
      T10128  Animations render primitives  in_progress
      T9837   SSoT enforcement              pending
      T9854   Saga rollup                   pending
      (5 rows)"
    `);
  });

  it('renders ASCII fallback when asciiBoxDrawing=true', () => {
    expect(
      renderTable(TASK_TABLE, {
        ctx: enabledCtx,
        maxWidth: 120,
        asciiBoxDrawing: true,
      }),
    ).toMatchInlineSnapshot(`
      "ID      Title                         Status
      ------  ----------------------------  -----------
      T9832   Contracts foundation          done
      T9836   Test helpers                  done
      T10128  Animations render primitives  in_progress
      T9837   SSoT enforcement              pending
      T9854   Saga rollup                   pending
      (5 rows)"
    `);
  });

  it('shrinks wide string columns and truncates cells when total width > maxWidth', () => {
    const wide: TableResponse<TaskRow> = {
      rows: [
        {
          id: 'T0001',
          title: 'A really long descriptive task title that absolutely will not fit',
          status: 'in_progress',
        },
      ],
      schema: TASK_TABLE.schema,
      total: 1,
    };
    const out = renderTable(wide, { ctx: enabledCtx, maxWidth: 40 });
    // Each emitted line (excluding the footer) MUST be <= maxWidth.
    for (const line of out.split('\n')) {
      if (line.startsWith('(')) continue;
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // Truncation indicator present in the data row.
    expect(out).toMatch(/…|\.{3}/);
  });

  it('renders a single-column narrow id-only list', () => {
    const idsOnly: TableResponse<{ id: string }> = {
      rows: [{ id: 'T1' }, { id: 'T2' }, { id: 'T3' }],
      schema: { columns: [{ key: 'id', header: 'ID' }] },
      total: 3,
    };
    expect(renderTable(idsOnly, { ctx: enabledCtx, maxWidth: 80 })).toMatchInlineSnapshot(`
      "ID
      ──
      T1
      T2
      T3
      (3 rows)"
    `);
  });

  it('respects column alignment hints', () => {
    interface Numbered {
      readonly k: string;
      readonly v: number;
    }
    const t: TableResponse<Numbered> = {
      rows: [
        { k: 'a', v: 1 },
        { k: 'bb', v: 22 },
        { k: 'ccc', v: 333 },
      ],
      schema: {
        columns: [
          { key: 'k', header: 'Key', align: 'left' },
          { key: 'v', header: 'Val', align: 'right' },
        ],
      },
      total: 3,
    };
    expect(renderTable(t, { ctx: enabledCtx, maxWidth: 80 })).toMatchInlineSnapshot(`
      "Key  Val
      ───  ───
      a      1
      bb    22
      ccc  333
      (3 rows)"
    `);
  });

  it('renders the singular "row" footer when total === 1', () => {
    const one: TableResponse<{ id: string }> = {
      rows: [{ id: 'T1' }],
      schema: { columns: [{ key: 'id', header: 'ID' }] },
      total: 1,
    };
    const out = renderTable(one, { ctx: enabledCtx, maxWidth: 80 });
    expect(out).toContain('(1 row)');
    expect(out).not.toContain('(1 rows)');
  });
});
