/**
 * Renderer for the generic `cleo tree <id>` envelope.
 *
 * Produces the human-readable view of {@link GenericTreeResult} envelopes
 * (parent + groups edges, walked to full depth, plus the upward ancestor
 * chain). Delegates the actual box-drawing to {@link renderTree} from
 * `@cleocode/animations/render` — this module owns ONLY the assembly:
 *
 * 1. Ancestor banner (when the rendered root sits below a broader root).
 * 2. `renderTree` output with {@link RelationIcon.GROUPS} (`⊂`) prepended
 *    to titles whose `metadata.edgeType === 'groups'`.
 * 3. Optional `--withDeps` / `--blockers` annotations appended below.
 *
 * @epic T10114
 * @task T10134
 * @see ADR-077-human-render-contract.md
 */

import { type AnimateContext, createAnimateContext } from '@cleocode/animations';
import { renderTree } from '@cleocode/animations/render';
import type { FlatTreeNode, TreeResponse } from '@cleocode/contracts';
import { ascii, KindIcon, pickIcon, RelationIcon } from '@cleocode/contracts/render/icon.js';
import type { GenericTreeMetadata, GenericTreeResult } from '@cleocode/core/internal';
import { getFormatContext } from '../format-context.js';
import { DIM, NC } from './colors.js';

/** Per-render options consumed by {@link renderGenericTree}. */
export interface RenderGenericTreeOptions {
  /** When `true`, append the direct `depends` list under each annotated node. */
  readonly withDeps: boolean;
  /**
   * When `true`, append the transitive blocker chain + leaf-blocker summary
   * under each blocked node. Requires `result.tree` to have been built with
   * `BuildGenericTreeOptions.withBlockers === true`.
   */
  readonly withBlockers: boolean;
  /**
   * Suppress decorations and emit one node ID per line — script-friendly. The
   * tree connectors are still drawn so the hierarchy stays visible.
   */
  readonly quiet: boolean;
  /**
   * Optional override for the {@link AnimateContext} that gates the renderer.
   *
   * Production callers OMIT this — the renderer resolves the context from
   * the CLI format context. Tests pass an explicit enabled context to bypass
   * the non-TTY / no-color silencing that {@link createAnimateContext}
   * applies in CI environments.
   */
  readonly ctx?: AnimateContext;
}

/**
 * Render a {@link GenericTreeResult} as a multi-line string suitable for
 * direct write to stdout.
 *
 * Returns an empty string for `--format=json` (the JSON branch is the
 * caller's responsibility).
 *
 * @param result - The envelope produced by `buildGenericTaskTree`.
 * @param opts   - Per-invocation render options.
 */
export function renderGenericTree(
  result: GenericTreeResult,
  opts: RenderGenericTreeOptions,
): string {
  const explicitCtx = opts.ctx !== undefined;
  const ctx = opts.ctx ?? resolveAnimateContext();
  if (!ctx.enabled) return '';

  if (opts.quiet) return renderQuiet(result);

  // ASCII fallback decision:
  //  - Explicit-ctx callers (tests, programmatic usage) decide via
  //    `ctx.inputs.noColor` — `NO_COLOR=1` in CI must not override an
  //    opt-in Unicode render.
  //  - Production callers resolve via {@link resolveAnimateContext}, which
  //    force-sets `noColor=false` so the gate stays enabled in non-TTY
  //    `--human` runs (T10352). For these, fall back to ASCII when
  //    `NO_COLOR` is set in the environment.
  const useAscii = explicitCtx
    ? ctx.inputs.noColor
    : ctx.inputs.noColor || process.env['NO_COLOR'] != null;
  const lines: string[] = [];

  // Ancestor banner — strict parent_id chain UPWARD from the rendered root.
  if (result.ancestors.length > 0) {
    lines.push(formatAncestorBanner(result.ancestors, useAscii));
    lines.push('');
  }

  // Tree body — transform titles so groups-edge nodes carry the `⊂` prefix
  // before delegating to the canonical box-drawing primitive. Forward
  // `asciiBoxDrawing` explicitly so the connector glyphs match the ancestor
  // banner — `renderTree` otherwise derives ASCII purely from
  // `ctx.inputs.noColor`, which T10352's force-enabled context zeroes out.
  const treeWithGlyphs = decorateGroupsEdges(result.tree, useAscii);
  const body = renderTree(treeWithGlyphs, { ctx, asciiBoxDrawing: useAscii });
  if (body) lines.push(body);

  // Optional annotations beneath each node.
  if (opts.withDeps || opts.withBlockers) {
    const annotations = renderAnnotations(result.tree, opts);
    if (annotations) lines.push(annotations);
  }

  return lines.join('\n');
}

/**
 * Build a TreeResponse whose groups-edge node titles carry the
 * {@link RelationIcon.GROUPS} (`⊂`) prefix.
 *
 * The wire envelope is immutable; we return a fresh object with cloned rows
 * so the upstream caller's data is not mutated.
 */
function decorateGroupsEdges(
  tree: TreeResponse<GenericTreeMetadata>,
  useAscii: boolean,
): TreeResponse<GenericTreeMetadata> {
  const glyph = useAscii ? ascii(RelationIcon.GROUPS) : RelationIcon.GROUPS;
  const prefix = `${glyph} `;
  const rows: FlatTreeNode<GenericTreeMetadata>[] = tree.tree.map((node) =>
    node.metadata.edgeType === 'groups' ? { ...node, title: `${prefix}${node.title}` } : node,
  );
  return { ...tree, tree: rows };
}

/**
 * Format the ancestor chain as a single banner line ordered root → … → root-1
 * so the user reads it left-to-right toward the rendered root.
 */
function formatAncestorBanner(
  ancestors: ReadonlyArray<FlatTreeNode<GenericTreeMetadata>>,
  useAscii: boolean,
): string {
  // ancestors[] is nearest-first; reverse for root-first display order.
  const ordered = [...ancestors].reverse();
  const parts = ordered.map((node) => {
    const icon = pickIcon(kindIconOf(node.kind), { noColor: useAscii });
    return `${icon} ${node.id}`;
  });
  const arrow = useAscii ? ' > ' : ' › ';
  const upGlyph = useAscii ? '^' : '↑';
  const tip = arrow.trim();
  const chain = parts.join(arrow);
  return `${DIM}${upGlyph} ${chain}${tip}(here)${NC}`;
}

/** Quiet mode — preorder ID list, one per line. */
function renderQuiet(result: GenericTreeResult): string {
  return result.tree.tree.map((node) => node.id).join('\n');
}

/**
 * Build the `--withDeps` / `--blockers` annotation block.
 *
 * Each annotation references the node by ID so the user can correlate it
 * with the rendered tree row above without ambiguity.
 */
function renderAnnotations(
  tree: TreeResponse<GenericTreeMetadata>,
  opts: RenderGenericTreeOptions,
): string {
  const lines: string[] = [];
  for (const node of tree.tree) {
    if (opts.withDeps && node.metadata.depends.length > 0) {
      lines.push(`${DIM}  ${node.id} depends-on: ${node.metadata.depends.join(', ')}${NC}`);
    }
    if (opts.withBlockers) {
      const chain = node.metadata.blockerChain ?? [];
      if (chain.length > 0) {
        lines.push(`${DIM}  ${node.id} blocker-chain: ${chain.join(' → ')}${NC}`);
      }
      const leaves = node.metadata.leafBlockers ?? [];
      if (leaves.length > 0) {
        lines.push(`${DIM}  ${node.id} leaf-blockers: ${leaves.join(', ')}${NC}`);
      }
    }
  }
  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

/** Map a {@link FlatTreeNode.kind} to the corresponding {@link KindIcon}. */
function kindIconOf(kind: FlatTreeNode<GenericTreeMetadata>['kind']): KindIcon {
  switch (kind) {
    case 'saga':
      return KindIcon.SAGA;
    case 'epic':
      return KindIcon.EPIC;
    case 'task':
      return KindIcon.TASK;
    case 'subtask':
      return KindIcon.SUBTASK;
  }
}

/**
 * Resolve the {@link AnimateContext} from the current CLI format context.
 *
 * Mirrors `animation-bridge.ts` — `getFormatContext()` always returns a
 * sensible default (JSON, no quiet) when the preAction hook has not run, so
 * tests and direct callers inherit a silent context without extra branching.
 *
 * T10352: when format is human, force `isTTY=true` + `noColor=false` so the
 * static render path is not silenced in non-TTY contexts (pipes, redirects,
 * CI logs). The TTY / NO_COLOR gates in {@link createAnimateContext} are
 * correct for animation primitives — spinners must not flicker in pipes —
 * but a static tree render explicitly requested via `--human` should always
 * emit. Forcing `noColor=false` keeps the gate enabled; the
 * NO_COLOR-aware ASCII fallback inside {@link renderGenericTree} reads
 * `process.env.NO_COLOR` directly so the box-drawing degrades to ASCII
 * without going silent.
 */
function resolveAnimateContext(): AnimateContext {
  const fmt = getFormatContext();
  if (fmt.format !== 'human') {
    return createAnimateContext({ flagResolution: fmt });
  }
  return createAnimateContext({
    flagResolution: fmt,
    isTTY: true,
    noColor: false,
  });
}
