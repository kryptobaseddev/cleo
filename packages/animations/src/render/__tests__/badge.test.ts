/**
 * Tests for renderBadge / renderStatusBadge — single-glyph emoji + ASCII output.
 *
 * Covers every icon enum + ASCII fallback + AnimateContext gating.
 */

import { BadgeIcon, KindIcon, RelationIcon, StatusIcon } from '@cleocode/contracts/render/icon.js';
import { describe, expect, it } from 'vitest';
import { createAnimateContext, SILENT_CONTEXT } from '../../animate-context.js';
import { renderBadge, renderStatusBadge, type StatusBadgeName } from '../badge.js';

const enabledCtx = createAnimateContext({
  flagResolution: { format: 'human', quiet: false },
  isTTY: true,
  noColor: false,
});

// NOTE: createAnimateContext({ noColor: true }) returns enabled=false (silences
// rendering entirely). To exercise the ASCII fallback path, we pass `ascii: true`
// explicitly OR construct a synthetic context whose `inputs.noColor` is true but
// `enabled` remains true. The explicit `ascii` flag is the public knob.
const asciiOpts = { ctx: enabledCtx, ascii: true } as const;

describe('renderBadge', () => {
  it('returns empty string when context is silent', () => {
    expect(renderBadge(StatusIcon.DONE, { ctx: SILENT_CONTEXT })).toBe('');
  });

  it('renders every StatusIcon as emoji', () => {
    expect(renderBadge(StatusIcon.PENDING, { ctx: enabledCtx })).toBe('⏳');
    expect(renderBadge(StatusIcon.ACTIVE, { ctx: enabledCtx })).toBe('🚧');
    expect(renderBadge(StatusIcon.DONE, { ctx: enabledCtx })).toBe('✅');
    expect(renderBadge(StatusIcon.BLOCKED, { ctx: enabledCtx })).toBe('🚪');
    expect(renderBadge(StatusIcon.ARCHIVED, { ctx: enabledCtx })).toBe('🗄');
    expect(renderBadge(StatusIcon.CANCELLED, { ctx: enabledCtx })).toBe('✗');
  });

  it('renders every StatusIcon as ASCII under noColor context', () => {
    expect(renderBadge(StatusIcon.PENDING, asciiOpts)).toBe('[ ]');
    expect(renderBadge(StatusIcon.ACTIVE, asciiOpts)).toBe('[~]');
    expect(renderBadge(StatusIcon.DONE, asciiOpts)).toBe('[x]');
    expect(renderBadge(StatusIcon.BLOCKED, asciiOpts)).toBe('[!]');
    expect(renderBadge(StatusIcon.ARCHIVED, asciiOpts)).toBe('[#]');
    expect(renderBadge(StatusIcon.CANCELLED, asciiOpts)).toBe('[-]');
  });

  it('renders every KindIcon as emoji', () => {
    expect(renderBadge(KindIcon.SAGA, { ctx: enabledCtx })).toBe('🌲');
    expect(renderBadge(KindIcon.EPIC, { ctx: enabledCtx })).toBe('📋');
    expect(renderBadge(KindIcon.TASK, { ctx: enabledCtx })).toBe('•');
    expect(renderBadge(KindIcon.SUBTASK, { ctx: enabledCtx })).toBe('◦');
    expect(renderBadge(KindIcon.RESEARCH, { ctx: enabledCtx })).toBe('📖');
    expect(renderBadge(KindIcon.BUG, { ctx: enabledCtx })).toBe('🐛');
    expect(renderBadge(KindIcon.RELEASE, { ctx: enabledCtx })).toBe('🚀');
  });

  it('renders every KindIcon as ASCII under noColor context', () => {
    expect(renderBadge(KindIcon.SAGA, asciiOpts)).toBe('SG');
    expect(renderBadge(KindIcon.EPIC, asciiOpts)).toBe('E');
    expect(renderBadge(KindIcon.TASK, asciiOpts)).toBe('-');
    expect(renderBadge(KindIcon.SUBTASK, asciiOpts)).toBe('.');
    expect(renderBadge(KindIcon.RESEARCH, asciiOpts)).toBe('R');
    expect(renderBadge(KindIcon.BUG, asciiOpts)).toBe('B');
    expect(renderBadge(KindIcon.RELEASE, asciiOpts)).toBe('>');
  });

  it('renders every BadgeIcon — note ORPHAN is 👻 (B2 deviation from ADR-077)', () => {
    expect(renderBadge(BadgeIcon.EMPTY, { ctx: enabledCtx })).toBe('🪦');
    expect(renderBadge(BadgeIcon.ORPHAN, { ctx: enabledCtx })).toBe('👻');
    expect(renderBadge(BadgeIcon.NESTED, { ctx: enabledCtx })).toBe('🔁');
    expect(renderBadge(BadgeIcon.CAUTION, { ctx: enabledCtx })).toBe('⚠');
    expect(renderBadge(BadgeIcon.NEW, { ctx: enabledCtx })).toBe('★');
  });

  it('renders every RelationIcon', () => {
    expect(renderBadge(RelationIcon.GROUPS, { ctx: enabledCtx })).toBe('⊂');
    expect(renderBadge(RelationIcon.PARENT, { ctx: enabledCtx })).toBe('⤴');
    expect(renderBadge(RelationIcon.DEPENDS, { ctx: enabledCtx })).toBe('⇨');
    expect(renderBadge(RelationIcon.BLOCKS, { ctx: enabledCtx })).toBe('⊘');
  });

  it('honors explicit ascii=true override regardless of context', () => {
    expect(renderBadge(StatusIcon.DONE, { ctx: enabledCtx, ascii: true })).toBe('[x]');
  });

  it('honors explicit ascii=false override regardless of context inputs', () => {
    // Synthetic enabled context whose inputs.noColor is true — verifies the
    // explicit `ascii: false` knob wins over the context's noColor signal.
    const enabledNoColor = {
      enabled: true as const,
      reason: 'enabled' as const,
      inputs: { format: 'human' as const, quiet: false, isTTY: true, noColor: true },
    };
    expect(renderBadge(StatusIcon.DONE, { ctx: enabledNoColor, ascii: false })).toBe('✅');
  });
});

describe('renderStatusBadge', () => {
  it('returns empty string when context is silent', () => {
    expect(renderStatusBadge('done', { ctx: SILENT_CONTEXT })).toBe('');
  });

  it.each<[StatusBadgeName, string, string]>([
    ['pending', '⏳', '[ ]'],
    ['in_progress', '🚧', '[~]'],
    ['done', '✅', '[x]'],
    ['blocked', '🚪', '[!]'],
    ['cancelled', '✗', '[-]'],
    ['archived', '🗄', '[#]'],
  ])('maps %s → emoji=%s, ascii=%s', (name, emoji, ascii) => {
    expect(renderStatusBadge(name, { ctx: enabledCtx })).toBe(emoji);
    expect(renderStatusBadge(name, asciiOpts)).toBe(ascii);
  });
});
