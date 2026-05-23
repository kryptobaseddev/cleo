/**
 * Static UI primitives — tree, table, section, badge, legend.
 *
 * @remarks
 * Companion to the spinner / progress / spark animations in this package.
 * Every primitive is a pure function that returns a string and respects the
 * {@link AnimateContext} gate — emitting `''` when the context is silent
 * (JSON, quiet, no-TTY, NO_COLOR).
 *
 * Consumes typed contracts from `@cleocode/contracts/render/*` (Epic T10114,
 * ADR-077) and icon enums from `@cleocode/contracts/render/icon.js`.
 *
 * @epic T10114
 * @task T10128
 * @packageDocumentation
 */

export {
  type RenderBadgeOptions,
  renderBadge,
  renderStatusBadge,
  type StatusBadgeName,
} from './badge.js';
export {
  type LegendItem,
  type RenderLegendInput,
  type RenderSummaryInput,
  renderLegend,
  renderSummary,
  type SummaryCount,
} from './legend.js';
export {
  type RenderSectionInput,
  renderSection,
} from './section.js';
export {
  type RenderTableOptions,
  renderTable,
} from './table.js';
export {
  type RenderTreeViewOptions,
  renderTree,
} from './tree.js';
