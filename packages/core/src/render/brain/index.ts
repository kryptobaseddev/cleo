/**
 * Brain-family human renderers.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6,
 * subtask T10149). Covers the brain maintenance, backfill, purge,
 * plasticity-stats, quality, and export subcommands surfaced under
 * `cleo brain ...`.
 *
 * Each renderer is also registered into the B5 renderer registry under
 * `kind: 'generic'` so future envelope-aware callers can resolve them via
 * {@link renderEnvelopeForHuman}. The dispatcher in
 * `packages/cleo/src/cli/renderers/index.ts` continues to invoke them via
 * the legacy `(data, quiet) => string` signature for zero behavior change.
 *
 * @task T10131
 * @task T10149
 * @epic T10114
 */

import { wrapLegacyRenderer } from '../legacy-adapter.js';
import { registerRenderer } from '../registry.js';
import { renderBrainBackfill } from './backfill.js';
import { renderBrainExport } from './export.js';
import { renderBrainMaintenance } from './maintenance.js';
import { renderBrainPlasticityStats } from './plasticity-stats.js';
import { renderBrainPurge } from './purge.js';
import { renderBrainQuality } from './quality.js';

// Side-effect registration on module load.
registerRenderer('brain-maintenance', 'generic', wrapLegacyRenderer(renderBrainMaintenance));
registerRenderer('brain-backfill', 'generic', wrapLegacyRenderer(renderBrainBackfill));
registerRenderer('brain-purge', 'generic', wrapLegacyRenderer(renderBrainPurge));
registerRenderer(
  'brain-plasticity-stats',
  'generic',
  wrapLegacyRenderer(renderBrainPlasticityStats),
);
registerRenderer('brain-quality', 'generic', wrapLegacyRenderer(renderBrainQuality));
registerRenderer('brain-export', 'generic', wrapLegacyRenderer(renderBrainExport));

export {
  renderBrainBackfill,
  renderBrainExport,
  renderBrainMaintenance,
  renderBrainPlasticityStats,
  renderBrainPurge,
  renderBrainQuality,
};
