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
import { renderOutputMode } from '../../renderers/output-mode.js';

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

  it('returns typed empty reason text for an unrecognised shape', () => {
    const out = renderOutputMode('id', { value: 7, foo: 'bar' });
    expect(out.text).toBe('No ids.');
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
  it('honours explicit `total` over array length', () => {
    const out = renderOutputMode('count', {
      tasks: [{ id: 'T1' }, { id: 'T2' }],
      total: 17,
    });
    expect(out.text).toBe('17');
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

  it('returns "No rows." for an empty list', () => {
    const out = renderOutputMode('table', { tasks: [] });
    expect(out.text).toBe('No rows.');
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
