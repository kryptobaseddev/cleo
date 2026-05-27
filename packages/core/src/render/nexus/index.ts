/**
 * `@cleocode/core/render/nexus` — nexus subcommand renderers, organised by family.
 *
 * Re-exports every renderer from the three families:
 * - `graph/`  — query / context / impact / projects (T10150)
 * - `contracts/` — cross-project + brain/task footprint (T10151)
 * - `audit/`  — diff / export / cold-symbols (T10152)
 *
 * Migrated from the deleted `packages/cleo/src/cli/renderers/nexus.ts`
 * (1055 LOC) per AGENTS.md Package-Boundary Check + ADR-077.
 *
 * @epic T10114
 * @task T10132
 */

export * from './audit/index.js';
export * from './contracts/index.js';
export * from './graph/index.js';
