/**
 * Session-family human renderers.
 *
 * Migrated from `packages/cleo/src/cli/renderers/system.ts` (T10131 — B6,
 * subtask T10147). Covers commands that surface session lifecycle and
 * suggestion state: briefing, blockers, next, current, doctor, session,
 * version, start, stop, schema, generic.
 *
 * Each renderer is also registered into the B5 renderer registry under
 * `kind: 'generic'` so future envelope-aware callers can resolve them via
 * {@link renderEnvelopeForHuman}. The dispatcher in
 * `packages/cleo/src/cli/renderers/index.ts` continues to invoke them via
 * the legacy `(data, quiet) => string` signature for zero behavior change.
 *
 * @task T10131
 * @task T10147
 * @epic T10114
 */

import { wrapLegacyRenderer } from '../legacy-adapter.js';
import { registerRenderer } from '../registry.js';
import { renderBlockers } from './blockers.js';
import { renderBriefing } from './briefing.js';
import { renderCurrent } from './current.js';
import { renderDoctor } from './doctor.js';
import { renderGeneric } from './generic.js';
import { renderNext } from './next.js';
import { renderSchemaCommand } from './schema.js';
import { renderSession } from './session.js';
import { renderStart } from './start.js';
import { renderStop } from './stop.js';
import { renderVersion } from './version.js';

// Side-effect registration on module load.
registerRenderer('briefing', 'generic', wrapLegacyRenderer(renderBriefing));
registerRenderer('blockers', 'generic', wrapLegacyRenderer(renderBlockers));
registerRenderer('next', 'generic', wrapLegacyRenderer(renderNext));
registerRenderer('current', 'generic', wrapLegacyRenderer(renderCurrent));
registerRenderer('doctor', 'generic', wrapLegacyRenderer(renderDoctor));
registerRenderer('session', 'generic', wrapLegacyRenderer(renderSession));
registerRenderer('version', 'generic', wrapLegacyRenderer(renderVersion));
registerRenderer('start', 'generic', wrapLegacyRenderer(renderStart));
registerRenderer('stop', 'generic', wrapLegacyRenderer(renderStop));
registerRenderer('schema', 'generic', wrapLegacyRenderer(renderSchemaCommand));
registerRenderer('generic', 'generic', wrapLegacyRenderer(renderGeneric));

export {
  renderBlockers,
  renderBriefing,
  renderCurrent,
  renderDoctor,
  renderGeneric,
  renderNext,
  renderSchemaCommand,
  renderSession,
  renderStart,
  renderStop,
  renderVersion,
};
