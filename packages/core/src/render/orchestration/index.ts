/**
 * Orchestration-family human renderers.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6,
 * subtask T10148). Covers commands that surface wave plans, dependency
 * trees, planning views, lineage reconstruction, and project statistics.
 *
 * Each renderer is also registered into the B5 renderer registry under
 * `kind: 'generic'` so future envelope-aware callers can resolve them via
 * {@link renderEnvelopeForHuman}. The dispatcher in
 * `packages/cleo/src/cli/renderers/index.ts` continues to invoke them via
 * the legacy `(data, quiet) => string` signature for zero behavior change.
 *
 * @task T10131
 * @task T10148
 * @epic T10114
 */

import { wrapLegacyRenderer } from '../legacy-adapter.js';
import { registerRenderer } from '../registry.js';
import { renderAuditReconstruct } from './audit-reconstruct.js';
import { renderPlan } from './plan.js';
import { renderStats } from './stats.js';
import { renderTree } from './tree.js';

// Side-effect registration on module load. `renderWaves` has a non-legacy
// signature (`(data, opts) => string`) and is NOT registered here; consumers
// that want wave-specific rendering call `renderWaves` directly. `renderTree`
// is registered because `cleo tree` / `cleo deps` / `cleo orchestrate` all
// route through it via the dispatcher.
registerRenderer('tree', 'generic', wrapLegacyRenderer(renderTree));
registerRenderer('deps', 'generic', wrapLegacyRenderer(renderTree));
registerRenderer('depends', 'generic', wrapLegacyRenderer(renderTree));
registerRenderer('orchestrate', 'generic', wrapLegacyRenderer(renderTree));
registerRenderer('plan', 'generic', wrapLegacyRenderer(renderPlan));
registerRenderer('stats', 'generic', wrapLegacyRenderer(renderStats));
registerRenderer('audit-reconstruct', 'generic', wrapLegacyRenderer(renderAuditReconstruct));

export { renderCompletionBar } from './completion-bar.js';
export {
  type RenderWavesMode,
  type RenderWavesOptions,
  renderWaves,
} from './waves.js';
export { renderAuditReconstruct, renderPlan, renderStats, renderTree };
