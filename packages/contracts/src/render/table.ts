/**
 * Typed render contracts — table (column-schema-driven rows).
 *
 * Part of the Human Render Contract (Epic T10114, ADR-077). The table shape is
 * the canonical wire format for tabular CLI output — presenters consume the
 * schema to compute widths, headers, and per-cell formatting.
 *
 * @epic T10114
 * @task T10139
 */

/**
 * Horizontal alignment hint for a column.
 */
export type ColumnAlign = 'left' | 'right' | 'center';

/**
 * Schema entry for a single table column.
 *
 * `key` MUST be a string-typed property on the row payload `T`. Presenters
 * are expected to extract `row[column.key]` and pipe it through `format` when
 * one is supplied.
 *
 * @typeParam T — caller-defined row payload shape.
 */
export interface TableColumn<T> {
  /** Property key on the row payload. */
  readonly key: keyof T & string;
  /** Display header rendered above the column. */
  readonly header: string;
  /** Optional alignment hint. Defaults to `'left'`. */
  readonly align?: ColumnAlign;
  /** Optional fixed width (character count) hint. */
  readonly width?: number;
  /**
   * Optional per-cell formatter. Receives the raw value at `row[key]` and
   * returns the display string. When absent, presenters call `String(value)`.
   */
  readonly format?: (value: unknown) => string;
}

/**
 * Column-schema metadata that accompanies every table response.
 *
 * @typeParam T — caller-defined row payload shape.
 */
export interface TableSchema<T> {
  /** Ordered list of column descriptors. Rendering order matches this order. */
  readonly columns: ReadonlyArray<TableColumn<T>>;
}

/**
 * Top-level envelope returned by a table-shaped renderer.
 *
 * @typeParam T — caller-defined row payload shape.
 */
export interface TableResponse<T> {
  /** Row payloads in the order they should be rendered. */
  readonly rows: ReadonlyArray<T>;
  /** Column schema — drives presenter formatting. */
  readonly schema: TableSchema<T>;
  /**
   * Total row count. May exceed `rows.length` when the response is paginated
   * or truncated; presenters use this to render "showing N of M" hints.
   */
  readonly total: number;
}

/**
 * Runtime type guard for `TableResponse<T>`.
 *
 * Checks the envelope shape only — does not inspect row payloads against `T`.
 *
 * @param value — candidate value to inspect.
 * @returns `true` iff `value` matches the `TableResponse<T>` envelope shape.
 */
export function isTableResponse<T>(value: unknown): value is TableResponse<T> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.rows)) return false;
  if (typeof v.total !== 'number') return false;
  const schema = v.schema as Record<string, unknown> | undefined;
  if (typeof schema !== 'object' || schema === null) return false;
  return Array.isArray(schema.columns);
}
