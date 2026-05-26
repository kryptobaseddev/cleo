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

// === Central Invariants Registry re-export (T10335 / Saga T10326) ===
// Surfaces the central registry (ADR-073 I1-I8 + future-ADR entries) to
// existing @cleocode/core saga consumers without forcing a contracts import
// at every callsite.
export {
  ADR_073_INVARIANTS,
  getInvariant,
  getInvariantsByAdr,
  INVARIANTS_REGISTRY,
  type InvariantDoctorAudit,
  type InvariantLintRule,
  type InvariantRuntimeGate,
  type InvariantSeverity,
  type RegisteredInvariant,
} from '@cleocode/contracts';
export { type SagaAddParams, type SagaAddResult, sagaAdd } from './add.js';
export { LIST_BINDING_SAGA_GROUPS, SAGA_GROUPS_RELATION, SAGA_LABEL } from './constants.js'; // saga-label-ok: T10638 — SSoT re-export
export { type SagaCreateParams, sagaCreate } from './create.js';
export {
  type DetachResult,
  type DetachSagaMemberParams,
  detachSagaMember,
  SAGA_DETACH_AUDIT_FILE,
  SAGA_DETACH_DEFAULT_REASON,
} from './detach.js';
export {
  assertSagaInvariantI3,
  assertSagaInvariantI5,
  assertSagaInvariantI7,
  assertSagaInvariantI7Typed,
  E_SAGA_INVARIANT_VIOLATION_I3,
  E_SAGA_INVARIANT_VIOLATION_I5,
  E_SAGA_INVARIANT_VIOLATION_I7,
  isSagaInvariantViolationError,
  isSagaShape,
  type SagaInvariantCode,
  type SagaInvariantDiag,
  SagaInvariantViolationError,
  type SagaTask,
} from './enforcement.js';
export { isSagaType } from './is-saga-type.js';
export { type SagaInvariantI5Warning, type SagaListResult, sagaList } from './list.js';
export {
  type SagaMemberEntry,
  type SagaMembersParams,
  type SagaMembersResult,
  sagaMembers,
} from './members.js';
export {
  type ReconcileResult,
  type ReconcileSagaParams,
  reconcileSaga,
  SAGA_RECONCILE_AUDIT_FILE,
  SAGA_RECONCILE_CLOSE_REASON,
  type SagaReconcileAction,
  type SagaReconcileEntry,
} from './reconcile.js';
export { type RepairSagaParams, type RepairSagaResult, repairSaga } from './repair.js';
export { type SagaRollupParams, type SagaRollupResult, sagaRollup } from './rollup.js';
export {
  buildSagaAutoCloseEvidence,
  findSagasGroupingTask,
  resolveSagaMemberIds,
} from './storage.js';
