/**
 * Task-family human renderer barrel.
 *
 * Side-effect-registers every task renderer into the B5
 * {@link ../registry.js | registry} so {@link ../render-envelope.js |
 * renderEnvelopeForHuman} can route `(command, kind)` lookups to the right
 * function. Each renderer is also exported by name for direct callers (CLI
 * dispatcher, tests).
 *
 * The legacy `(data: Record<string, unknown>, quiet: boolean)` signature is
 * preserved during the Human Render Contract migration — the registry
 * adapters wrap each renderer behind the typed `Renderer<T>` shape, treating
 * the envelope's `data` field as the legacy payload and forwarding
 * `opts.quiet ?? false`. Commands that have not yet been migrated to emit
 * typed envelopes continue to call the renderers directly.
 *
 * @task T10133
 * @epic T10114
 */

import { registerRenderer } from '../registry.js';
import type { Renderer } from '../types.js';
import { renderAdd } from './add.js';
import { renderArchive } from './archive.js';
import { renderComplete } from './complete.js';
import { renderDelete } from './delete.js';
import { renderFind } from './find.js';
import { renderList } from './list.js';
import { renderRestore } from './restore.js';
import { renderShow } from './show.js';
import { renderUpdate } from './update.js';

/**
 * Wrap a legacy `(data, quiet)` renderer as a typed `Renderer<unknown>` for
 * the B5 registry. Extracts the envelope's `data` and forwards
 * `opts.quiet ?? false`, preserving zero-behavior-change.
 */
function asRenderer(
  fn: (data: Record<string, unknown>, quiet: boolean) => string,
): Renderer<unknown> {
  return (envelope, opts) => {
    const data = (envelope.data ?? {}) as Record<string, unknown>;
    return fn(data, opts.quiet ?? false);
  };
}

// Register every task renderer under `kind: 'generic'` — the dispatcher wraps
// legacy `Record<string, unknown>` payloads in `{ kind: 'generic', data }`
// envelopes before routing through `renderEnvelopeForHuman`. Once commands
// emit typed envelopes (single / table / tree), per-command registrations
// against the matching `kind` will supersede these entries.
registerRenderer('show', 'generic', asRenderer(renderShow));
registerRenderer('list', 'generic', asRenderer(renderList));
registerRenderer('ls', 'generic', asRenderer(renderList));
registerRenderer('find', 'generic', asRenderer(renderFind));
registerRenderer('search', 'generic', asRenderer(renderFind));
registerRenderer('add', 'generic', asRenderer(renderAdd));
registerRenderer('update', 'generic', asRenderer(renderUpdate));
registerRenderer('complete', 'generic', asRenderer(renderComplete));
registerRenderer('done', 'generic', asRenderer(renderComplete));
registerRenderer('delete', 'generic', asRenderer(renderDelete));
registerRenderer('rm', 'generic', asRenderer(renderDelete));
registerRenderer('archive', 'generic', asRenderer(renderArchive));
registerRenderer('restore', 'generic', asRenderer(renderRestore));

export {
  renderAdd,
  renderArchive,
  renderComplete,
  renderDelete,
  renderFind,
  renderList,
  renderRestore,
  renderShow,
  renderUpdate,
};
