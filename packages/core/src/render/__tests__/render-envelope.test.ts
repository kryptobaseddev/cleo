/**
 * Tests for the B5 public render entry point.
 *
 * Covers:
 *   - JSON-format suppression
 *   - Generic fallback when no renderer is registered
 *   - (command, kind) routing of registered renderers
 *   - Cross-kind isolation (a 'table' renderer never serves a 'tree' envelope)
 *   - Fallback per-kind output (tree / table / list / grouped-list / section /
 *     single / generic)
 *   - Registry semantics (register, lookup, last-write-wins, reset)
 *
 * @epic T10114
 * @task T10130
 */

import type { RenderableEnvelope } from '@cleocode/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetRegistryForTests,
  listRegisteredRenderers,
  lookupRenderer,
  registerRenderer,
  renderEnvelopeForHuman,
  renderEnvelopeResultForHuman,
} from '../index.js';

describe('renderEnvelopeForHuman', () => {
  beforeEach(() => _resetRegistryForTests());

  it('returns empty string for json format', () => {
    const env: RenderableEnvelope<unknown> = { kind: 'generic', data: { x: 1 } };
    expect(renderEnvelopeForHuman(env, 'whatever', { format: 'json' })).toBe('');
  });

  it('falls back to generic renderer when none registered', () => {
    const env: RenderableEnvelope<unknown> = { kind: 'generic', data: { foo: 'bar' } };
    const out = renderEnvelopeForHuman(env, 'unknown.command', {});
    expect(out).toContain('foo');
    expect(out).toContain('bar');
  });

  it('routes to a registered renderer by (command, kind)', () => {
    registerRenderer('tasks.list', 'table', () => 'CUSTOM_TABLE_OUT');
    const env: RenderableEnvelope<unknown> = {
      kind: 'table',
      data: { rows: [], schema: { columns: [] }, total: 0 },
    };
    expect(renderEnvelopeForHuman(env, 'tasks.list', {})).toBe('CUSTOM_TABLE_OUT');
  });

  it('does NOT route cross-kind (table renderer cannot serve tree envelope)', () => {
    registerRenderer('tasks.list', 'table', () => 'CUSTOM_TABLE_OUT');
    const treeEnv: RenderableEnvelope<unknown> = {
      kind: 'tree',
      data: { tree: [], root: 'T1', totalNodes: 0, maxDepth: 0 },
    };
    const out = renderEnvelopeForHuman(treeEnv, 'tasks.list', {});
    expect(out).not.toBe('CUSTOM_TABLE_OUT');
  });

  it('does NOT route cross-command (renderer for cmdA cannot serve cmdB)', () => {
    registerRenderer('cmdA', 'generic', () => 'A_OUT');
    const env: RenderableEnvelope<unknown> = { kind: 'generic', data: { foo: 'bar' } };
    expect(renderEnvelopeForHuman(env, 'cmdA', {})).toBe('A_OUT');
    expect(renderEnvelopeForHuman(env, 'cmdB', {})).not.toBe('A_OUT');
  });

  it('passes opts through to a registered renderer', () => {
    registerRenderer('cmd', 'generic', (_env, opts) => `verbose=${opts.verbose ?? false}`);
    const env: RenderableEnvelope<unknown> = { kind: 'generic', data: {} };
    expect(renderEnvelopeForHuman(env, 'cmd', { verbose: true })).toBe('verbose=true');
  });

  it('fallback renders tree with depth-based indent', () => {
    const env: RenderableEnvelope<{ note: string }> = {
      kind: 'tree',
      data: {
        root: 'T1',
        totalNodes: 3,
        maxDepth: 2,
        tree: [
          {
            id: 'T1',
            parentId: null,
            depth: 0,
            kind: 'epic',
            status: 'pending',
            title: 'root',
            metadata: { note: 'r' },
          },
          {
            id: 'T2',
            parentId: 'T1',
            depth: 1,
            kind: 'task',
            status: 'pending',
            title: 'child',
            metadata: { note: 'c' },
          },
          {
            id: 'T3',
            parentId: 'T2',
            depth: 2,
            kind: 'subtask',
            status: 'pending',
            title: 'grand',
            metadata: { note: 'g' },
          },
        ],
      },
    };
    const out = renderEnvelopeForHuman(env, 'unknown', {});
    expect(out).toContain('root');
    expect(out).toContain('child');
    expect(out).toContain('grand');
    // ASCII bracket prefixes (no emoji icons — B2 owns that).
    expect(out).toContain('[epic]');
    expect(out).toContain('[task]');
    expect(out).toContain('[subtask]');
  });

  it('fallback renders empty tree as a compact empty state', () => {
    const env: RenderableEnvelope<unknown> = {
      kind: 'tree',
      data: { tree: [], root: '', totalNodes: 0, maxDepth: 0 },
    };
    expect(renderEnvelopeForHuman(env, 'unknown', {})).toBe('No tree nodes.');
  });

  it('returns typed emptyReason metadata for compact empty output', () => {
    const env: RenderableEnvelope<unknown> = {
      kind: 'list',
      data: { items: [], total: 0 },
    };
    expect(renderEnvelopeResultForHuman(env, 'unknown', { quiet: true })).toEqual({
      ok: true,
      text: 'No list items.',
      emptyReason: 'empty-list',
    });
  });

  it('returns E_RENDERER_UNSUPPORTED for unsupported envelope kinds', () => {
    const env = { kind: 'matrix', data: {} } as unknown as RenderableEnvelope<unknown>;
    expect(renderEnvelopeResultForHuman(env, 'unknown', {})).toEqual({
      ok: false,
      code: 'E_RENDERER_UNSUPPORTED',
      text: '',
      emptyReason: 'renderer-unsupported',
      message: 'Unsupported renderer envelope kind: matrix',
    });
  });

  it('fallback renders table via dataTable helper from B4', () => {
    const env: RenderableEnvelope<{ id: string; title: string }> = {
      kind: 'table',
      data: {
        total: 2,
        rows: [
          { id: 'T1', title: 'first' },
          { id: 'T2', title: 'second' },
        ],
        schema: {
          columns: [
            { key: 'id', header: 'ID' },
            { key: 'title', header: 'Title' },
          ],
        },
      },
    };
    const out = renderEnvelopeForHuman(env, 'unknown', {});
    expect(out).toContain('T1');
    expect(out).toContain('first');
    expect(out).toContain('T2');
    expect(out).toContain('second');
  });

  it('fallback renders list items with `- ` prefix', () => {
    const env: RenderableEnvelope<string> = {
      kind: 'list',
      data: { items: ['alpha', 'beta'], total: 2 },
    };
    const out = renderEnvelopeForHuman(env, 'unknown', {});
    expect(out).toContain('- alpha');
    expect(out).toContain('- beta');
  });

  it('fallback renders grouped-list with one section per group', () => {
    const env: RenderableEnvelope<string> = {
      kind: 'grouped-list',
      data: {
        total: 3,
        groups: [
          { key: 'a', label: 'Group A', items: ['a1', 'a2'] },
          { key: 'b', label: 'Group B', items: ['b1'] },
        ],
      },
    };
    const out = renderEnvelopeForHuman(env, 'unknown', {});
    expect(out).toContain('Group A');
    expect(out).toContain('- a1');
    expect(out).toContain('- a2');
    expect(out).toContain('Group B');
    expect(out).toContain('- b1');
  });

  it('fallback renders section header + items', () => {
    const env: RenderableEnvelope<unknown> = {
      kind: 'section',
      data: { header: 'Active', items: ['T1 alpha', 'T2 beta'] },
    };
    const out = renderEnvelopeForHuman(env, 'briefing.next', {});
    expect(out).toContain('Active');
    expect(out).toContain('T1 alpha');
    expect(out).toContain('T2 beta');
  });

  it('fallback renders single (object payload) via kvBlock', () => {
    const env: RenderableEnvelope<{ id: string; status: string }> = {
      kind: 'single',
      data: { id: 'T1', status: 'pending' },
    };
    const out = renderEnvelopeForHuman(env, 'unknown', {});
    expect(out).toContain('id');
    expect(out).toContain('T1');
    expect(out).toContain('status');
    expect(out).toContain('pending');
  });

  it('fallback renders single (scalar payload) via String()', () => {
    const env: RenderableEnvelope<number> = { kind: 'single', data: 42 };
    expect(renderEnvelopeForHuman(env, 'unknown', {})).toBe('42');
  });

  it('fallback renders generic envelope via kvBlock', () => {
    const env: RenderableEnvelope<unknown> = {
      kind: 'generic',
      data: { a: 1, b: 'two' },
    };
    const out = renderEnvelopeForHuman(env, 'unknown', {});
    expect(out).toContain('a');
    expect(out).toContain('1');
    expect(out).toContain('b');
    expect(out).toContain('two');
  });
});

describe('registry', () => {
  beforeEach(() => _resetRegistryForTests());

  it('registers + retrieves a renderer', () => {
    const fn = () => 'X';
    registerRenderer('cmd', 'tree', fn);
    expect(lookupRenderer('cmd', 'tree')).toBe(fn);
  });

  it('returns undefined for an unregistered key', () => {
    expect(lookupRenderer('absent', 'generic')).toBeUndefined();
  });

  it('last-write wins for same (command, kind)', () => {
    registerRenderer('cmd', 'tree', () => 'A');
    registerRenderer('cmd', 'tree', () => 'B');
    const renderer = lookupRenderer('cmd', 'tree');
    expect(renderer).toBeDefined();
    const env: RenderableEnvelope<unknown> = {
      kind: 'tree',
      data: { tree: [], root: '', totalNodes: 0, maxDepth: 0 },
    };
    expect(renderer?.(env, {})).toBe('B');
  });

  it('listRegisteredRenderers returns sorted snapshot', () => {
    registerRenderer('beta', 'generic', () => '');
    registerRenderer('alpha', 'table', () => '');
    registerRenderer('alpha', 'tree', () => '');
    const keys = listRegisteredRenderers();
    expect(keys).toEqual(['alpha:table', 'alpha:tree', 'beta:generic']);
  });

  it('_resetRegistryForTests clears every registration', () => {
    registerRenderer('cmd', 'tree', () => 'X');
    expect(listRegisteredRenderers()).toHaveLength(1);
    _resetRegistryForTests();
    expect(listRegisteredRenderers()).toHaveLength(0);
  });
});
