/**
 * Tests for renderSection — labelled block with indented items.
 */

import { describe, expect, it } from 'vitest';
import { createAnimateContext, SILENT_CONTEXT } from '../../animate-context.js';
import { renderSection } from '../section.js';

const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

describe('renderSection', () => {
  it('returns empty string when context is silent', () => {
    expect(renderSection({ ctx: SILENT_CONTEXT, header: 'DONE', items: ['T1', 'T2'] })).toBe('');
  });

  it('renders header only when items is empty', () => {
    expect(renderSection({ ctx: enabledCtx, header: 'DONE', items: [] })).toBe('DONE');
  });

  it('renders header plus indented items', () => {
    expect(
      renderSection({
        ctx: enabledCtx,
        header: 'DONE',
        items: ['T1 thing', 'T2 other thing'],
      }),
    ).toMatchInlineSnapshot(`
      "DONE
        T1 thing
        T2 other thing"
    `);
  });

  it('renders the ✅ DONE canonical section', () => {
    expect(
      renderSection({
        ctx: enabledCtx,
        icon: '✅',
        header: 'DONE',
        subtitle: '3 epics shipped',
        items: ['T9832 contracts foundation', 'T9836 test helpers', 'T9837 SSoT enforcement'],
      }),
    ).toMatchInlineSnapshot(`
      "✅ DONE — 3 epics shipped
        T9832 contracts foundation
        T9836 test helpers
        T9837 SSoT enforcement"
    `);
  });

  it('renders the 🚧 ACTIVE canonical section', () => {
    expect(
      renderSection({
        ctx: enabledCtx,
        icon: '🚧',
        header: 'ACTIVE',
        items: ['T10128 animations render primitives'],
      }),
    ).toMatchInlineSnapshot(`
      "🚧 ACTIVE
        T10128 animations render primitives"
    `);
  });

  it('renders the 🪦 EMPTY canonical section (no items, with icon)', () => {
    expect(
      renderSection({
        ctx: enabledCtx,
        icon: '🪦',
        header: 'EMPTY',
        subtitle: 'no children',
        items: [],
      }),
    ).toMatchInlineSnapshot(`"🪦 EMPTY — no children"`);
  });

  it('renders the 👻 ORPHAN canonical section (BadgeIcon.ORPHAN deviation)', () => {
    expect(
      renderSection({
        ctx: enabledCtx,
        icon: '👻',
        header: 'ORPHAN',
        items: ['T9999 unreachable task'],
      }),
    ).toMatchInlineSnapshot(`
      "👻 ORPHAN
        T9999 unreachable task"
    `);
  });

  it('omits the em-dash when subtitle is the empty string', () => {
    expect(
      renderSection({
        ctx: enabledCtx,
        header: 'BARE',
        subtitle: '',
        items: ['a'],
      }),
    ).toMatchInlineSnapshot(`
      "BARE
        a"
    `);
  });
});
