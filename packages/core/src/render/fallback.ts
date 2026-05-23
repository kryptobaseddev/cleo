/**
 * Generic kind-based fallback renderer.
 *
 * When {@link ./render-envelope.ts | renderEnvelopeForHuman} cannot find a
 * `(command, kind)`-specific renderer, it delegates here. The fallback covers
 * every {@link RenderableEnvelope} variant using inline string concatenation
 * plus the B4 helpers ({@link ./helpers.ts | kvBlock, dataTable, truncated}).
 *
 * Constraints (ADR-077):
 *   - Pure function — no I/O, no DB access.
 *   - No imports from `packages/animations/` — B3 primitives are owned by B3
 *     and wired in by the per-command renderers landing in B6/B7/B8.
 *   - No emoji icons — B2 (T10127) owns the icon enum.
 *
 * @epic T10114
 * @task T10130
 */

import type {
  FlatTreeNode,
  GroupedListResponse,
  ListResponse,
  RenderableEnvelope,
  SectionResponse,
  TableResponse,
  TreeResponse,
} from '@cleocode/contracts';
import { type DataTableColumn, dataTable, kvBlock } from './helpers.js';
import type { RenderOptions } from './types.js';

/**
 * Render any {@link RenderableEnvelope} to a human-readable string using the
 * generic per-kind fallback strategy.
 *
 * @typeParam T — envelope payload shape (opaque to the fallback).
 */
export function renderFallback<T>(envelope: RenderableEnvelope<T>, _opts: RenderOptions): string {
  switch (envelope.kind) {
    case 'tree':
      return renderTreeFallback(envelope.data);
    case 'table':
      return renderTableFallback(envelope.data);
    case 'list':
      return renderListFallback(envelope.data);
    case 'grouped-list':
      return renderGroupedListFallback(envelope.data);
    case 'section':
      return renderSectionFallback(envelope.data);
    case 'single':
      return renderSingleFallback(envelope.data);
    case 'generic':
      return renderGenericFallback(envelope.data);
  }
}

// ---------------------------------------------------------------------------
// tree
// ---------------------------------------------------------------------------

/**
 * Walk a {@link TreeResponse} and emit one line per node with depth-based
 * indentation. Last-sibling detection uses the next-node lookahead — when the
 * next row's depth is less than or equal to the current row, the current row
 * is a last sibling.
 *
 * NO emoji icons (B2 owns those); plain ASCII bracket prefixes derived from
 * `node.kind` give a stable, lossless rendering.
 */
function renderTreeFallback<T>(data: TreeResponse<T>): string {
  const nodes = data.tree;
  if (nodes.length === 0) return '';

  // Track per-depth "is the path to this depth still on a last-sibling chain?"
  // so we can draw correct continuation pipes without needing parent ids.
  const lastAtDepth: boolean[] = [];
  const lines: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as FlatTreeNode<T>;
    const next = nodes[i + 1];
    // Current row is a last sibling when no later node is at the same depth
    // before depth decreases below it (lookahead until depth drops below).
    const isLast = isLastSibling(nodes, i);
    lastAtDepth[node.depth] = isLast;

    const prefix = renderTreePrefix(node.depth, isLast, lastAtDepth);
    const kindTag = `[${node.kind}]`;
    lines.push(`${prefix}${kindTag} ${node.id} ${node.title}`);
    // If this row is last AND next exists at shallower depth, we don't strictly
    // need to clear deeper levels — the next iteration recomputes from scratch.
    void next;
  }

  return lines.join('\n');
}

/**
 * Detect whether `nodes[i]` is the final sibling at its depth — true when no
 * later node at the same depth appears before depth drops below `node.depth`.
 */
function isLastSibling<T>(nodes: ReadonlyArray<FlatTreeNode<T>>, i: number): boolean {
  const cur = nodes[i] as FlatTreeNode<T>;
  for (let j = i + 1; j < nodes.length; j++) {
    const candidate = nodes[j] as FlatTreeNode<T>;
    if (candidate.depth < cur.depth) return true;
    if (candidate.depth === cur.depth) return false;
  }
  return true;
}

/**
 * Build the indent prefix string for a tree row.
 *
 * - Ancestors that are still on a last-sibling chain contribute spaces.
 * - Ancestors with more siblings contribute a vertical pipe.
 * - The final segment is `└─ ` for last siblings, `├─ ` otherwise.
 * - Depth 0 (root) gets no prefix.
 */
function renderTreePrefix(depth: number, isLast: boolean, lastAtDepth: boolean[]): string {
  if (depth === 0) return '';
  let out = '';
  for (let d = 0; d < depth - 1; d++) {
    out += lastAtDepth[d] === true ? '   ' : '│  ';
  }
  out += isLast ? '└─ ' : '├─ ';
  return out;
}

// ---------------------------------------------------------------------------
// table
// ---------------------------------------------------------------------------

/**
 * Delegate to the B4 `dataTable` helper. Each schema column becomes a
 * `DataTableColumn` whose getter looks up `row[column.key]` and applies any
 * supplied `format` function (otherwise falls back to `String(value)`).
 */
function renderTableFallback<T>(data: TableResponse<T>): string {
  const columns: DataTableColumn<T>[] = data.schema.columns.map((col) => ({
    header: col.header,
    get: (row) => {
      const raw = (row as Record<string, unknown>)[col.key];
      if (col.format) return col.format(raw);
      return String(raw ?? '');
    },
    ...(typeof col.width === 'number' ? { maxWidth: col.width } : {}),
  }));
  return dataTable(data.rows, columns);
}

// ---------------------------------------------------------------------------
// list / grouped-list
// ---------------------------------------------------------------------------

/** Render one item via `kvBlock` when it's an object, else `String(item)`. */
function renderListItem<T>(item: T): string {
  if (item !== null && typeof item === 'object') {
    const rows: Array<[string, string]> = Object.entries(item as Record<string, unknown>).map(
      ([k, v]) => [k, String(v ?? '')],
    );
    return kvBlock(rows, 0);
  }
  return String(item);
}

function renderListFallback<T>(data: ListResponse<T>): string {
  if (data.items.length === 0) return '';
  return data.items.map((item) => `- ${renderListItem(item)}`).join('\n');
}

function renderGroupedListFallback<T>(data: GroupedListResponse<T>): string {
  if (data.groups.length === 0) return '';
  return data.groups
    .map((group) => {
      const header = group.label;
      const body =
        group.items.length === 0
          ? ''
          : `\n${group.items.map((item) => `- ${renderListItem(item)}`).join('\n')}`;
      return `${header}${body}`;
    })
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// section
// ---------------------------------------------------------------------------

function renderSectionFallback(data: SectionResponse): string {
  const headerPrefix = data.icon ? `${data.icon} ` : '';
  const header = `${headerPrefix}${data.header}`;
  if (data.items.length === 0) return header;
  const body = data.items.map((item) => `- ${item}`).join('\n');
  return `${header}\n${body}`;
}

// ---------------------------------------------------------------------------
// single / generic
// ---------------------------------------------------------------------------

function renderSingleFallback<T>(data: T): string {
  if (data !== null && typeof data === 'object') {
    const rows: Array<[string, string]> = Object.entries(data as Record<string, unknown>).map(
      ([k, v]) => [k, String(v ?? '')],
    );
    return kvBlock(rows);
  }
  return String(data);
}

function renderGenericFallback(data: Record<string, unknown>): string {
  const rows: Array<[string, string]> = Object.entries(data).map(([k, v]) => [k, String(v ?? '')]);
  return kvBlock(rows);
}
