/**
 * MVI (Minimum-Viable-Information) progressive-disclosure primitive.
 *
 * CLEO historically grew three *separate* "expansion-hint" conventions, each
 * answering the same question — *"the agent got a lean result; how does it
 * drill deeper?"* — in a different wire shape:
 *
 * 1. **`_next`** (`core/src/mvi-helpers.ts`) — `Record<string, string>`: a map
 *    of follow-up *name* → copy-pasteable CLI command
 *    (`{ full: "cleo show T1", children: "cleo find --parent T1" }`).
 * 2. **`meta.suggestedNext`** (`core/src/dispatch/suggested-next.ts`, T9920) — a
 *    flat `ReadonlyArray<string>` of copy-pasteable CLI commands.
 * 3. **`_nexus.suggestedNext`** (`contracts/operations/nexus-scope.ts`) — a
 *    `ReadonlyArray<SuggestedNextOp>` of machine-readable, structured operations.
 *
 * {@link MviDigest} is the single primitive that unifies them. A digest
 * describes a *collapsed* collection: a one-line `summary`, the total `count`,
 * an optional bounded `preview` sample, and exactly one {@link ExpansionHint}
 * describing how to fetch the rest. The hint is a discriminated union whose
 * variants are the three legacy conventions — so existing producers can emit a
 * digest and existing consumers can read one *without any `any` casts*.
 *
 * @packageDocumentation
 * @module @cleocode/contracts/mvi
 *
 * @epic T11285 EP-MVI-PRIMITIVE
 * @task T11349
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { SuggestedNextOp } from './operations/nexus-scope.js';

/**
 * `_next`-style expansion hint: a map of follow-up *name* → CLI command string.
 *
 * The `kind` discriminant lets a single {@link MviDigest} carry any of the
 * three legacy conventions without ambiguity. This variant corresponds to the
 * `_next` directives built by `core/src/mvi-helpers.ts`.
 *
 * @example
 * ```ts
 * const hint: NextDirectivesHint = {
 *   kind: 'next-directives',
 *   directives: { full: 'cleo show T1', children: 'cleo find --parent T1' },
 * };
 * ```
 *
 * @public
 */
export interface NextDirectivesHint {
  /** Discriminant: this hint carries `_next`-style named CLI directives. */
  readonly kind: 'next-directives';
  /** Map of follow-up operation name → copy-pasteable CLI command string. */
  readonly directives: Readonly<Record<string, string>>;
}

/**
 * `meta.suggestedNext`-style expansion hint: a flat list of CLI commands.
 *
 * Corresponds to the `ReadonlyArray<string>` promoted to
 * `meta.suggestedNext` in T9920 (`core/src/dispatch/suggested-next.ts`).
 *
 * @example
 * ```ts
 * const hint: SuggestedCommandsHint = {
 *   kind: 'suggested-commands',
 *   commands: ['cleo show T1', 'cleo focus T1'],
 * };
 * ```
 *
 * @public
 */
export interface SuggestedCommandsHint {
  /** Discriminant: this hint carries a flat list of CLI command strings. */
  readonly kind: 'suggested-commands';
  /** Copy-pasteable CLI command strings the agent may run next. */
  readonly commands: ReadonlyArray<string>;
}

/**
 * `_nexus.suggestedNext`-style expansion hint: structured machine-readable ops.
 *
 * Corresponds to the `ReadonlyArray<SuggestedNextOp>` carried under
 * `meta._nexus.suggestedNext` (`contracts/operations/nexus-scope.ts`). Display
 * strings are *derived* from these structured fields, never the reverse.
 *
 * @example
 * ```ts
 * const hint: StructuredOpsHint = {
 *   kind: 'structured-ops',
 *   ops: [{ op: 'nexus.context', args: { name: 'foo' }, scope: 'project',
 *           effect: 'read', requiresConfirmation: false, reason: 'see callers' }],
 * };
 * ```
 *
 * @public
 */
export interface StructuredOpsHint {
  /** Discriminant: this hint carries structured, machine-readable operations. */
  readonly kind: 'structured-ops';
  /** Structured next-operations. Every `.op` resolves to a known op key. */
  readonly ops: ReadonlyArray<SuggestedNextOp>;
}

/**
 * Unified expansion hint — the discriminated union reconciling CLEO's three
 * historical progressive-disclosure conventions (`_next`,
 * `meta.suggestedNext`, `_nexus.suggestedNext`) under one type.
 *
 * Narrow on {@link ExpansionHint | the `.kind` discriminant} to access the
 * variant payload without casts.
 *
 * @public
 */
export type ExpansionHint = NextDirectivesHint | SuggestedCommandsHint | StructuredOpsHint;

/**
 * The Minimum-Viable-Information digest: the formalized progressive-disclosure
 * primitive for any *collapsed* collection in a LAFS envelope.
 *
 * Instead of streaming a full collection (and blowing the agent's token
 * budget), a producer emits a digest: a one-line {@link MviDigest.summary}, the
 * total {@link MviDigest.count}, an optional bounded {@link MviDigest.preview}
 * sample, and exactly one {@link MviDigest.expand} hint describing how to fetch
 * the remainder.
 *
 * @typeParam T - Element type of the underlying collection. The optional
 *   `preview` is a `ReadonlyArray<T>`; the rest of the digest is element-shape
 *   agnostic, so a producer can describe any collection with one primitive.
 *
 * @example
 * ```ts
 * const digest: MviDigest<{ id: string }> = {
 *   summary: '12 child tasks (3 done, 9 pending)',
 *   count: 12,
 *   preview: [{ id: 'T1' }, { id: 'T2' }],
 *   expand: { kind: 'next-directives', directives: { all: 'cleo list --parent T0' } },
 * };
 * ```
 *
 * @public
 */
export interface MviDigest<T = unknown> {
  /** One-line human/agent-readable summary of the collapsed collection. */
  readonly summary: string;
  /** Total number of elements the collection contains (not the preview size). */
  readonly count: number;
  /**
   * A bounded sample of elements for at-a-glance context. Omitted when no
   * preview is carried (the agent must {@link MviDigest.expand} to see any).
   *
   * @defaultValue undefined
   */
  readonly preview?: ReadonlyArray<T>;
  /** Exactly one {@link ExpansionHint} describing how to fetch the remainder. */
  readonly expand: ExpansionHint;
}

/**
 * Adapt a legacy `_next` directives map into the unified {@link ExpansionHint}.
 *
 * Lets existing `core/src/mvi-helpers.ts` producers feed a digest without
 * re-shaping their output by hand.
 *
 * @param directives - The `_next`-style name → CLI command map.
 * @returns A {@link NextDirectivesHint} wrapping the directives verbatim.
 *
 * @public
 */
export function expansionFromNextDirectives(
  directives: Readonly<Record<string, string>>,
): NextDirectivesHint {
  return { kind: 'next-directives', directives };
}

/**
 * Adapt a legacy `meta.suggestedNext` command list into an {@link ExpansionHint}.
 *
 * @param commands - The flat `ReadonlyArray<string>` of CLI commands.
 * @returns A {@link SuggestedCommandsHint} wrapping the commands verbatim.
 *
 * @public
 */
export function expansionFromSuggestedCommands(
  commands: ReadonlyArray<string>,
): SuggestedCommandsHint {
  return { kind: 'suggested-commands', commands };
}

/**
 * Adapt a legacy `_nexus.suggestedNext` op list into an {@link ExpansionHint}.
 *
 * @param ops - The structured `ReadonlyArray<SuggestedNextOp>`.
 * @returns A {@link StructuredOpsHint} wrapping the ops verbatim.
 *
 * @public
 */
export function expansionFromStructuredOps(ops: ReadonlyArray<SuggestedNextOp>): StructuredOpsHint {
  return { kind: 'structured-ops', ops };
}

/**
 * Type guard: narrow an {@link ExpansionHint} to its `_next`-directives variant.
 *
 * @param hint - The hint to test.
 * @returns `true` when `hint.kind === 'next-directives'`.
 *
 * @public
 */
export function isNextDirectivesHint(hint: ExpansionHint): hint is NextDirectivesHint {
  return hint.kind === 'next-directives';
}

/**
 * Type guard: narrow an {@link ExpansionHint} to its suggested-commands variant.
 *
 * @param hint - The hint to test.
 * @returns `true` when `hint.kind === 'suggested-commands'`.
 *
 * @public
 */
export function isSuggestedCommandsHint(hint: ExpansionHint): hint is SuggestedCommandsHint {
  return hint.kind === 'suggested-commands';
}

/**
 * Type guard: narrow an {@link ExpansionHint} to its structured-ops variant.
 *
 * @param hint - The hint to test.
 * @returns `true` when `hint.kind === 'structured-ops'`.
 *
 * @public
 */
export function isStructuredOpsHint(hint: ExpansionHint): hint is StructuredOpsHint {
  return hint.kind === 'structured-ops';
}
