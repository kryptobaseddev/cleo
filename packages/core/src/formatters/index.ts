/**
 * Core formatting utilities — presentation-agnostic tree and wave renderers.
 *
 * These formatters are pure functions that accept a `colorize` callback for
 * ANSI injection, making them reusable across the CLI, Studio, VS Code
 * extension, and API server without importing any terminal-specific code.
 *
 * @example
 * // CLI usage — inject ANSI via colors helper
 * import { formatTree, formatWaves } from '@cleocode/core/formatters';
 *
 * const output = formatTree(nodes, {
 *   mode: 'rich',
 *   colorize: (text, style) => applyAnsi(text, style),
 * });
 *
 * @example
 * // Studio / API usage — plain text, no ANSI
 * import { formatWaves } from '@cleocode/core/formatters';
 *
 * const markdown = formatWaves({ waves }, { mode: 'markdown' });
 *
 * @module
 */

export type { ColorStyle, FlatTreeNode, FormatMode, FormatOpts, TreeConnectors } from './tree.js';
// Tree formatter
export { formatTree } from './tree.js';
export type { EnrichedWave, WaveTask } from './waves.js';
// Wave formatter
export { formatWaves } from './waves.js';
