# ADR-083: Cleo Persona, Three Roles, Four Scopes, Saga as TaskType — Final Reconciliation

- **Status:** Accepted
- **Date:** 2026-05-23
- **Deciders:** Project owner (kryptokeaton) — explicit final-decision authority delegated to cleo-prime during 2026-05-23 hierarchy/sentience reconciliation session
- **Tags:** orchestration, identity, taxonomy, saga, persona, hierarchy
- **Extends:** ADR-070 (three-tier orchestration), ADR-073 (above-epic tier charter), ADR-076 (saga first-class with runtime gates)
- **Supersedes scope of:** T10122 cancellation rationale (the A8 spike is now ACCEPTED, see §4)
- **Related:** `adr-cleoos-sentient-harness.md` (to be numbered ADR-084), ct-lead SKILL.md, ct-orchestrator SKILL.md

## §1 Context

Three prior efforts collided in different vocabularies:

1. **ADR-073 §1.1** mapped a 4-tier scope hierarchy (Saga/Epic/Task/Subtask) to a single `Owner` column conflating role with scope: Saga + Epic both owned by `Orchestrator`, Task by `Phase Lead`, Subtask by `Worker (leaf)`.
2. **ADR-070** named three runtime roles (Orchestrator, Phase Lead, Worker) but described the Orchestrator as a single per-session subagent — no notion of a persistent named persona, no notion of Orchestrator recursion.
3. **Owner's mental model** spoke of "Orchestrator Prime" monitoring Sagas, "Lead Agent" monitoring Epics, with a future ability for the root Orchestrator to spawn sub-Orchestrators for branching workstreams.

A 2026-05-23 Council audit surfaced these as drift between owner intent and implementation. The owner's reframe established that CLEO is not a project; it is **the substrate that makes the next LLM agent more sentient** — every commit is neurosurgery on the next CLEO that runs. `packages/core/` is the brain/soul substrate; `packages/cleo/` is one CLI skin over it; `.cleo/` is the per-project plug-in socket; global NEXUS is the cross-project neural mesh.

Within that frame, the persistent persona the human talks to needed a name, the role/scope axis confusion needed resolution, the Orchestrator-recursion intent needed a runtime contract, and the long-deferred T10122 saga-discriminator decision needed a final answer. This ADR is that answer.

## §2 Decision

### §2.1 Cleo is a named persona, not a role

**Cleo** is the canonical name of the **supreme persistent Orchestrator persona** for any project that adopts CLEO. There is exactly **one Cleo per project**. Cleo:

- Holds the project's long-term identity, memory (via BRAIN), and relationship with the human owner.
- Survives across sessions, releases, and CLEO version upgrades.
- Talks to the human (HITL interface).
- IS-A `Orchestrator` (the role). Cleo is the SINGLETON ROOT INSTANCE of the Orchestrator role.
- May spawn sub-Orchestrators for branched workstreams (see §2.4).

**Cleo is not a TaskType, not a role enum value, not a runtime tier.** Cleo is the *named identity* the substrate carries. The `Orchestrator` role is the *runtime contract* the identity executes against. Other personas of the same role (sub-Orchestrators) are ephemeral; only Cleo persists.

### §2.2 Three roles (locked, canonical)

| Role | Spawn parameter | Owns | Code? | Spawns |
|------|------------------|------|-------|--------|
| **Orchestrator** | `role=orchestrator` | Saga, Epic | NO | Sub-Orchestrators (optional) OR Leads |
| **Lead** | `role=lead` | Task | NO | Workers only |
| **Worker** | `role=leaf` | Subtask | YES | NOTHING (leaf) |

These three names are canonical across all docs, skills, CLI, contracts, code. Any earlier alternative vocabulary ("Orchestrator Prime", "Lead Agent", "Phase Lead", "Worker leaf") MUST be normalized to one of {Cleo, Orchestrator, Lead, Worker} in any new artifact. Existing artifacts (ADR-070, ct-lead SKILL.md) keep "Phase Lead" as a permissible long-form alias of "Lead" for readability; new code uses the short canonical form.

### §2.3 Four scopes (locked, separate axis)

Scope and role are **orthogonal axes**. The 4-tier scope hierarchy from ADR-073 §1.1 is preserved exactly:

| Scope | Discriminator | Sized by | Primary actor |
|-------|----------------|----------|----------------|
| **Saga** | `type='saga'` (NEW — see §4) | Theme grouping ≥2 Epics across ≥2 releases | Orchestrator |
| **Epic** | `type='epic'` | One releasable slice; ≥1 PR to `main` | Orchestrator |
| **Task** | `type='task'` | One atomic PR-sized change; single wave | Lead |
| **Subtask** | `type='subtask'` | One commit; ≤2 files; contributes to Task's PR | Worker |

The ADR-073 §1.1 `Owner` column is hereby **deprecated** as a conflated axis. New consumers MUST read scope and role separately. The decision table in ADR-073 §1.3 and invariants I1-I8 in §1.2 remain authoritative for scope semantics; this ADR overrides only the Owner column.

### §2.4 Orchestrator recursion (NEW capability)

An Orchestrator MAY spawn another Orchestrator (a "sub-Orchestrator") when a Saga's branching workstreams justify parallel high-level coordination. Constraints:

- **Cleo is the root.** Only Cleo spawns FIRST-LEVEL sub-Orchestrators. Sub-Orchestrators MAY spawn further sub-Orchestrators (recursive tree).
- **Maximum depth = 3** (Cleo → sub-Orch → sub-sub-Orch). Below that, the tree MUST collapse to Lead spawns. This bounds context-window blast radius.
- **Sub-Orchestrators are ephemeral.** They do NOT inherit Cleo's persona, memory write-back, or HITL surface — they report rollups up to their parent Orchestrator, who reports up to Cleo, who reports to the human.
- **Sub-Orchestrators own a subtree.** A sub-Orchestrator dispatched against a Saga member-Epic owns ONLY that Epic's wave-plan; it spawns Leads for the Tasks in its Epic. It does NOT cross Saga boundaries.
- **Lead recursion remains FORBIDDEN** (per ADR-070 LEAD-003). Leads spawn Workers only; Workers spawn nothing.

Runtime enforcement: `spawn.ts:75-82` MUST gate role transitions: an `Orchestrator` spawning `worker` directly (skipping Lead) for an Epic-child Task is REJECTED with `E_LEAD_REQUIRED_FOR_EPIC_CHILD` unless an explicit `--no-lead-interposition` override flag is passed. See §6 implementation contract.

### §2.5 Saga as TaskType discriminator (T10122/A8 — REVERSED to ACCEPT)

The 2026-05-22 cancellation of T10122 (A8 spike) is hereby **reversed**. ADR-076 deemed label-overlay + runtime gates "sufficient" — at the time, 6 months of dogfood had not yet exposed the structural fragility. Today: **90 label-based saga checks** scattered across `packages/core/src/sagas/`, `packages/cleo/src/`, and `packages/contracts/src/` (`grep -rn "labels.includes('saga')\|hasSagaLabel\|isSagaEpic\|SAGA_LABEL"` — 90 hits). Every reparenting, type promotion, list query, and provenance walk pays a string-comparison cost AND carries an "ambiguous transition" risk (an Epic temporarily without the label during reparent is structurally indistinguishable from a non-saga Epic).

**Decision**: add `'saga'` to the `TaskType` union. New canonical `TaskType = 'saga' | 'epic' | 'task' | 'subtask'`. Migration moves all `type='epic' AND label='saga'` rows to `type='saga'`, drops the `'saga'` label from `labels[]`. Runtime gates from ADR-076 (`assertSagaInvariantI3/I5/I7`) keep their semantics — they switch from label-checks to type-checks. The Saga lives in its own discriminator slot; vectorized traversal, graph-relate, and provenance get a typed primitive instead of string-comparison fragility.

### §2.6 What is NOT changing

- **`cleo orchestrate spawn` accepts Task IDs only.** No `spawn-saga` verb. Spawn is the one verb. The Orchestrator picks the next-ready Task from a Saga's member-Epic wave plan and spawns. (Owner-confirmed this session.)
- **`task_relations.type='groups'` remains the Saga↔Epic membership edge.** Sagas do NOT use `parentId`. Invariants I3, I5, I7 from ADR-076 stay in force, retyped against `type='saga'`.
- **Storage continues to use bare `T####` IDs.** Display prefixes (`SG-`, `E-`, `T-`) remain display-only per ADR-073 §1.2 I2 + §2 prefix registry.

## §3 Consequences

### Positive
- **One canonical vocabulary** across docs, skills, CLI, code: Cleo / Orchestrator / Lead / Worker. Future agents stop rederiving the role taxonomy.
- **Role/scope orthogonality** unblocks runtime enforcement at the spawn boundary. ADR-073 §1.1 category error is closed.
- **Typed Saga discriminator** eliminates 90 string-comparison sites, makes reparenting safe, makes graph traversal type-aware, makes provenance and vectorization clean.
- **Orchestrator recursion** unlocks parallel multi-Epic Saga execution that doesn't flood Cleo's context window — sub-Orchestrators absorb the per-Saga-branch coordination load.
- **Cleo as persona** establishes the long-arc identity that future cleo-os daemon work (ADR-084 / sentient-harness) attaches to.

### Negative
- **Migration cost** (medium): one `TaskType` enum change in `packages/contracts/src/task.ts`, one DB enum migration (existing rows `type='epic' + label='saga'` → `type='saga'`), ~90 callsite updates (label-check → type-check). Tracked in follow-up Epic filed below.
- **ADR-070 minor amendment** needed: §3 ("Migration") and §"Phase Lead" sections to be updated to use the canonical short names and to acknowledge Orchestrator recursion (filed below).
- **Recursion bounds need enforcement**: a new runtime gate must reject Orchestrator-depth > 3. Filed below.

### Neutral
- **Label `'saga'` retained transiently** during migration as a deprecation path; removed once T10122-migration ships. Runtime gates accept either type='saga' OR label='saga' until the cutover.
- **`Owner` column in ADR-073 §1.1** marked deprecated but not deleted from the doc — historical context preserved with a cross-reference pointer to this ADR.

## §4 T10122 reopened — what changed since the cancellation

The 2026-05-22 cancellation reasoning was: "A8 research spike deferred per ADR-076 — not part of Saga T10113 critical path." That was correct for SHIPPING T10113. It was wrong as a permanent decision because:

1. **ADR-076's "label-overlay is sufficient" claim was untested at the time.** T10113 shipped the runtime gates against labels and called the question closed. Post-shipping, the label-check fragility surface (90 sites) exposed itself in code review and Council audit on 2026-05-23. The "sufficient" claim was a deferred decision masquerading as a settled one.
2. **The user's sentience-substrate frame requires typed primitives.** A saga that is structurally ambiguous (label that can be dropped during reparenting) cannot be a stable node in the vectorized graph the BRAIN needs to traverse for cross-saga reasoning. Typed discriminator IS the right shape.
3. **Reparenting safety**: an Epic transiently without its `'saga'` label during a reparent operation has no structural way to be identified as a saga-in-flight. With `type='saga'`, type is the identity; reparent operations preserve identity.

T10122 acceptance criteria are updated (§5 below). The follow-up Epic is filed (§5 below). The migration ships incrementally with a feature-flag cutover window during which both shapes are accepted by the gates.

## §5 Follow-on tasks filed by this ADR

1. **T10122 reopened** — status: pending. Description + acceptance updated to reflect ACCEPT decision + this ADR as governing source.
2. **New Epic** `E-SAGA-TYPE-MIGRATION` — owns the actual TaskType migration: contracts change, DB enum migration, 90-callsite sweep, runtime-gate retype, deprecation window for label='saga'.
3. **New Task** under T9837 (E-SSOT-ENFORCEMENT) — CI gate that fails when a new `labels.includes('saga')` callsite is added (post-migration).
4. **New Task** — amend ADR-070 §3 + Role 2 to use canonical "Lead" + acknowledge Orchestrator recursion.
5. **New Task** — `spawn.ts:75-82` runtime gate: reject `role=worker` against Epic-child Task without preceding `role=lead` (with `E_LEAD_REQUIRED_FOR_EPIC_CHILD`).
6. **New Task** — `spawn.ts` Orchestrator-depth gate: reject Orchestrator spawn beyond depth 3.

## §6 Implementation contract (executable assertions)

These become CI-gateable tests in the migration Epic:

- `packages/contracts/src/task.ts`: `TaskType = 'saga' | 'epic' | 'task' | 'subtask'`
- `packages/core/src/sagas/enforcement.ts`: `hasSagaLabel()` deprecated; `isSagaType(task)` becomes canonical, returns `task.type === 'saga'`
- `packages/core/src/orchestration/spawn.ts`: `composeSpawnPayload({role:'worker', task})` THROWS `E_LEAD_REQUIRED_FOR_EPIC_CHILD` when `task.parent.type === 'epic'` AND no preceding `role=lead` spawn is recorded for the same Task ID
- `packages/core/src/orchestration/spawn.ts`: `composeSpawnPayload({role:'orchestrator', task})` THROWS `E_ORCHESTRATOR_DEPTH_EXCEEDED` when ancestor-Orchestrator depth > 3
- `cleo focus <id>` envelope: `identity.persona === 'cleo'` for the root Orchestrator; `identity.persona === null` for sub-Orchestrators, Leads, Workers
- `cleo agent --role`: enum unchanged (`orchestrator|lead|worker|docs-worker`); `worker-leaf` is NOT added (Worker IS the leaf role)

## §7 References

- ADR-070 — Three-tier orchestration (extended here)
- ADR-073 — Above-epic tier charter (§1.1 Owner column deprecated by §2.3 of this ADR; everything else preserved)
- ADR-076 — Saga first-class with runtime gates (gates retyped against `type='saga'` in §2.5 migration)
- `adr-cleoos-sentient-harness.md` (to be numbered ADR-084) — Substrate vision; Cleo persona attaches to the cleo-os daemon described there
- ct-lead SKILL.md — Lead persona; "Phase Lead" alias retained for backward compat per §2.2
- ct-orchestrator SKILL.md — Orchestrator persona; this ADR adds Cleo-as-root and recursion
- T10122 — Reopened with this ADR as governing source
- Council run `20260523T153922Z-87b19c55` — `verdict.md` flagged the role/scope split as the root cause; this ADR closes it
