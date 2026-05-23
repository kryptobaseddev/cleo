/**
 * Typed render contracts — list (flat) and grouped-list.
 *
 * Part of the Human Render Contract (Epic T10114, ADR-077). The list shape is
 * the canonical wire format for ordered or grouped sequential output —
 * presenters render each item according to `renderItem` (or a default).
 *
 * @epic T10114
 * @task T10140
 */

/**
 * Per-item rendering style hint for list responses.
 *
 * - `'text'`   — render the item as a plain string (default presenter behaviour).
 * - `'badge'`  — render with status / category styling.
 * - `'kv'`     — render as a key/value pair block.
 */
export type ListItemStyle = 'text' | 'badge' | 'kv';

/**
 * Flat list response — items rendered in `items` order.
 *
 * @typeParam T — caller-defined item payload shape.
 */
export interface ListResponse<T> {
  /** Item payloads in render order. */
  readonly items: ReadonlyArray<T>;
  /**
   * Total item count. May exceed `items.length` when the response is paginated
   * or truncated.
   */
  readonly total: number;
  /** Optional per-item rendering style hint. */
  readonly renderItem?: ListItemStyle;
}

/**
 * One labelled bucket inside a grouped list response.
 *
 * @typeParam T — caller-defined item payload shape.
 */
export interface ListGroup<T> {
  /** Stable group identifier — used for diff / equality, not display. */
  readonly key: string;
  /** Human-readable group label rendered above its items. */
  readonly label: string;
  /** Item payloads inside this group, in render order. */
  readonly items: ReadonlyArray<T>;
}

/**
 * Grouped list response — items split across labelled buckets.
 *
 * @typeParam T — caller-defined item payload shape.
 */
export interface GroupedListResponse<T> {
  /** Ordered list of labelled groups. */
  readonly groups: ReadonlyArray<ListGroup<T>>;
  /** Total item count across all groups. */
  readonly total: number;
}

/**
 * Runtime type guard for `ListResponse<T>`.
 *
 * Checks the envelope shape only — does not inspect item payloads against `T`.
 *
 * @param value — candidate value to inspect.
 * @returns `true` iff `value` matches the `ListResponse<T>` envelope shape.
 */
export function isListResponse<T>(value: unknown): value is ListResponse<T> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.items) && typeof v.total === 'number';
}

/**
 * Runtime type guard for `GroupedListResponse<T>`.
 *
 * Checks the envelope shape only — does not inspect item payloads against `T`.
 *
 * @param value — candidate value to inspect.
 * @returns `true` iff `value` matches the `GroupedListResponse<T>` envelope shape.
 */
export function isGroupedListResponse<T>(value: unknown): value is GroupedListResponse<T> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.groups) && typeof v.total === 'number';
}
