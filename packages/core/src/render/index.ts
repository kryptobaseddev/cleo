/**
 * `@cleocode/core/render` — shared `--human` rendering primitives.
 *
 * Pure formatting helpers (no stdout writes, no side effects) used by the
 * CLI thin shell and any other surface that needs to format LAFS envelopes
 * for human consumption. Originally lived under `packages/cleo/src/cli/
 * renderers/format-helpers.ts`; migrated here per AGENTS.md
 * Package-Boundary Check.
 *
 * The brain/nexus/orchestration/session family barrels are imported for
 * their side-effect `registerRenderer` calls — they populate the B5
 * registry as a forward step for envelope-aware callers.
 *
 * @task T10129
 * @task T10131
 * @task T10132
 */

export * from './ansi.js';
// Re-export every migrated renderer through the canonical entry point so
// `import { renderBriefing } from '@cleocode/core'` resolves. Importing the
// family barrels (not just the renderer files) is what triggers the
// side-effect `registerRenderer` calls that populate the B5 registry.
export * from './brain/index.js';
export * from './cli-colorize.js';
export * from './colors.js';
export * from './fallback.js';
export * from './format-label.js';
export * from './helpers.js';
export * from './legacy-adapter.js';
export * from './nexus/index.js';
export * from './orchestration/index.js';
export * from './registry.js';
export * from './render-envelope.js';
export * from './session/index.js';
export * from './tree-context.js';
export * from './types.js';
