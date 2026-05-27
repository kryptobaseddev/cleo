<!--
  AUTO-GENERATED — DO NOT EDIT MANUALLY.

  Regenerate via: pnpm render:invariants
  Source script:  packages/contracts/scripts/render-invariants-docs.mjs
  Source SSoT:    packages/contracts/src/invariants/index.ts

  Editing this file directly will be reverted by the next
  `Invariants Docs Render Drift (T10342)` CI gate run.
-->

# Invariants Registry

This page catalogues every numbered invariant the CLEO system relies on. It is **auto-rendered** from the central `INVARIANTS_REGISTRY` SSoT at `packages/contracts/src/invariants/`. Editing the source files is the only way to change this page.

## Summary

| ADR | Entries | Source module |
| --- | --- | --- |
| [`ADR-073`](.cleo/adrs/ADR-073-above-epic-naming.md) | 8 | `packages/contracts/src/invariants/adr-073-saga.ts` |
| [`ADR-056`](.cleo/adrs/ADR-056-db-ssot-and-release-completion-invariant.md) | 6 | `packages/contracts/src/invariants/adr-056-release.ts` |
| [`ADR-070`](.cleo/adrs/ADR-070-three-tier-orchestration.md) | 14 | `packages/contracts/src/invariants/adr-070-orchestration.ts` |
| **Total** | **28** | — |

## ADR-073

Source ADR: [`.cleo/adrs/ADR-073-above-epic-naming.md`](../../.cleo/adrs/ADR-073-above-epic-naming.md)

Registry module: `packages/contracts/src/invariants/adr-073-saga.ts`

| Code | Name | Severity | RuntimeGate | Tests | Description |
| --- | --- | --- | --- | --- | --- |
| `I1` | Storage uniformity | `info` | _none_ | `packages/core/src/tasks/__tests__/id-generator.test.ts` | All task IDs are stored as T#### and the type column is the canonical tier discriminator. There is no separate ID space for Sagas, Epics, Tasks, or Subtasks; label="saga" elevates a type="epic" row to Saga semantics. |
| `I2` | Conceptual prefixes are display + import only | `info` | _none_ | _none_ | SG-, E-, T- (and Subtask's implicit absence) are documentation, CLI display, and import-mapping conventions only. They MUST NOT be used as DB primary keys — display-only with no runtime enforcement. |
| `I3` | Tier promotion mandatory when scope outgrows the tier | `error` | `assertSagaInvariantI3` (`packages/core/src/sagas/enforcement.ts`) | `packages/core/src/sagas/__tests__/enforcement.test.ts` | A Subtask whose change exceeds 2 files or crosses a module boundary MUST be split or promoted to a sibling Task. A Task that requires more than one PR or wave MUST be split. An Epic that spans more than one release MUST be regrouped under a Saga. |
| `I4` | Ownership non-overlapping | `warning` | _none_ | _none_ | A single tier maps to a single orchestration role (per ADR-070). Workers MUST NOT spawn other Workers. Phase Leads MUST NOT own multiple Epics simultaneously. The Orchestrator MUST NOT spawn Workers directly when fan-out exceeds the ADR-070 migration threshold. |
| `I5` | Sagas link via groups, not parent | `error` | `assertSagaInvariantI5` (`packages/core/src/sagas/enforcement.ts`) | `packages/core/src/sagas/__tests__/enforcement.test.ts` | task_relations.type="groups" is the ONLY relation type that links a Saga to its member Epics. The Saga row's parent_id MUST be NULL. Enforced at runtime by assertSagaInvariantI5 AND by the DB CHECK constraint from W1.B (T10329) on label="saga" rows. |
| `I6` | Acceptance criteria required at every tier | `warning` | _none_ | _none_ | Per ADR-066 §"Ownership Matrix" invariant #5, all tasks regardless of type or kind MUST have --acceptance set at creation time. No tier exemption exists. Delegated to the ADR-066 --acceptance requirement on cleo add/add-batch. |
| `I7` | Maximum parent depth is 3 | `error` | `assertSagaInvariantI7` (`packages/core/src/sagas/enforcement.ts`) | `packages/core/src/sagas/__tests__/enforcement.test.ts` | The parent ladder Subtask → Task → Epic is fixed at depth 3 (hierarchy.maxDepth=3). Sagas do NOT consume depth — they attach via groups relations, not parent edges. Enforced at runtime by assertSagaInvariantI7. |
| `I8` | Subtask-to-PR aggregation rule | `warning` | _none_ | _none_ | A Task ships as exactly one PR. The PR's commit history is the union of the Task's Subtask commits. A Subtask never produces its own PR; if a unit of work warrants its own PR, it is a Task, not a Subtask. UNENFORCED at runtime today — load-bearing convention enforced via code review and the lifecycle decision table. |

## ADR-056

Source ADR: [`.cleo/adrs/ADR-056-db-ssot-and-release-completion-invariant.md`](../../.cleo/adrs/ADR-056-db-ssot-and-release-completion-invariant.md)

Registry module: `packages/contracts/src/invariants/adr-056-release.ts`

| Code | Name | Severity | RuntimeGate | Tests | Description |
| --- | --- | --- | --- | --- | --- |
| `D1` | Database topology: keep per-domain split | `info` | _none_ | _none_ | CLEO retains the six per-domain SQLite databases (tasks, brain, conduit, nexus, signaldock, telemetry) documented in DATABASE-ERDS.md. Consolidation is rejected to preserve per-DB WAL throughput, per-DB rollback granularity, and avoid single-writer contention during multi-agent waves. |
| `D2` | Store-layer naming convention | `info` | _none_ | _none_ | New always-on store-layer domains MUST use the kebab-case pair `packages/core/src/store/<domain>-schema.ts` (Drizzle defs) + `packages/core/src/store/<domain>-sqlite.ts` (open/init/CRUD). Opt-in / isolated domains MAY use the folder variant `packages/core/src/<domain>/{schema,sqlite}.ts` (currently telemetry only). |
| `D3` | Migration runner SSoT under migration-manager.ts | `info` | _none_ | _none_ | All six SQLite databases MUST be initialized via `packages/core/src/migration/migration-manager.ts` (`migrateWithRetry()` + `reconcileJournal()`). Per-DB bespoke runners are prohibited for new domains. Rust Diesel migrations for cloud signaldock-storage MUST NOT touch the local SQLite signaldock.db at runtime. |
| `D4` | archiveReason 6-value enum with tombstone semantics | `error` | `assertArchiveReason` (`packages/contracts/src/tasks/archive.ts`) | `packages/contracts/src/tasks/__tests__/archive.test.ts` | The tasks.archive_reason column is constrained to exactly six values (verified, reconciled, superseded, shadowed, cancelled, completed-unverified) via SQLite CHECK constraint AND Zod z.enum validation. Writing 'completed-unverified' from non-migration code MUST throw E_ARCHIVE_REASON_TOMBSTONE — the tombstone is reserved for the T1408 backfill migration only. |
| `D5` | Post-release reconciliation: registry-driven cleo verify --release | `warning` | `runInvariants` (`packages/core/src/release/invariants/registry.ts`) | `packages/core/src/release/invariants/__tests__/archive-reason-invariant.test.ts` | Post-release reconciliation flows through the executable invariants registry at packages/core/src/release/invariants/registry.ts. Customers register via registerInvariant() and the CLI runs every entry on `cleo verify --release <tag>`. First customer: archive-reason-invariant.ts (stamps verified tasks done; creates follow-up tasks for unverified references). |
| `D6` | Commit-message lint for release commits | `info` | _none_ | _none_ | Every commit whose subject matches `^(chore\|feat)\(release\):` MUST contain at least one `T\d+` task reference in the commit body. Enforced by scripts/hooks/commit-msg-release-lint.mjs (T1410). Bypass via CLEO_OWNER_OVERRIDE=1 with audited justification. |

## ADR-070

Source ADR: [`.cleo/adrs/ADR-070-three-tier-orchestration.md`](../../.cleo/adrs/ADR-070-three-tier-orchestration.md)

Registry module: `packages/contracts/src/invariants/adr-070-orchestration.ts`

| Code | Name | Severity | RuntimeGate | Tests | Description |
| --- | --- | --- | --- | --- | --- |
| `ORC-001` | Orchestrator is the HITL interface | `warning` | _none_ | `packages/skills/skills/ct-orchestrator/SKILL.md` | The Orchestrator (Cleo) is the single subagent that talks to the human operator. It plans, decomposes, and delegates — it never produces line-level implementation. Source-of-truth lives in ct-orchestrator/SKILL.md row ORC-001 and is injected into the Orchestrator prompt at spawn time. UNENFORCED at the dispatch layer: this is a prompt-time invariant with no runtime guard today. |
| `ORC-002` | Orchestrator MUST NOT write or edit code | `warning` | _none_ | `packages/skills/skills/ct-orchestrator/SKILL.md` | Every line of code is written by a spawned subagent. The Orchestrator delegates implementation work via cleo orchestrate spawn / delegate_task. UNENFORCED at the dispatch layer: this is a prompt-time invariant — there is no runtime gate that blocks the Orchestrator from calling Edit/Write, so the contract is held by the ct-orchestrator skill text. |
| `ORC-003` | Orchestrator MUST NOT read full source files | `warning` | _none_ | `packages/skills/skills/ct-orchestrator/SKILL.md` | Orchestrator reads only pipeline manifests, task envelopes, and rolled-up phase summaries returned by Phase Leads. Workers read code; the Orchestrator reads summaries. UNENFORCED at the dispatch layer — held by the ct-orchestrator skill text and reinforced by ORC-005 budget pressure. |
| `ORC-004` | Dependency-ordered spawning | `warning` | `validateSpawnReadiness` (`packages/core/src/orchestration/validate-spawn.ts`) | `packages/core/src/orchestration/__tests__/validate-spawn.test.ts`<br>`packages/core/src/skills/orchestrator/__tests__/validator.test.ts` | Spawns within a wave are ordered by task.depends — a Worker MUST NOT be dispatched until its declared dependencies are status=done. Surfaced by validateSpawnReadiness via V_MISSING_DEP / V_UNMET_DEP codes; surfaced by the skill-orchestrator validator via the ORC-004_DEPENDENCY_ORDER warning emitted from packages/core/src/skills/orchestrator/validator.ts. Tier: warning because the validator surfaces ordering issues but does not throw — workers can still proceed if the operator overrides. |
| `ORC-005` | Orchestrator context budget ≈ 10 K tokens | `warning` | `estimateContext` (`packages/core/src/orchestration/context.ts`) | `packages/core/src/orchestration/__tests__/` | The Orchestrator MUST keep its working context under ~10 K tokens; delegate at 80 %. Surfaced by cleo orchestrate context (estimateContext) and by the skill-orchestrator validator (ORC-005_NO_MANIFEST / ORC-005_EMPTY_MANIFEST). UNENFORCED as a hard gate — the budget is advisory, surfaced to the Orchestrator as a warning so the human operator can intervene. |
| `ORC-006` | Worker scope ≤ 3 files per spawn | `error` | `validateSpawnReadiness` (`packages/core/src/orchestration/validate-spawn.ts`) | `packages/core/src/orchestration/__tests__/validate-spawn.test.ts`<br>`packages/core/src/orchestration/__tests__/spawn-prompt.test.ts` | Cross-file reasoning quality degrades beyond ~3 files for a single Worker. Enforced at spawn-time by validateSpawnReadiness — V_ATOMIC_SCOPE_MISSING when task.files is empty, V_ATOMIC_SCOPE_TOO_LARGE when files.length > MAX_WORKER_FILES (currently 3). Spawn-prompt builder injects a Worker Budget Constraints section so the Worker sees the budget inline. Tier: error because the gate refuses to spawn an over-scoped Worker. |
| `ORC-007` | All work traced to an Epic | `warning` | _none_ | `packages/skills/skills/ct-orchestrator/SKILL.md` | Every Task and Subtask MUST attach to a parent Epic (directly or transitively). No orphan work — orphans are filed against the ADR-066 acceptance-criteria gate and surface via cleo find. UNENFORCED at the dispatch layer; the parent-id requirement is materialised through cleo add validation rather than a single ORC-named guard. R6 doctor audit should walk the task graph to surface orphans. |
| `ORC-008` | Zero architectural decisions during execution | `warning` | _none_ | `packages/skills/skills/ct-orchestrator/SKILL.md` | Architectural choices MUST be pre-decided via RCASD consensus or HITL — never inside a worker session. UNENFORCED at the dispatch layer: this is a behavioural invariant held by the ct-orchestrator skill text plus the ADR-066 acceptance criterion that every task must declare its architecture-relevant decisions before spawn. |
| `ORC-009` | Manifest-mediated handoffs | `warning` | _none_ | `packages/skills/skills/ct-orchestrator/SKILL.md` | Orchestrator reads only the key_findings field of pipeline_manifest rows when reconciling worker output. Subagents read the full task description and supporting files. UNENFORCED at the dispatch layer: the contract is held by the ct-orchestrator skill text and reinforced by ORC-003 + ORC-005 budget pressure. |
| `ORC-010` | Lead-interposition required for Epic-child Workers | `warning` | _none_ | _none_ | A Worker spawn against a Task whose parent is type=epic MUST be preceded by a Lead spawn for the same Task (ADR-083 §2.4 / §6). The intended runtime gate (composeSpawnPayload throwing E_LEAD_REQUIRED_FOR_EPIC_CHILD) is FILED but UNSHIPPED — tracked under T10278. Registered here as a warning + runtimeGate:null so the gap is visible in the R6 doctor audit. |
| `ORC-011` | Orchestrator-depth cap at 3 | `warning` | _none_ | _none_ | Recursive Orchestrator spawns (Cleo → sub-Orchestrator → sub-Orchestrator → …) MUST stop at depth 3 (ADR-083 §2.2 + §2.4). The intended runtime gate (composeSpawnPayload throwing E_ORCHESTRATOR_DEPTH_EXCEEDED) is FILED but UNSHIPPED — tracked under T10279. Registered here as a warning + runtimeGate:null so the gap is visible in the R6 doctor audit. |
| `ORC-012` | Thin-agent inversion-of-control | `error` | `enforceThinAgent` (`packages/core/src/orchestration/thin-agent.ts`) | `packages/core/src/orchestration/__tests__/thin-agent.test.ts`<br>`packages/cant/src/__tests__/hierarchy.test.ts` | Workers MUST NOT spawn other subagents. The spawn-capable tools (Agent / Task / TaskCreate) are stripped from the Worker tool list at .cant compile time, and any survivor at spawn time triggers ThinAgentViolationError → E_THIN_AGENT_VIOLATION (exit 68). The only ORC rule with a hard-enforced dispatch-time gate today. |
| `ORC-013` | Worktree provisioning at canonical XDG location | `error` | `assertCanonicalWorktreeLocation` (`packages/worktree/src/worktree-create.ts`) | `packages/worktree/src/__tests__/` | Every agent worktree MUST be created under <cleoHome>/worktrees/<projectHash>/<taskId>/ (ADR-055 + Council D009). createWorktree throws E_WT_LOCATION_FORBIDDEN before any git worktree add call when the computed path falls outside the canonical root. CI gate lint-worktree-location.mjs enforces the same invariant on every PR. The single-most-load-bearing orchestration guard after ORC-012. |
| `ORC-014` | Lead-bypass detection at session end | `error` | `endSession` (`packages/core/src/sessions/index.ts`) | `packages/core/src/sessions/__tests__/` | A Lead session (CLEO_AGENT_ROLE=lead) that ends with tasks_completed > 0 AND delegate_task_count = 0 is rejected with LeadBypassDetectedError → E_LEAD_BYPASS_DETECTED (exit 107). Leads MUST fan out work to Workers; a Lead that did the work itself defeats the three-tier topology. Override via CLEO_OWNER_OVERRIDE=1 (audited to force-bypass.jsonl). |

## See also

- `packages/contracts/src/invariants/index.ts` — central registry (SSoT).
- `scripts/lint-invariant-registry.mjs` — R4 CI gate (T10338) that validates this registry stays truthful.
- `packages/core/src/release/invariants/registry.ts` — R5 (T10339) consumer of the ADR-056 D1-D6 substrate.
- `cleo doctor --audit-invariants` — R6 (T10340) per-invariant enforcement audit.
