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
  /** Open dependency IDs blocking this task.  Present after T1199 enrichment. */
  blockedBy?: string[];
  /**
   * Whether the task is immediately actionable (no open deps, not yet done).
   * Present after T1199 enrichment.
   */
  ready?: boolean;
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

/** Maps a status string to a compact display symbol. */
const STATUS_SYMBOLS: Record<string, string> = {
  pending: '○', // ○
  active: '●', // ●
  done: '✓', // ✓
  blocked: '⊗', // ⊗
  cancelled: '✕', // ✕
  archived: '☐', // ☐
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
  const connectors: TreeConnectors = {
    ...DEFAULT_CONNECTORS,
    ...(opts?.symbols?.connectors ?? {}),
  };

  switch (mode) {
    case 'json':
      return JSON.stringify({ tree: nodes });

    case 'markdown':
      if (!nodes.length) return 'No tree data.';
      return formatTreeMarkdown(nodes, 0);

    case 'quiet':
      if (!nodes.length) return '';
      return formatTreeQuiet(nodes, '', connectors);

    default:
      if (!nodes.length) return 'No tree data.';
      return formatTreeRich(nodes, '', connectors, colorize);
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
 * @param nodes      - Nodes at the current level.
 * @param prefix     - Accumulated left-padding from parent levels.
 * @param connectors - Connector characters.
 * @param colorize   - Color injection callback.
 */
function formatTreeRich(
  nodes: FlatTreeNode[],
  prefix: string,
  connectors: TreeConnectors,
  colorize: (text: string, style: ColorStyle) => string,
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

    if (node.children?.length) {
      lines.push(formatTreeRich(node.children, childPrefix, connectors, colorize));
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
 * @param nodes - Nodes at the current level.
 * @param depth - Current indentation depth (0-based).
 */
function formatTreeMarkdown(nodes: FlatTreeNode[], depth: number): string {
  const lines: string[] = [];
  const indent = '  '.repeat(depth);

  for (const node of nodes) {
    lines.push(`${indent}- [${node.status}] ${node.id} ${node.title}`);
    if (node.children?.length) {
      lines.push(formatTreeMarkdown(node.children, depth + 1));
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
