/**
 * Type-shape + runtime contract test for the MVI progressive-disclosure
 * primitive {@link MviDigest} (T11349 · Epic T11285 · Saga T11283).
 *
 * Asserts that the single `MviDigest<T>` shape unifies CLEO's three historical
 * expansion-hint conventions (`_next`, `meta.suggestedNext`,
 * `_nexus.suggestedNext`) and that each legacy producer can emit — and any
 * consumer can read — a digest *without any `any` casts*. The `expectTypeOf`
 * assertions are the tsd-style proof: if the discriminated union ever widens
 * to `any`/`unknown` or loses a variant, these fail at type-check time.
 *
 * @epic T11285
 * @task T11349
 * @saga T11283
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ExpansionHint,
  expansionFromNextDirectives,
  expansionFromStructuredOps,
  expansionFromSuggestedCommands,
  isNextDirectivesHint,
  isStructuredOpsHint,
  isSuggestedCommandsHint,
  type MviDigest,
  type NextDirectivesHint,
  type StructuredOpsHint,
  type SuggestedCommandsHint,
} from '../mvi.js';
import type { SuggestedNextOp } from '../operations/nexus-scope.js';

describe('MviDigest<T> shape (T11349)', () => {
  it('has the canonical {summary, count, preview?, expand} fields', () => {
    const digest: MviDigest<{ id: string }> = {
      summary: '12 child tasks (3 done, 9 pending)',
      count: 12,
      preview: [{ id: 'T1' }, { id: 'T2' }],
      expand: { kind: 'next-directives', directives: { all: 'cleo list --parent T0' } },
    };
    expect(digest.count).toBe(12);
    expect(digest.preview).toHaveLength(2);
    expect(digest.summary).toContain('child tasks');
  });

  it('preview is optional — a digest can describe an unsampled collection', () => {
    const digest: MviDigest = {
      summary: '40 memory entries',
      count: 40,
      expand: { kind: 'suggested-commands', commands: ['cleo memory find "x"'] },
    };
    expect(digest.preview).toBeUndefined();
  });

  it('summary/count/expand are required; preview is the only optional field', () => {
    expectTypeOf<MviDigest>().toHaveProperty('summary');
    expectTypeOf<MviDigest>().toHaveProperty('count');
    expectTypeOf<MviDigest>().toHaveProperty('expand');
    expectTypeOf<MviDigest['summary']>().toEqualTypeOf<string>();
    expectTypeOf<MviDigest['count']>().toEqualTypeOf<number>();
    expectTypeOf<MviDigest<{ id: string }>['preview']>().toEqualTypeOf<
      ReadonlyArray<{ id: string }> | undefined
    >();
  });
});

describe('ExpansionHint unifies the 3 legacy conventions (T11349)', () => {
  it('reconciles `_next` (NextDirectives — Record<string,string>) without a cast', () => {
    // The exact shape produced by core/src/mvi-helpers.ts taskShowNext().
    const legacyNext: Record<string, string> = {
      full: 'cleo show T042 --mvi full',
      children: 'cleo find --parent T042',
      deps: 'cleo deps T042',
    };
    const hint = expansionFromNextDirectives(legacyNext);
    expectTypeOf(hint).toEqualTypeOf<NextDirectivesHint>();
    expect(hint.kind).toBe('next-directives');
    expect(hint.directives.full).toBe('cleo show T042 --mvi full');
  });

  it('reconciles `meta.suggestedNext` (ReadonlyArray<string>) without a cast', () => {
    // The exact shape produced by core/src/dispatch/suggested-next.ts builders.
    const legacySuggested: ReadonlyArray<string> = ['cleo show T1', 'cleo focus T1'];
    const hint = expansionFromSuggestedCommands(legacySuggested);
    expectTypeOf(hint).toEqualTypeOf<SuggestedCommandsHint>();
    expect(hint.kind).toBe('suggested-commands');
    expect(hint.commands).toEqual(['cleo show T1', 'cleo focus T1']);
  });

  it('reconciles `_nexus.suggestedNext` (ReadonlyArray<SuggestedNextOp>) without a cast', () => {
    // The exact shape from contracts/operations/nexus-scope.ts NexusScopeMeta.
    const legacyNexus: ReadonlyArray<SuggestedNextOp> = [
      {
        op: 'nexus.context',
        args: { name: 'validateUser' },
        scope: 'project',
        effect: 'read',
        requiresConfirmation: false,
        reason: 'inspect callers before editing',
      },
    ];
    const hint = expansionFromStructuredOps(legacyNexus);
    expectTypeOf(hint).toEqualTypeOf<StructuredOpsHint>();
    expect(hint.kind).toBe('structured-ops');
    expect(hint.ops[0]?.op).toBe('nexus.context');
  });

  it('is a discriminated union — `kind` narrows to each variant', () => {
    const hints: ExpansionHint[] = [
      expansionFromNextDirectives({ all: 'cleo list' }),
      expansionFromSuggestedCommands(['cleo next']),
      expansionFromStructuredOps([]),
    ];
    for (const hint of hints) {
      if (isNextDirectivesHint(hint)) {
        expectTypeOf(hint).toEqualTypeOf<NextDirectivesHint>();
        expect(typeof hint.directives).toBe('object');
      } else if (isSuggestedCommandsHint(hint)) {
        expectTypeOf(hint).toEqualTypeOf<SuggestedCommandsHint>();
        expect(Array.isArray(hint.commands)).toBe(true);
      } else if (isStructuredOpsHint(hint)) {
        expectTypeOf(hint).toEqualTypeOf<StructuredOpsHint>();
        expect(Array.isArray(hint.ops)).toBe(true);
      }
    }
  });

  it('the union has exactly three variants and never widens to `any`', () => {
    expectTypeOf<ExpansionHint>().toEqualTypeOf<
      NextDirectivesHint | SuggestedCommandsHint | StructuredOpsHint
    >();
    expectTypeOf<ExpansionHint['kind']>().toEqualTypeOf<
      'next-directives' | 'suggested-commands' | 'structured-ops'
    >();
  });
});

describe('MviDigest carries any legacy hint as its expand field (T11349)', () => {
  it('a tasks-list digest expands via NextDirectives', () => {
    const digest: MviDigest<{ id: string }> = {
      summary: '3 ready tasks',
      count: 3,
      preview: [{ id: 'T1' }],
      expand: expansionFromNextDirectives({ all: 'cleo orchestrate ready --epic T0' }),
    };
    expect(isNextDirectivesHint(digest.expand)).toBe(true);
  });

  it('a mutate-op digest expands via suggested commands', () => {
    const digest: MviDigest = {
      summary: 'task created',
      count: 1,
      expand: expansionFromSuggestedCommands(['cleo show T9', 'cleo focus T9']),
    };
    expect(isSuggestedCommandsHint(digest.expand)).toBe(true);
  });

  it('a nexus digest expands via structured ops', () => {
    const digest: MviDigest = {
      summary: '5 affected symbols',
      count: 5,
      expand: expansionFromStructuredOps([
        {
          op: 'nexus.impact',
          args: { target: 'x' },
          scope: 'project',
          effect: 'read',
          requiresConfirmation: false,
          reason: 'assess blast radius',
        },
      ]),
    };
    expect(isStructuredOpsHint(digest.expand)).toBe(true);
  });
});
