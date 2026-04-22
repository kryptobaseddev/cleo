/**
 * Pure tree formatter — presentation-agnostic dependency tree rendering.
 *
 * Exports {@link formatTree} which renders a flat tree node array into one of
 * four output modes (rich, json, markdown, quiet) without importing any CLI
 * or platform-specific module.  ANSI colors are injected by the caller via
 * the optional `colorize` callback so that this module remains dependency-free
 * of terminal utilities.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Output mode for {@link formatTree}.
 *
 * - `'rich'`     — Terminal-friendly output with ASCII/Unicode connectors,
 *                  status symbols, priority color (via {@link FormatOpts.colorize}),
 *                  and blocker indicators.
 * - `'json'`     — Returns `JSON.stringify({ tree: nodes })` for machine
 *                  consumers that already have the data payload.
 * - `'markdown'` — GitHub-flavored Markdown: indented list with `[status]`
 *                  prefix and no ANSI sequences.
 * - `'quiet'`    — ASCII connector hierarchy with ID as the last token on each
 *                  line, safe for `awk '{print $NF}'` extraction.
 */
export type FormatMode = 'rich' | 'json' | 'markdown' | 'quiet';

/**
 * Color style tokens passed to {@link FormatOpts.colorize}.
 *
 * The core formatter never applies ANSI directly — it hands style tokens to
 * the caller-supplied `colorize` function.  CLI renderers inject ANSI; Studio
 * or API callers can inject HTML classes or return the text verbatim.
 */
export type ColorStyle =
  | 'bold'
  | 'dim'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'reset';

/**
 * Connector characters used when drawing the ASCII/Unicode tree.
 *
 * Override to use plain ASCII on terminals that do not support Unicode
 * box-drawing, or to use a different visual style.
 */
export interface TreeConnectors {
  /** Branch connector — not the last child: `├── ` */
  branch: string;
  /** Last child connector: `└── ` */
  last: string;
  /** Vertical pipe continuation: `│   ` */
  vertical: string;
  /** Empty continuation (after last child): `    ` */
  space: string;
}

/**
 * Options for {@link formatTree}.
 */
export interface FormatOpts {
  /**
   * Output mode.
   *
   * @defaultValue `'rich'`
   */
  mode?: FormatMode;

  /**
   * Color injection callback.
   *
   * Called as `colorize(text, style)`.  The default implementation is the
   * identity function (returns `text` unchanged) so core output is plain when
   * no colorize is provided.
   *
   * CLI renderers inject ANSI via the `colors.ts` helper; Studio callers may
   * inject CSS class names or simply omit this option.
   *
   * @example
   * // CLI usage — inject ANSI via colors helper
   * const output = formatTree(nodes, {
   *   colorize: (text, style) => applyAnsi(text, style),
   * });
   */
  colorize?: (text: string, style: ColorStyle) => string;

  /**
   * Connector overrides for the ASCII/Unicode tree skeleton.
   *
   * Only the `connectors` subkey is supported; future subkeys may be added
   * here without breaking the interface.
   */
  symbols?: {
    connectors?: Partial<TreeConnectors>;
  };

  /**
   * When `true`, each task in the tree output has its direct dependency chain
   * inlined below it (all four modes).
   *
   * - `rich`     — indented dim line `← depends on: T1195 (done), T1198 (pending)`
   * - `markdown` — nested `  - depends on: [T1195](#T1195), [T1198](#T1198)` list item
   * - `json`     — `depends` array already present on each node (no change needed)
   * - `quiet`    — skipped (quiet mode is for scripts that want IDs only)
   *
   * Only tasks that have at least one entry in their `depends` array emit a
   * dep line.  Tasks with an empty `depends` array emit nothing extra.
   *
   * @defaultValue `false`
   */
  withDeps?: boolean;

  /**
   * When `true`, each blocked task in the tree output has its transitive
   * blocker chain rendered below it.
   *
   * The `blockerChain` and `leafBlockers` fields must already be populated on
   * the nodes (via `coreTaskTree(..., true)` at the data layer).
   *
   * Per-mode behaviour:
   * - `rich`     — indented dim lines with `↳ chain:` arrow notation and a
   *                distinct color for leaf blockers (cyan).
   * - `markdown` — nested list items `  - blocker chain: T200 → T198 → T199 (leaf)`.
   * - `json`     — `blockerChain` and `leafBlockers` arrays are already embedded
   *                on each node; no extra rendering needed.
   * - `quiet`    — skipped (scripts should use `--format json` for chain data).
   *
   * Only nodes whose `blockerChain` is non-empty emit chain lines.
   *
   * Compatible with `withDeps`: when both flags are set, the dep line is
   * rendered first, followed by the blocker chain lines.
   *
   * @defaultValue `false`
   *
   * @example
   * ```typescript
   * const out = formatTree(nodes, { mode: 'rich', withBlockers: true });
   * // ↳ chain: T1200 → T1198 → T1199 (leaf)
   * ```
   */
  withBlockers?: boolean;
}

/**
 * A single node in the flat tree array produced by `tasks.tree`.
 *
 * Children are embedded directly in the node rather than being a separate
 * lookup table so that recursive rendering is straightforward.
 */
export interface FlatTreeNode {
  /** Task identifier, e.g. `"T001"`. */
  id: string;
  /** Human-readable task title. */
  title: string;
  /** Task status string, e.g. `"pending"`, `"active"`, `"done"`. */
  status: string;
  /** Task priority string, e.g. `"critical"`, `"high"`, `"medium"`, `"low"`. */
  priority?: string;
  /**
   * Raw direct dependency IDs from the task record.
   *
   * All dep IDs are listed here regardless of the referenced task's status.
   * Use {@link blockedBy} for the subset that are still open.
   * Populated by Wave 2 (T1199) enrichment in `buildTreeNode`.
   */
  depends?: string[];
  /** Open dependency IDs blocking this task.  Present after T1199 enrichment. */
  blockedBy?: string[];
  /**
   * Whether the task is immediately actionable (no open deps, not yet done).
   * Present after T1199 enrichment.
   */
  ready?: boolean;
  /**
   * Full transitive blocker chain for this task.
   *
   * Every open dependency reachable by walking the `depends` graph upstream
   * (deduplicated, cycle-safe).  Only present when `withBlockers` was
   * requested at tree-build time (T1206).
   */
  blockerChain?: string[];
  /**
   * Leaf-level blockers — root-cause tasks that must be resolved first.
   *
   * A subset of `blockerChain` whose own dependencies are all resolved (or
   * that have no dependencies).  Only present when `withBlockers` was
   * requested at tree-build time (T1206).
   */
  leafBlockers?: string[];
  /** Nested child nodes. */
  children?: FlatTreeNode[];
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONNECTORS: TreeConnectors = {
  branch: '├── ', // ├──
  last: '└── ', // └──
  vertical: '│   ', // │
  space: '    ',
};

/**
 * Maps a status string to a compact display symbol.
 *
 * Unicode codepoints match {@link TASK_STATUS_SYMBOLS_UNICODE} from
 * `@cleocode/contracts` so that core formatter output is consistent with
 * the CLI renderer (no import needed — values are inlined for portability).
 */
const STATUS_SYMBOLS: Record<string, string> = {
  pending: '○', // ○  not yet started
  active: '◉', // ◉  in progress
  done: '✓', // ✓  complete
  blocked: '⊗', // ⊗  cannot advance
  cancelled: '✗', // ✗  abandoned
  archived: '▣', // ▣  stored, inactive
  proposed: '◇', // ◇  tier-2 proposal queue
};

function defaultStatusSymbol(status: string): string {
  return STATUS_SYMBOLS[status] ?? '?';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format a flat tree node array as a string in the requested mode.
 *
 * The function is pure — it has no side-effects and does not read from
 * `process.env` or the filesystem.  All terminal concerns are delegated to
 * the caller through {@link FormatOpts.colorize}.
 *
 * @param nodes - Array of {@link FlatTreeNode} objects (top-level children of
 *                the tree root).  May be empty — returns `''` in quiet mode
 *                and `'No tree data.'` in other modes.
 * @param opts  - Rendering options.  All fields are optional.
 * @returns     A formatted string in the requested mode.
 *
 * @example
 * // Rich mode — plain text (no colorize), Unicode connectors
 * const plain = formatTree(nodes, { mode: 'rich' });
 *
 * @example
 * // Rich mode — with ANSI color injection
 * const colored = formatTree(nodes, {
 *   mode: 'rich',
 *   colorize: (text, style) => applyAnsi(text, style),
 * });
 *
 * @example
 * // JSON mode — machine-readable passthrough
 * const json = formatTree(nodes, { mode: 'json' });
 * const parsed = JSON.parse(json); // { tree: [...] }
 *
 * @example
 * // Markdown mode — for GitHub issue comments
 * const md = formatTree(nodes, { mode: 'markdown' });
 *
 * @example
 * // Quiet mode — IDs only, hierarchy preserved, safe for awk
 * const quiet = formatTree(nodes, { mode: 'quiet' });
 */
export function formatTree(nodes: FlatTreeNode[], opts?: FormatOpts): string {
  const mode = opts?.mode ?? 'rich';
  const colorize = opts?.colorize ?? identity;
  const withDeps = opts?.withDeps ?? false;
  const withBlockers = opts?.withBlockers ?? false;
  const connectors: TreeConnectors = {
    ...DEFAULT_CONNECTORS,
    ...(opts?.symbols?.connectors ?? {}),
  };

  switch (mode) {
    case 'json':
      return JSON.stringify({ tree: nodes });

    case 'markdown':
      if (!nodes.length) return 'No tree data.';
      return formatTreeMarkdown(nodes, 0, withDeps, withBlockers);

    case 'quiet':
      if (!nodes.length) return '';
      // quiet mode omits dep/blocker lines — callers wanting chain data use rich/markdown/json
      return formatTreeQuiet(nodes, '', connectors);

    default:
      if (!nodes.length) return 'No tree data.';
      return formatTreeRich(nodes, '', connectors, colorize, withDeps, withBlockers);
  }
}

// ---------------------------------------------------------------------------
// Internal renderers
// ---------------------------------------------------------------------------

/**
 * Render tree nodes in rich terminal mode.
 *
 * Recursion applies the same connector logic used by the CLI renderer, so
 * output is byte-identical when `colorize` injects equivalent ANSI sequences.
 *
 * @param nodes        - Nodes at the current level.
 * @param prefix       - Accumulated left-padding from parent levels.
 * @param connectors   - Connector characters.
 * @param colorize     - Color injection callback.
 * @param withDeps     - When true, emit a dim dep line below tasks that have deps.
 * @param withBlockers - When true, emit blocker chain lines below blocked tasks.
 */
function formatTreeRich(
  nodes: FlatTreeNode[],
  prefix: string,
  connectors: TreeConnectors,
  colorize: (text: string, style: ColorStyle) => string,
  withDeps: boolean,
  withBlockers: boolean,
): string {
  const lines: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector = isLast ? connectors.last : connectors.branch;
    const childPrefix = isLast ? prefix + connectors.space : prefix + connectors.vertical;

    const id = node.id;
    const title = node.title;
    const status = node.status;
    const sSym = defaultStatusSymbol(status);

    const boldId = colorize(id, 'bold');
    const coloredTitle = applyPriorityColor(title, node.priority, colorize);
    const indicator = buildBlockerIndicator(node.blockedBy, node.ready, colorize);

    lines.push(`${prefix}${connector}${sSym}${indicator} ${boldId} ${coloredTitle}`);

    // Inline dep line for --with-deps: only when node has at least one dep.
    if (withDeps && node.depends?.length) {
      const depLabel = buildRichDepLine(node.depends, childPrefix, colorize);
      lines.push(depLabel);
    }

    // Blocker chain lines for --blockers: only when chain is non-empty.
    if (withBlockers && node.blockerChain?.length) {
      const chainLines = buildRichBlockerChainLines(
        node.blockerChain,
        node.leafBlockers ?? [],
        childPrefix,
        colorize,
      );
      for (const cl of chainLines) {
        lines.push(cl);
      }
    }

    if (node.children?.length) {
      lines.push(
        formatTreeRich(node.children, childPrefix, connectors, colorize, withDeps, withBlockers),
      );
    }
  }

  return lines.join('\n');
}

/**
 * Render tree nodes in quiet mode.
 *
 * Connectors are preserved so the hierarchy is visible; the ID is the last
 * token on each line (extractable with `awk '{print $NF}'`).
 *
 * @param nodes      - Nodes at the current level.
 * @param prefix     - Accumulated left-padding from parent levels.
 * @param connectors - Connector characters.
 */
function formatTreeQuiet(
  nodes: FlatTreeNode[],
  prefix: string,
  connectors: TreeConnectors,
): string {
  const lines: string[] = [];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const isLast = i === nodes.length - 1;
    const connector = isLast ? connectors.last : connectors.branch;
    const childPrefix = isLast ? prefix + connectors.space : prefix + connectors.vertical;

    lines.push(`${prefix}${connector}${node.id}`);

    if (node.children?.length) {
      lines.push(formatTreeQuiet(node.children, childPrefix, connectors));
    }
  }

  return lines.join('\n');
}

/**
 * Render tree nodes as GitHub-flavored Markdown.
 *
 * Indentation uses two spaces per level.  No ANSI sequences are emitted.
 *
 * @param nodes        - Nodes at the current level.
 * @param depth        - Current indentation depth (0-based).
 * @param withDeps     - When true, emit a nested dep list item below tasks that have deps.
 * @param withBlockers - When true, emit blocker chain list items below blocked tasks.
 */
function formatTreeMarkdown(
  nodes: FlatTreeNode[],
  depth: number,
  withDeps: boolean,
  withBlockers: boolean,
): string {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const node of nodes) {
    lines.push(`${indent}- [${node.status}] ${node.id} ${node.title}`);

    // Inline dep line for --with-deps: only when node has at least one dep.
    if (withDeps && node.depends?.length) {
      const depLinks = node.depends.map((depId) => `[${depId}](#${depId})`).join(', ');
      lines.push(`${indent}  - depends on: ${depLinks}`);
    }

    // Blocker chain items for --blockers: only when chain is non-empty.
    if (withBlockers && node.blockerChain?.length) {
      const leafSet = new Set(node.leafBlockers ?? []);
      const chainStr = node.blockerChain
        .map((id) => (leafSet.has(id) ? `${id} (leaf)` : id))
        .join(' → ');
      lines.push(`${indent}  - blocker chain: ${chainStr}`);
      if (node.leafBlockers?.length) {
        lines.push(`${indent}  - leaf-blockers: ${node.leafBlockers.join(', ')}`);
      }
    }

    if (node.children?.length) {
      lines.push(formatTreeMarkdown(node.children, depth + 1, withDeps, withBlockers));
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/** Identity function — returns text unchanged (default colorize). */
function identity(text: string, _style: ColorStyle): string {
  return text;
}

/**
 * Apply priority-based color to a title string via the caller's colorize.
 *
 * Maps priority strings to {@link ColorStyle} tokens:
 * - `'critical'` → `'red'`
 * - `'high'`     → `'yellow'`
 * - `'medium'`   → `'blue'`
 * - `'low'`      → `'dim'`
 * - (none/other) → no color applied
 *
 * @param title    - Task title string.
 * @param priority - Task priority string (may be undefined).
 * @param colorize - Color injection callback.
 */
function applyPriorityColor(
  title: string,
  priority: string | undefined,
  colorize: (text: string, style: ColorStyle) => string,
): string {
  switch (priority) {
    case 'critical':
      return colorize(title, 'red');
    case 'high':
      return colorize(title, 'yellow');
    case 'medium':
      return colorize(title, 'blue');
    case 'low':
      return colorize(title, 'dim');
    default:
      return title;
  }
}

/**
 * Build a blocker indicator string for rich mode.
 *
 * - Blocked by N open deps → `colorize("⊗(N)", "red")`
 * - Ready (no open deps, immediately actionable) → `colorize("●", "green")`
 * - Otherwise → `""`
 *
 * @param blockedBy - Open dependency IDs (may be undefined for pre-T1199 nodes).
 * @param ready     - Whether the task is immediately actionable.
 * @param colorize  - Color injection callback.
 */
function buildBlockerIndicator(
  blockedBy: string[] | undefined,
  ready: boolean | undefined,
  colorize: (text: string, style: ColorStyle) => string,
): string {
  if (blockedBy !== undefined && blockedBy.length > 0) {
    return ` ${colorize(`⊗(${blockedBy.length})`, 'red')}`;
  }
  if (ready === true) {
    return ` ${colorize('●', 'green')}`;
  }
  return '';
}

/**
 * Build a rich-mode dependency line for `--with-deps`.
 *
 * Renders as a dim indented continuation:
 * ```
 * <childPrefix>← depends on: T1195, T1198
 * ```
 *
 * The `← depends on:` prefix and the entire line are rendered in `'dim'` so
 * the dep annotation visually recedes behind the task line above it.
 *
 * @param depends     - Dep IDs to list (must be non-empty — caller guards).
 * @param childPrefix - Left-padding inherited from the parent connector level.
 * @param colorize    - Color injection callback.
 */
function buildRichDepLine(
  depends: string[],
  childPrefix: string,
  colorize: (text: string, style: ColorStyle) => string,
): string {
  const depList = depends.join(', ');
  return colorize(`${childPrefix}← depends on: ${depList}`, 'dim');
}

/**
 * Build rich-mode blocker chain lines for `--blockers`.
 *
 * Renders two indented continuation lines (when chain is non-empty):
 * ```
 * <childPrefix>↳ chain: T1200 → T1198 → T1199
 * <childPrefix>↳ leaf-blockers: T1199
 * ```
 *
 * The chain line is rendered in `'dim'`; leaf blocker IDs within the chain
 * are highlighted in `'cyan'` so the root-cause tasks stand out visually.
 * The leaf-blockers summary line is also rendered in `'cyan'`.
 *
 * @param blockerChain - Full transitive blocker IDs (must be non-empty — caller guards).
 * @param leafBlockers - Terminal root-cause blocker IDs (may be empty).
 * @param childPrefix  - Left-padding inherited from the parent connector level.
 * @param colorize     - Color injection callback.
 *
 * @example
 * ```typescript
 * const lines = buildRichBlockerChainLines(
 *   ['T1198', 'T1199'],
 *   ['T1199'],
 *   '    ',
 *   (text, style) => text,
 * );
 * // lines[0] → '    ↳ chain: T1198 → T1199'
 * // lines[1] → '    ↳ leaf-blockers: T1199'
 * ```
 */
function buildRichBlockerChainLines(
  blockerChain: string[],
  leafBlockers: string[],
  childPrefix: string,
  colorize: (text: string, style: ColorStyle) => string,
): string[] {
  const leafSet = new Set(leafBlockers);

  // Build the chain string, highlighting leaf blockers in cyan.
  const chainParts = blockerChain.map((id) =>
    leafSet.has(id) ? colorize(id, 'cyan') : colorize(id, 'dim'),
  );
  const chainStr = chainParts.join(colorize(' → ', 'dim'));
  const chainLine = colorize(`${childPrefix}↳ chain: `, 'dim') + chainStr;

  const lines: string[] = [chainLine];

  // Emit a leaf-blockers summary line only when there are identified leaves.
  if (leafBlockers.length > 0) {
    const leafList = leafBlockers.map((id) => colorize(id, 'cyan')).join(', ');
    lines.push(colorize(`${childPrefix}↳ leaf-blockers: `, 'dim') + leafList);
  }

  return lines;
}
