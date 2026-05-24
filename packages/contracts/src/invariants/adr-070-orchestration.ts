/**
 * ADR-070 ORC-### orchestration invariants registered against the central
 * invariants registry (`./index.ts`).
 *
 * ORC codes govern the three-tier spawn topology — Orchestrator (HITL
 * interface) → Lead (phase coordinator) → Worker (leaf task) — defined by
 * ADR-070 and refined by ADR-083 §2 (Cleo persona + recursion bounds).
 *
 * Severity mapping (see `RegisteredInvariant` JSDoc for tier semantics):
 *
 * - **ORC-012** (thin-agent inversion-of-control) is the only ORC rule with
 *   a hard-enforced runtime gate today (`enforceThinAgent` +
 *   `ThinAgentViolationError`). It surfaces as
 *   `E_THIN_AGENT_VIOLATION` (LAFS error code + exit 68). Tier: `error`.
 * - **ORC-001..ORC-009** are the skill-injection rules shipped through
 *   `ct-orchestrator/SKILL.md`. They constrain the Orchestrator's runtime
 *   behaviour (no code writes, dependency-ordered spawning, 10 K context
 *   budget, etc.) but live as prompt-time invariants rather than dispatch
 *   guards. Tier: `warning`, `runtimeGate: null` — the gap is documented
 *   explicitly so the R6 doctor audit (T10340) can surface it.
 * - **ORC-010** (Lead-interposition: a Worker spawn for an Epic-child Task
 *   requires a preceding Lead spawn) and **ORC-011** (Orchestrator-depth
 *   ≤ 3) are filed against ADR-083 §2.4 + §6 but the dispatch-time gate
 *   has not yet shipped (tracked T10278 + T10279). They are registered
 *   here as `warning` with `runtimeGate: null` so the gap surfaces in the
 *   audit pipeline.
 * - **ORC-013** (worktree provisioning per ADR-055 / D009) IS enforced at
 *   `createWorktree` time via `assertCanonicalWorktreeLocation` — it
 *   carries `severity: 'error'` and a runtime gate. The companion CI gate
 *   `lint-worktree-location.mjs` is recorded under `lintRule`.
 * - **ORC-014** (Lead-bypass detection at session end) IS enforced by
 *   `endSession` via `LeadBypassDetectedError`. Tier: `error`.
 *
 * @epic T10327 — E-INVARIANT-REGISTRY-SSOT
 * @saga T10326 — SG-SUBSTRATE-RECONCILIATION
 * @task T10336 — R2 (ADR-070 ORC codes)
 * @see ADR-070-three-tier-orchestration.md
 * @see ADR-083-section-2.4 — Cleo persona + recursion bounds
 */

import type { RegisteredInvariant } from './index.js';

/**
 * Module path that hosts the thin-agent enforcement function.
 */
const THIN_AGENT_MODULE = 'packages/core/src/orchestration/thin-agent.ts';

/**
 * Module path that hosts the session lifecycle entrypoint enforcing
 * Lead-bypass detection at session end.
 */
const SESSIONS_MODULE = 'packages/core/src/sessions/index.ts';

/**
 * Module path that hosts the worktree creation guard (canonical XDG
 * location enforcement per ADR-055 + Council D009).
 */
const WORKTREE_CREATE_MODULE = 'packages/worktree/src/worktree-create.ts';

/**
 * Canonical ct-orchestrator skill that injects ORC-001..ORC-009 into the
 * Orchestrator's prompt at spawn time. Referenced from every prompt-time
 * ORC entry so downstream tooling (R8 docs renderer) can chase the source.
 */
const CT_ORCHESTRATOR_SKILL = 'packages/skills/skills/ct-orchestrator/SKILL.md';

/**
 * Path to the spawn-prompt builder that materialises ORC-006 worker budget
 * constraints into spawn payloads (referenced from ORC-006 below).
 */
const SPAWN_PROMPT_MODULE = 'packages/core/src/orchestration/spawn-prompt.ts';

/**
 * Path to the validate-spawn module that materialises ORC-006 atomic-scope
 * checks via `V_ATOMIC_SCOPE_MISSING` / `V_ATOMIC_SCOPE_TOO_LARGE` codes.
 */
const VALIDATE_SPAWN_MODULE = 'packages/core/src/orchestration/validate-spawn.ts';

/**
 * Skill-validator test that exercises ORC-004 / ORC-005 manifest checks.
 */
const SKILL_VALIDATOR_TESTS = 'packages/core/src/skills/orchestrator/__tests__/validator.test.ts';

/**
 * ADR-070 ORC-### invariants in declaration order.
 *
 * The 14 entries cover:
 *  - ORC-001..ORC-009 — ct-orchestrator skill behavioural constraints.
 *  - ORC-010..ORC-011 — ADR-083 §2.4 recursion-bound gaps (filed,
 *    runtime gate unimplemented — tracked T10278 / T10279).
 *  - ORC-012 — thin-agent inversion-of-control (hard-enforced).
 *  - ORC-013 — worktree provisioning per ADR-055 / D009 (hard-enforced).
 *  - ORC-014 — Lead-bypass detection at session end (hard-enforced).
 *
 * Every `severity: 'warning'` entry with `runtimeGate: null` carries an
 * explicit description of WHY the gate is absent, satisfying the gap-
 * documentation invariant asserted in the unit test below.
 */
export const ADR_070_INVARIANTS: readonly RegisteredInvariant[] = Object.freeze([
  {
    adr: 'ADR-070',
    code: 'ORC-001',
    name: 'Orchestrator is the HITL interface',
    description:
      'The Orchestrator (Cleo) is the single subagent that talks to the human operator. It plans, decomposes, and delegates — it never produces line-level implementation. Source-of-truth lives in ct-orchestrator/SKILL.md row ORC-001 and is injected into the Orchestrator prompt at spawn time. UNENFORCED at the dispatch layer: this is a prompt-time invariant with no runtime guard today.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [CT_ORCHESTRATOR_SKILL],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-002',
    name: 'Orchestrator MUST NOT write or edit code',
    description:
      'Every line of code is written by a spawned subagent. The Orchestrator delegates implementation work via cleo orchestrate spawn / delegate_task. UNENFORCED at the dispatch layer: this is a prompt-time invariant — there is no runtime gate that blocks the Orchestrator from calling Edit/Write, so the contract is held by the ct-orchestrator skill text.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [CT_ORCHESTRATOR_SKILL],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-003',
    name: 'Orchestrator MUST NOT read full source files',
    description:
      'Orchestrator reads only pipeline manifests, task envelopes, and rolled-up phase summaries returned by Phase Leads. Workers read code; the Orchestrator reads summaries. UNENFORCED at the dispatch layer — held by the ct-orchestrator skill text and reinforced by ORC-005 budget pressure.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [CT_ORCHESTRATOR_SKILL],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-004',
    name: 'Dependency-ordered spawning',
    description:
      'Spawns within a wave are ordered by task.depends — a Worker MUST NOT be dispatched until its declared dependencies are status=done. Surfaced by validateSpawnReadiness via V_MISSING_DEP / V_UNMET_DEP codes; surfaced by the skill-orchestrator validator via the ORC-004_DEPENDENCY_ORDER warning emitted from packages/core/src/skills/orchestrator/validator.ts. Tier: warning because the validator surfaces ordering issues but does not throw — workers can still proceed if the operator overrides.',
    severity: 'warning',
    runtimeGate: {
      module: VALIDATE_SPAWN_MODULE,
      functionName: 'validateSpawnReadiness',
    },
    lintRule: null,
    doctorAudit: null,
    tests: [
      'packages/core/src/orchestration/__tests__/validate-spawn.test.ts',
      SKILL_VALIDATOR_TESTS,
    ],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-005',
    name: 'Orchestrator context budget ≈ 10 K tokens',
    description:
      'The Orchestrator MUST keep its working context under ~10 K tokens; delegate at 80 %. Surfaced by cleo orchestrate context (estimateContext) and by the skill-orchestrator validator (ORC-005_NO_MANIFEST / ORC-005_EMPTY_MANIFEST). UNENFORCED as a hard gate — the budget is advisory, surfaced to the Orchestrator as a warning so the human operator can intervene.',
    severity: 'warning',
    runtimeGate: {
      module: 'packages/core/src/orchestration/context.ts',
      functionName: 'estimateContext',
    },
    lintRule: null,
    doctorAudit: null,
    tests: ['packages/core/src/orchestration/__tests__/'],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-006',
    name: 'Worker scope ≤ 3 files per spawn',
    description:
      'Cross-file reasoning quality degrades beyond ~3 files for a single Worker. Enforced at spawn-time by validateSpawnReadiness — V_ATOMIC_SCOPE_MISSING when task.files is empty, V_ATOMIC_SCOPE_TOO_LARGE when files.length > MAX_WORKER_FILES (currently 3). Spawn-prompt builder injects a Worker Budget Constraints section so the Worker sees the budget inline. Tier: error because the gate refuses to spawn an over-scoped Worker.',
    severity: 'error',
    runtimeGate: {
      module: VALIDATE_SPAWN_MODULE,
      functionName: 'validateSpawnReadiness',
    },
    lintRule: null,
    doctorAudit: null,
    tests: [
      'packages/core/src/orchestration/__tests__/validate-spawn.test.ts',
      'packages/core/src/orchestration/__tests__/spawn-prompt.test.ts',
    ],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-007',
    name: 'All work traced to an Epic',
    description:
      'Every Task and Subtask MUST attach to a parent Epic (directly or transitively). No orphan work — orphans are filed against the ADR-066 acceptance-criteria gate and surface via cleo find. UNENFORCED at the dispatch layer; the parent-id requirement is materialised through cleo add validation rather than a single ORC-named guard. R6 doctor audit should walk the task graph to surface orphans.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [CT_ORCHESTRATOR_SKILL],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-008',
    name: 'Zero architectural decisions during execution',
    description:
      'Architectural choices MUST be pre-decided via RCASD consensus or HITL — never inside a worker session. UNENFORCED at the dispatch layer: this is a behavioural invariant held by the ct-orchestrator skill text plus the ADR-066 acceptance criterion that every task must declare its architecture-relevant decisions before spawn.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [CT_ORCHESTRATOR_SKILL],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-009',
    name: 'Manifest-mediated handoffs',
    description:
      'Orchestrator reads only the key_findings field of pipeline_manifest rows when reconciling worker output. Subagents read the full task description and supporting files. UNENFORCED at the dispatch layer: the contract is held by the ct-orchestrator skill text and reinforced by ORC-003 + ORC-005 budget pressure.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [CT_ORCHESTRATOR_SKILL],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-010',
    name: 'Lead-interposition required for Epic-child Workers',
    description:
      'A Worker spawn against a Task whose parent is type=epic MUST be preceded by a Lead spawn for the same Task (ADR-083 §2.4 / §6). The intended runtime gate (composeSpawnPayload throwing E_LEAD_REQUIRED_FOR_EPIC_CHILD) is FILED but UNSHIPPED — tracked under T10278. Registered here as a warning + runtimeGate:null so the gap is visible in the R6 doctor audit.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-011',
    name: 'Orchestrator-depth cap at 3',
    description:
      'Recursive Orchestrator spawns (Cleo → sub-Orchestrator → sub-Orchestrator → …) MUST stop at depth 3 (ADR-083 §2.2 + §2.4). The intended runtime gate (composeSpawnPayload throwing E_ORCHESTRATOR_DEPTH_EXCEEDED) is FILED but UNSHIPPED — tracked under T10279. Registered here as a warning + runtimeGate:null so the gap is visible in the R6 doctor audit.',
    severity: 'warning',
    runtimeGate: null,
    lintRule: null,
    doctorAudit: null,
    tests: [],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-012',
    name: 'Thin-agent inversion-of-control',
    description:
      'Workers MUST NOT spawn other subagents. The spawn-capable tools (Agent / Task / TaskCreate) are stripped from the Worker tool list at .cant compile time, and any survivor at spawn time triggers ThinAgentViolationError → E_THIN_AGENT_VIOLATION (exit 68). The only ORC rule with a hard-enforced dispatch-time gate today.',
    severity: 'error',
    runtimeGate: {
      module: THIN_AGENT_MODULE,
      functionName: 'enforceThinAgent',
    },
    lintRule: null,
    doctorAudit: null,
    tests: [
      'packages/core/src/orchestration/__tests__/thin-agent.test.ts',
      'packages/cant/src/__tests__/hierarchy.test.ts',
    ],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-013',
    name: 'Worktree provisioning at canonical XDG location',
    description:
      'Every agent worktree MUST be created under <cleoHome>/worktrees/<projectHash>/<taskId>/ (ADR-055 + Council D009). createWorktree throws E_WT_LOCATION_FORBIDDEN before any git worktree add call when the computed path falls outside the canonical root. CI gate lint-worktree-location.mjs enforces the same invariant on every PR. The single-most-load-bearing orchestration guard after ORC-012.',
    severity: 'error',
    runtimeGate: {
      module: WORKTREE_CREATE_MODULE,
      functionName: 'assertCanonicalWorktreeLocation',
    },
    lintRule: {
      lintScript: 'scripts/lint-worktree-location.mjs',
    },
    doctorAudit: null,
    tests: ['packages/worktree/src/__tests__/'],
  },
  {
    adr: 'ADR-070',
    code: 'ORC-014',
    name: 'Lead-bypass detection at session end',
    description:
      'A Lead session (CLEO_AGENT_ROLE=lead) that ends with tasks_completed > 0 AND delegate_task_count = 0 is rejected with LeadBypassDetectedError → E_LEAD_BYPASS_DETECTED (exit 107). Leads MUST fan out work to Workers; a Lead that did the work itself defeats the three-tier topology. Override via CLEO_OWNER_OVERRIDE=1 (audited to force-bypass.jsonl).',
    severity: 'error',
    runtimeGate: {
      module: SESSIONS_MODULE,
      functionName: 'endSession',
    },
    lintRule: null,
    doctorAudit: null,
    tests: ['packages/core/src/sessions/__tests__/'],
  },
]);

/** Sentinel referenced by the unit test — keep in sync with array length. */
export const ADR_070_INVARIANT_COUNT = ADR_070_INVARIANTS.length;

/** Sentinel — minimum entries the central registry must merge from this file. */
export const ADR_070_MIN_ENTRIES = 14;

/**
 * Export the prompt-only module reference so other ADR-070 ORC modules can
 * cross-reference the canonical skill location without restating the path.
 * @internal
 */
export const ADR_070_PROMPT_SOURCE = CT_ORCHESTRATOR_SKILL;

/**
 * Re-export for symmetry with the spawn-prompt builder consumers — used by
 * the R8 docs renderer to chase the prompt-injection source for ORC-006.
 * @internal
 */
export const ADR_070_SPAWN_PROMPT_MODULE = SPAWN_PROMPT_MODULE;
