/**
 * Static tree rendering — box-drawing hierarchy with depth, fold, and icons.
 *
 * @remarks
 * Part of the Human Render Contract (Epic T10114, ADR-077). Consumes a
 * {@link TreeResponse} (flat, pre-order list of {@link FlatTreeNode}s) and
 * emits a box-drawing tree that mirrors the canonical Saga → Epic → Task →
 * Subtask layout.
 *
 * Connector glyphs:
 * - `├─` non-last child
 * - `└─` last child
 * - `│ ` vertical continuation across a non-last ancestor
 * - `   ` last-sibling ancestor (no vertical bar)
 *
 * Each rendered row carries the matching {@link KindIcon} prefix and a
 * trailing {@link StatusIcon}. When the {@link AnimateContext} indicates
 * `noColor` mode (or `opts.asciiBoxDrawing === true`) glyphs collapse to
 * ASCII fallbacks (`+-`, `| `, `   `) and icons resolve via {@link ascii}.
 *
 * @epic T10114
 * @task T10128
 * @subtask T10142
 */

import { ascii, KindIcon, StatusIcon } from '@cleocode/contracts/render/icon.js';
import type {
  FlatTreeNode,
  TreeNodeKind,
  TreeNodeStatus,
  TreeResponse,
} from '@cleocode/contracts/render/tree.js';
import type { AnimateContext } from '../animate-context.js';

/** Options for {@link renderTree}. */
export interface RenderTreeViewOptions {
  /** Render gate — primitive returns `''` when `enabled === false`. */
  readonly ctx: AnimateContext;
  /**
   * When a node has more direct children than this threshold, only the first
   * `foldAt - 1` are rendered and a `…` summary line replaces the rest.
   *
   * @defaultValue `50`
   */
  readonly foldAt?: number;
  /**
   * When `true`, force ASCII box-drawing glyphs regardless of the context's
   * `noColor` signal. When `false`, force Unicode. When omitted, defer to
   * `ctx.inputs.noColor`.
   */
  readonly asciiBoxDrawing?: boolean;
}

/** Default fold threshold — match ADR-077 §3 guidance. */
const DEFAULT_FOLD_AT = 50;

/**
 * Connector glyph set — vertical bar continuations, branch / leaf elbows,
 * and blank spacer.
 */
interface ConnectorSet {
  readonly branch: string;
  readonly leaf: string;
  readonly vertical: string;
  readonly blank: string;
}

/** Unicode connector glyphs. */
const CONNECTOR_UNICODE: ConnectorSet = Object.freeze({
  branch: '├─ ',
  leaf: '└─ ',
  vertical: '│  ',
  blank: '   ',
});

/** ASCII fallback connector glyphs. */
const CONNECTOR_ASCII: ConnectorSet = Object.freeze({
  branch: '+- ',
  leaf: '+- ',
  vertical: '|  ',
  blank: '   ',
});

/** Pretty kind label appended to the fold summary line. */
const KIND_LABEL: Readonly<Record<TreeNodeKind, string>> = {
  saga: 'sagas',
  epic: 'epics',
  task: 'tasks',
  subtask: 'subtasks',
};

/**
 * Render a {@link TreeResponse} as a multi-line box-drawing tree.
 *
 * @param resp - The flattened tree response to render.
 * @param opts - Render gate + fold + ASCII overrides.
 * @returns The formatted tree. Empty when `opts.ctx.enabled` is `false`.
 *
 * @example
 * ```ts
 * renderTree(saga, { ctx });
 * // 🌲 SG-WORKTRUNK-OWN ✅
 * // ├─ 📋 T9977 Worktree native ownership ✅
 * // │  ├─ • T9983 Reader cache 🚧
 * // │  └─ • T9984 NAPI shim ✅
 * // └─ 📋 T9981 Doctor budget ⏳
 * ```
 */
export function renderTree<T>(resp: TreeResponse<T>, opts: RenderTreeViewOptions): string {
  if (!opts.ctx.enabled) return '';
  if (resp.tree.length === 0) return '';

  const useAscii = opts.asciiBoxDrawing ?? opts.ctx.inputs.noColor;
  const connectors = useAscii ? CONNECTOR_ASCII : CONNECTOR_UNICODE;
  const foldAt = opts.foldAt ?? DEFAULT_FOLD_AT;

  // Build the parent → ordered-children map from the pre-order flat list.
  // Preserves the input order — callers control sibling order via the wire
  // payload, this primitive must not re-sort.
  const childrenByParent = new Map<string, FlatTreeNode<T>[]>();
  let rootNode: FlatTreeNode<T> | undefined;
  for (const node of resp.tree) {
    if (node.parentId === null) {
      if (node.id === resp.root) rootNode = node;
      continue;
    }
    const bucket = childrenByParent.get(node.parentId);
    if (bucket) bucket.push(node);
    else childrenByParent.set(node.parentId, [node]);
  }

  if (rootNode === undefined) return '';

  const lines: string[] = [];

  // Root line — no connector prefix.
  lines.push(formatRow(rootNode, '', useAscii));

  emitChildren(rootNode.id, [], childrenByParent, connectors, foldAt, useAscii, lines);

  return lines.join('\n');
}

/**
 * Recursively emit children of `parentId` with the correct ancestor prefix.
 *
 * @param ancestorIsLast - For each ancestor, whether it was the last sibling
 *   in its parent's child list. Drives the `│ ` vs `   ` continuation glyph.
 * @param connectors - Resolved connector set (Unicode or ASCII).
 */
function emitChildren<T>(
  parentId: string,
  ancestorIsLast: ReadonlyArray<boolean>,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<FlatTreeNode<T>>>,
  connectors: ConnectorSet,
  foldAt: number,
  useAscii: boolean,
  out: string[],
): void {
  const children = childrenByParent.get(parentId);
  if (children === undefined || children.length === 0) return;

  const ancestorPrefix = ancestorIsLast
    .map((isLast) => (isLast ? connectors.blank : connectors.vertical))
    .join('');

  const shouldFold = children.length > foldAt;
  const visibleCount = shouldFold ? foldAt - 1 : children.length;
  const visible = children.slice(0, visibleCount);

  for (let i = 0; i < visible.length; i++) {
    const child = visible[i];
    if (child === undefined) continue;
    const isLastInBatch = !shouldFold && i === children.length - 1;
    const connector = isLastInBatch ? connectors.leaf : connectors.branch;
    out.push(formatRow(child, `${ancestorPrefix}${connector}`, useAscii));
    emitChildren(
      child.id,
      [...ancestorIsLast, isLastInBatch],
      childrenByParent,
      connectors,
      foldAt,
      useAscii,
      out,
    );
  }

  if (shouldFold) {
    const hidden = children.length - visibleCount;
    const sampleKind = children[0]?.kind ?? 'task';
    const label = KIND_LABEL[sampleKind];
    out.push(
      `${ancestorPrefix}${connectors.leaf}… and ${hidden} more ${label} (run cleo tree ${parentId} to expand)`,
    );
  }
}

/** Build a single tree row: `<connectors><kind icon> <title> <status icon>`. */
function formatRow<T>(node: FlatTreeNode<T>, prefix: string, useAscii: boolean): string {
  const kindIcon = resolveKindIcon(node.kind, useAscii);
  const statusIcon = resolveStatusIcon(node.status, useAscii);
  return `${prefix}${kindIcon} ${node.title} ${statusIcon}`.trimEnd();
}

/** Pick the {@link KindIcon} for a node kind, falling back to ASCII when asked. */
function resolveKindIcon(kind: TreeNodeKind, useAscii: boolean): string {
  const icon = KIND_BY_NODE_KIND[kind];
  return useAscii ? ascii(icon) : icon;
}

/** Pick the {@link StatusIcon} for a node status, falling back to ASCII. */
function resolveStatusIcon(status: TreeNodeStatus, useAscii: boolean): string {
  const icon = STATUS_BY_NODE_STATUS[status];
  return useAscii ? ascii(icon) : icon;
}

/** Node-kind → KindIcon. Subtask uses bullet-like glyph per ADR-077. */
const KIND_BY_NODE_KIND: Readonly<Record<TreeNodeKind, KindIcon>> = {
  saga: KindIcon.SAGA,
  epic: KindIcon.EPIC,
  task: KindIcon.TASK,
  subtask: KindIcon.SUBTASK,
};

/** Node-status → StatusIcon. */
const STATUS_BY_NODE_STATUS: Readonly<Record<TreeNodeStatus, StatusIcon>> = {
  pending: StatusIcon.PENDING,
  in_progress: StatusIcon.ACTIVE,
  done: StatusIcon.DONE,
  blocked: StatusIcon.BLOCKED,
  cancelled: StatusIcon.CANCELLED,
  archived: StatusIcon.ARCHIVED,
};
