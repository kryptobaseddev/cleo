/**
 * Tests for renderLegend / renderSummary — compact glossary + aggregate footer.
 */

import { describe, expect, it } from 'vitest';
import {
  type AnimateContext,
  createAnimateContext,
  SILENT_CONTEXT,
} from '../../animate-context.js';
import { renderLegend, renderSummary } from '../legend.js';

const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

// Synthetic context: enabled (so rendering runs) but with `inputs.noColor: true`
// so the primitive's ASCII branch fires. createAnimateContext silences NO_COLOR
// at construction, so we hand-build this for ASCII-path coverage.
const enabledNoColorCtx: AnimateContext = {
  enabled: true,
  reason: 'enabled',
  inputs: { format: 'human', quiet: false, isTTY: true, noColor: true },
};

describe('renderLegend', () => {
  it('returns empty string when context is silent', () => {
    expect(
      renderLegend({
        ctx: SILENT_CONTEXT,
        items: [{ icon: '✅', label: 'done' }],
      }),
    ).toBe('');
  });

  it('returns empty string when items array is empty', () => {
    expect(renderLegend({ ctx: enabledCtx, items: [] })).toBe('');
  });

  it('renders short legend (4 items) as a single line', () => {
    expect(
      renderLegend({
        ctx: enabledCtx,
        items: [
          { icon: '✅', label: 'done' },
          { icon: '🚧', label: 'active' },
          { icon: '⏳', label: 'pending' },
          { icon: '🚪', label: 'blocked' },
        ],
      }),
    ).toMatchInlineSnapshot(`"✅ done  🚧 active  ⏳ pending  🚪 blocked"`);
  });

  it('renders long legend (10 items > default threshold 8) as multi-line', () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      icon: '•',
      label: `item-${i}`,
    }));
    const out = renderLegend({ ctx: enabledCtx, items });
    expect(out.split('\n')).toHaveLength(10);
    expect(out).toContain('• item-0\n• item-1');
  });

  it('respects custom multiLineThreshold', () => {
    const items = [
      { icon: 'A', label: 'a' },
      { icon: 'B', label: 'b' },
      { icon: 'C', label: 'c' },
    ];
    const oneLine = renderLegend({ ctx: enabledCtx, items, multiLineThreshold: 3 });
    expect(oneLine).toBe('A a  B b  C c');

    const multi = renderLegend({ ctx: enabledCtx, items, multiLineThreshold: 2 });
    expect(multi.split('\n')).toHaveLength(3);
  });
});

describe('renderSummary', () => {
  it('returns empty string when context is silent', () => {
    expect(
      renderSummary({
        ctx: SILENT_CONTEXT,
        counts: [{ label: 'Sagas', n: 1 }],
      }),
    ).toBe('');
  });

  it('returns empty string when counts array is empty', () => {
    expect(renderSummary({ ctx: enabledCtx, counts: [] })).toBe('');
  });

  it('renders the ADR-077 canonical summary footer with middle-dot separator', () => {
    expect(
      renderSummary({
        ctx: enabledCtx,
        counts: [
          { label: 'Sagas', n: 15 },
          { label: 'member Epics', n: 89 },
          { label: 'orphan', n: 1 },
        ],
      }),
    ).toBe('15 Sagas · 89 member Epics · 1 orphan');
  });

  it('uses pipe separator when ctx.inputs.noColor is true', () => {
    expect(
      renderSummary({
        ctx: enabledNoColorCtx,
        counts: [
          { label: 'Sagas', n: 15 },
          { label: 'orphan', n: 1 },
        ],
      }),
    ).toBe('15 Sagas | 1 orphan');
  });
});
