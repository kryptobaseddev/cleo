/**
 * Saga module — public API for above-Epic theme grouping (ADR-073).
 *
 * Hosts the constants, storage helpers, and pure-business-logic operations
 * for Saga (`SG-`) primitives. The dispatch layer
 * (`packages/cleo/src/dispatch/domains/tasks.ts`) imports from here and
 * wraps results in LAFS envelopes — it MUST NOT re-implement saga logic.
 *
 * @epic T10208 — E-SAGAS-CORE-MODULE
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @see AGENTS.md "Package-Boundary Check"
 * @see ADR-073-above-epic-naming.md
 */

export { LIST_BINDING_SAGA_GROUPS, SAGA_GROUPS_RELATION, SAGA_LABEL } from './constants.js';
export { resolveSagaMemberIds } from './storage.js';
