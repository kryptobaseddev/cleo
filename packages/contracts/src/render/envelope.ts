/**
 * Typed render contracts — top-level `RenderableEnvelope<T>` discriminated union.
 *
 * Part of the Human Render Contract (Epic T10114, ADR-077). Every renderable
 * value flowing from CLEO commands to presenters MUST be wrapped in one of the
 * variants below. Presenters dispatch on `kind` to pick the right renderer.
 *
 * @epic T10114
 * @task T10141
 */

import type { GroupedListResponse, ListResponse } from './list.js';
import type { TableResponse } from './table.js';
import type { TreeResponse } from './tree.js';

/**
 * Free-form section block — a labelled header with an ordered set of
 * pre-formatted item strings. Used for ad-hoc human output that doesn't fit
 * the structured `tree` / `table` / `list` shapes.
 */
export interface SectionResponse {
  /** Heading rendered above the items. */
  readonly header: string;
  /** Optional icon hint — presenters MAY prepend it to the header. */
  readonly icon?: string;
  /** Pre-formatted item strings rendered as a bulleted block. */
  readonly items: ReadonlyArray<string>;
}

/**
 * Discriminated union of every renderable envelope variant CLEO presenters
 * understand.
 *
 * The `kind` field is the discriminator — narrow on it inside a `switch`
 * statement or via the per-kind type guards exported below.
 *
 * @typeParam T — caller-defined payload shape. For `single` it is the entire
 *                payload; for the collection variants it parameterises the
 *                inner response type. `section` and `generic` are independent
 *                of `T`.
 */
export type RenderableEnvelope<T> =
  | { readonly kind: 'tree'; readonly data: TreeResponse<T> }
  | { readonly kind: 'table'; readonly data: TableResponse<T> }
  | { readonly kind: 'list'; readonly data: ListResponse<T> }
  | { readonly kind: 'grouped-list'; readonly data: GroupedListResponse<T> }
  | { readonly kind: 'section'; readonly data: SectionResponse }
  | { readonly kind: 'single'; readonly data: T }
  | { readonly kind: 'generic'; readonly data: Record<string, unknown> };

/**
 * Type guard — narrows to the `tree` variant.
 */
export function isTreeEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'tree' }> {
  return env.kind === 'tree';
}

/**
 * Type guard — narrows to the `table` variant.
 */
export function isTableEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'table' }> {
  return env.kind === 'table';
}

/**
 * Type guard — narrows to the flat `list` variant.
 */
export function isListEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'list' }> {
  return env.kind === 'list';
}

/**
 * Type guard — narrows to the `grouped-list` variant.
 */
export function isGroupedListEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'grouped-list' }> {
  return env.kind === 'grouped-list';
}

/**
 * Type guard — narrows to the `section` variant.
 */
export function isSectionEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'section' }> {
  return env.kind === 'section';
}

/**
 * Type guard — narrows to the `single` variant.
 */
export function isSingleEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'single' }> {
  return env.kind === 'single';
}

/**
 * Type guard — narrows to the `generic` variant.
 */
export function isGenericEnvelope<T>(
  env: RenderableEnvelope<T>,
): env is Extract<RenderableEnvelope<T>, { kind: 'generic' }> {
  return env.kind === 'generic';
}
