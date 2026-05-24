/**
 * ADR-073 §1.2 invariants I1-I8 registered against the central invariants
 * registry (`./index.ts`).
 *
 * The eight invariants govern the 4-tier task hierarchy (Saga → Epic → Task
 * → Subtask) and the cross-tier rules that keep it healthy. I3, I5, I7 carry
 * runtime guards (the `assertSagaInvariant{I3,I5,I7}` functions in
 * `@cleocode/core` saga module) and surface as `E_SAGA_INVARIANT_VIOLATION_*`
 * LAFS error codes. I1 + I2 are display/storage concerns enforced by DB
 * CHECK constraints (added in W1.B T10329 migration) and ID generation
 * conventions rather than runtime functions. I4, I6, I8 are
 * orchestration/process invariants that lack a unified runtime guard today
 * — they are marked `warning` and explicitly tagged as UNENFORCED
 * (load-bearing) so downstream R6 doctor audits surface them visibly.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10335 — R1 (registry + ADR-073 I1-I8)
 * @see ADR-073-above-epic-naming.md §1.2
 */

import type { RegisteredInvariant } from './index.js';

/**
 * Module path that hosts the saga runtime-guard exports
 * (`assertSagaInvariantI3`, `assertSagaInvariantI5`, `assertSagaInvariantI7`).
 *
 * Held as a constant so all four entries share the same source-of-truth
 * pointer — touching the module path once propagates to every guard ref.
 */
const SAGA_ENFORCEMENT_MODULE = 'packages/core/src/sagas/enforcement.ts';

/**
 * Path to the canonical enforcement-tests file. Used as the `tests` ref
 * for every I3 / I5 / I7 entry below.
 */
const SAGA_ENFORCEMENT_TESTS = 'packages/core/src/sagas/__tests__/enforcement.test.ts';

/**
 * ADR-073 invariants I1-I8 in declaration order.
 *
 * Severity mapping (see `RegisteredInvariant` JSDoc for tier semantics):
 * - I1, I2 → `info` (display/storage; enforced by DB CHECK + ID convention).
 * - I3, I5, I7 → `error` (LAFS error code + runtime guard mandatory).
 * - I4, I6, I8 → `warning` (orchestration/process; UNENFORCED at runtime
 *   today, doctor audit only).
 */
export const ADR_073_INVARIANTS: readonly RegisteredInvariant[] = Object.freeze([
  {
    adr: 'ADR-073',
    code: 'I1',
    name: 'Storage uniformity',
    description:
      'All task IDs are stored as T#### and the type column is the canonical tier discriminator. There is no separate ID space for Sagas, Epics, Tasks, or Subtasks; label="saga" elevates a type="epic" row to Saga semantics.',
    severity: 'info',
    // I1 is enforced by the DB CHECK constraints introduced in W1.B (T10329)
    // and by TASK_ID_PATTERN in packages/core/src/tasks/id-generator.ts —
    // not by a single runtime function.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: ['packages/core/src/tasks/__tests__/id-generator.test.ts'],
  },
  {
    adr: 'ADR-073',
    code: 'I2',
    name: 'Conceptual prefixes are display + import only',
    description:
      "SG-, E-, T- (and Subtask's implicit absence) are documentation, CLI display, and import-mapping conventions only. They MUST NOT be used as DB primary keys — display-only with no runtime enforcement.",
    severity: 'info',
    // I2 is a display convention; the SG- prefix preservation snapshot
    // (T10333) protects the display contract but there is no runtime guard.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-073',
    code: 'I3',
    name: 'Tier promotion mandatory when scope outgrows the tier',
    description:
      'A Subtask whose change exceeds 2 files or crosses a module boundary MUST be split or promoted to a sibling Task. A Task that requires more than one PR or wave MUST be split. An Epic that spans more than one release MUST be regrouped under a Saga.',
    severity: 'error',
    runtimeGate: {
      module: SAGA_ENFORCEMENT_MODULE,
      functionName: 'assertSagaInvariantI3',
    },
    lintRule: null,
    doctorAudit: null,
    tests: [SAGA_ENFORCEMENT_TESTS],
  },
  {
    adr: 'ADR-073',
    code: 'I4',
    name: 'Ownership non-overlapping',
    description:
      'A single tier maps to a single orchestration role (per ADR-070). Workers MUST NOT spawn other Workers. Phase Leads MUST NOT own multiple Epics simultaneously. The Orchestrator MUST NOT spawn Workers directly when fan-out exceeds the ADR-070 migration threshold.',
    severity: 'warning',
    // I4 is partially covered by ADR-070 spawn guards but the unification
    // with the registry happens in R2 (T10336 — ORC codes). For now this
    // entry stays warning + runtimeGate:null to mark the gap explicitly.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-073',
    code: 'I5',
    name: 'Sagas link via groups, not parent',
    description:
      'task_relations.type="groups" is the ONLY relation type that links a Saga to its member Epics. The Saga row\'s parent_id MUST be NULL. Enforced at runtime by assertSagaInvariantI5 AND by the DB CHECK constraint from W1.B (T10329) on label="saga" rows.',
    severity: 'error',
    runtimeGate: {
      module: SAGA_ENFORCEMENT_MODULE,
      functionName: 'assertSagaInvariantI5',
    },
    lintRule: null,
    doctorAudit: null,
    tests: [SAGA_ENFORCEMENT_TESTS],
  },
  {
    adr: 'ADR-073',
    code: 'I6',
    name: 'Acceptance criteria required at every tier',
    description:
      'Per ADR-066 §"Ownership Matrix" invariant #5, all tasks regardless of type or kind MUST have --acceptance set at creation time. No tier exemption exists. Delegated to the ADR-066 --acceptance requirement on cleo add/add-batch.',
    severity: 'warning',
    // I6 is enforced by ADR-066's CLI requirement, not by a saga runtime
    // function. UNENFORCED in the saga module — left as a warning so R6
    // doctor audit reminds operators of the upstream guard's location.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-073',
    code: 'I7',
    name: 'Maximum parent depth is 3',
    description:
      'The parent ladder Subtask → Task → Epic is fixed at depth 3 (hierarchy.maxDepth=3). Sagas do NOT consume depth — they attach via groups relations, not parent edges. Enforced at runtime by assertSagaInvariantI7.',
    severity: 'error',
    runtimeGate: {
      module: SAGA_ENFORCEMENT_MODULE,
      functionName: 'assertSagaInvariantI7',
    },
    lintRule: null,
    doctorAudit: null,
    tests: [SAGA_ENFORCEMENT_TESTS],
  },
  {
    adr: 'ADR-073',
    code: 'I8',
    name: 'Subtask-to-PR aggregation rule',
    description:
      "A Task ships as exactly one PR. The PR's commit history is the union of the Task's Subtask commits. A Subtask never produces its own PR; if a unit of work warrants its own PR, it is a Task, not a Subtask. UNENFORCED at runtime today — load-bearing convention enforced via code review and the lifecycle decision table.",
    severity: 'warning',
    // I8 is explicitly "UNENFORCED, load-bearing" — there is no automated
    // gate. R6 doctor audit surfaces this entry so it stays visible.
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
]);
