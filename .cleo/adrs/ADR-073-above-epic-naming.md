---
id: ADR-073
title: Task Hierarchy Charter — Saga / Epic / Task / Subtask
status: Accepted
date: 2026-05-17
amendedDate: 2026-05-18
task: T9520
linkedTasks: [T9518, T9514, T9519, T9624]
supersedes: null
supersededBy: null
---

# ADR-073: Task Hierarchy Charter — Saga / Epic / Task / Subtask

**Status:** Accepted (amended 2026-05-18)
**Date:** 2026-05-17 (Charter §0–§2 added 2026-05-18 under T9624)
**Task:** T9520 (original), T9624 (charter amendment)
**Linked Tasks:** T9518 (parent epic), T9514 (gating dep — relates writer fix), T9519 (task_relations groups type), T9624 (charter consolidation)

---

## §0 Purpose & SSoT Boundary

This ADR is the **canonical single source of truth** for CLEO's task hierarchy.
All other surfaces — `AGENTS.md`, `CLEO-INJECTION.md`, the `ct-cleo` /
`ct-orchestrator` / `ct-epic-architect` / `ct-lead` skills, generated docs,
source enums — MUST cite this ADR. They MUST NOT redefine the hierarchy, its
tier semantics, the prefix registry, or the storage shape.

**Sister ADRs (distinct concerns, do not duplicate here):**

- **ADR-066** — enum mechanics: `TaskType`, `TaskKind`, `TaskSeverity` (axis values, validation, severity attestation).
- **ADR-070** — orchestration runtime roles: Orchestrator / Phase Lead / Worker (wave-level fan-out, conduit topics).
- **ADR-065** — release pipeline (project-agnostic; release scheme `calver | semver | calver-suffix` per project config).

ADR-073 owns: **what the tiers are, what they mean, how they are stored, how they are named**.
ADR-066 owns: **the orthogonal axes that classify a task within a tier**.
ADR-070 owns: **which agent role drives a tier at runtime**.
ADR-065 owns: **how a tier's output ships** (scheme is project-configured, not hierarchy-defined).

---

## §1 Task Hierarchy Charter

CLEO's task hierarchy has **four tiers**. Each tier is defined by two
orthogonal invariants: **scope-of-change** (what the unit modifies in the
world) and **agent ownership** (which orchestration role drives it). Both
invariants MUST hold; violating either triggers a mandatory tier promotion or
demotion per §1.3.

### §1.1 Tier Table

| Tier    | Prefix (display) | Storage encoding                                | Scope-of-change (what it modifies)                                | Owner (orchestration role, ADR-070) | Sizing                                                              |
|---------|------------------|-------------------------------------------------|--------------------------------------------------------------------|--------------------------------------|----------------------------------------------------------------------|
| Saga    | `SG-`            | `type='epic'` AND `label='saga'`                | Strategic theme grouping ≥2 Epics across ≥2 releases               | Orchestrator (read-only rollup)      | ≥2 child Epics; unbounded above                                     |
| Epic    | `E-`             | `type='epic'`                                   | One releasable slice; ≥1 PR merged to `main`; ships in one release | Orchestrator (HITL-facing)           | 4–10 child Tasks; single release per project's scheme               |
| Task    | `T-`             | `type='task'`                                   | One atomic PR-sized change; one well-defined capability            | Phase Lead                           | 1–7 child Subtasks (or leaf); single PR; single wave                |
| Subtask | (implicit)       | `type='subtask'`                                | One focused commit; ≤2 files OR one module boundary                | Worker (leaf)                        | 1 commit; contributes to parent Task's single PR; fits one Worker context |

**Note on "release":** CLEO is release-scheme-agnostic. The project's
`release.scheme` config (`calver | semver | calver-suffix`, per ADR-065 +
`packages/contracts/src/release/plan.ts`) determines what "one release"
means for that project. The hierarchy charter does NOT hard-code CalVer.

### §1.2 Invariants (MUST)

**I1 — Storage uniformity.** All task IDs are stored as `T####` (per
`packages/core/src/tasks/id-generator.ts`, `TASK_ID_PATTERN = /^T(\d{3,})$/`).
The `type` column is the canonical tier discriminator. The `label='saga'` field
elevates a `type='epic'` row to Saga semantics. There is NO separate ID space
for Sagas, Epics, Tasks, or Subtasks.

**I2 — Conceptual prefixes are display + import only.** `SG-`, `E-`, `T-` (and
Subtask's implicit absence) are documentation, CLI display, and import-mapping
conventions. They MUST NOT be used as DB primary keys. Permitted uses:
- Documentation and ADR cross-references (e.g., "see E-9354").
- CLI display output (e.g., `cleo show T9518` renders the header as `SG-9518` when `label='saga'`).
- External import mapping — CSV/JSON ingestion that uses prefixed IDs MUST be
  routed to the correct `type` (e.g., a row prefixed `E-` creates a task with `type='epic'`).
- Research / planning / decomposition shorthand on whiteboards, transcripts, briefing docs.

**I3 — Tier promotion is mandatory when scope outgrows the tier.**
- Subtask whose change exceeds 2 files OR crosses a module boundary →
  MUST be split into ≥2 Subtasks under the **same parent Task**, OR (if the
  excess work is genuinely separate) promoted to a new sibling Task under the
  same Epic.
- Task that requires >1 PR or >1 wave to land → MUST be split into ≥2 sibling
  Tasks under the **same parent Epic**, each producing exactly one PR. A Task
  is NEVER split into Subtasks for the purpose of producing multiple PRs —
  Subtasks contribute to ONE Task's PR (per §1.1).
- Epic that spans ≥2 releases → MUST be regrouped under a Saga, with the
  releasable slices split into sibling Epics under that Saga.

**I4 — Ownership is non-overlapping.** A single tier maps to a single
orchestration role (per ADR-070). Workers MUST NOT spawn other Workers. Phase
Leads MUST NOT own multiple Epics simultaneously. The Orchestrator MUST NOT
spawn Workers directly when fan-out exceeds the ADR-070 migration threshold
(>3 Workers / cross-wave IVTR).

**I5 — Sagas link via `groups`, not `parent`.** `task_relations.type='groups'`
is the ONLY relation type that links a Saga to its member Epics. The Saga
row's `parent_id` MUST be NULL. `cleo list --parent <sagaId>` returns empty;
member discovery uses `cleo saga members <sagaId>`.

**I6 — Acceptance criteria required at every tier.** Per ADR-066 §"Ownership
Matrix" invariant #5, all tasks regardless of `type` or `kind` MUST have
`--acceptance` set at creation time. No tier exemption exists.

**I7 — Maximum parent depth is 3.** The parent ladder Subtask → Task → Epic is
fixed at depth 3 (`hierarchy.maxDepth=3`). Sagas do NOT consume depth — they
attach via `groups` relations, not parent edges. This preserves the depth
budget regardless of Saga count.

**I8 — Subtask-to-PR aggregation rule.** A Task ships as exactly one PR. The
PR's commit history is the union of the Task's Subtask commits (plus any
commits the Phase Lead makes directly to the Task). A Subtask never produces
its own PR; if a unit of work warrants its own PR, it is a Task, not a
Subtask. This is the load-bearing rule that distinguishes Subtask from Task.

### §1.3 Tier Lifecycle Decision Table

Use this table whenever a tier's scope or ownership invariant is questioned.

| Observed condition                                        | Required action                                                            | Governing invariant |
|-----------------------------------------------------------|----------------------------------------------------------------------------|---------------------|
| Subtask edits >2 files                                    | Split into ≥2 Subtasks under the same Task, OR promote to sibling Task     | I3, I8              |
| Subtask crosses module boundary                           | Split into ≥2 Subtasks under the same Task                                 | I3                  |
| Subtask appears to need its own PR                        | Promote to a sibling Task — Subtasks never own a PR                        | I8                  |
| Task generates >1 PR                                       | Split into ≥2 sibling Tasks under the same Epic                            | I3, I8              |
| Task spans >1 wave                                         | Split into sibling Tasks across waves, OR promote to Epic                  | I3 + ADR-070        |
| Epic spans >1 release                                      | Regroup under a Saga; split into release-sized sibling Epics under it      | I3                  |
| Saga has 1 member Epic                                     | Demote — remove `label='saga'`                                             | §1.1 sizing         |
| Epic has 0 child Tasks                                     | Demote — convert to standalone Task                                        | §1.1 sizing         |
| Epic has >10 child Tasks                                   | Split Epic into sibling Epics, OR regroup under Saga                       | §1.1 sizing         |
| Worker attempts to spawn another Worker                    | Reject — escalate fan-out to Phase Lead                                    | I4 + ADR-070        |
| External import row prefixed `E-` lacks `type` field       | Map to `type='epic'`                                                       | I2 (import mapping) |
| External import row prefixed `SG-` lacks type/label        | Map to `type='epic'`, `label='saga'`                                       | I2 (import mapping) |

---

## §2 Prefix Registry (display + import mapping)

The prefix registry serves **two non-storage purposes**: human/agent display
shorthand, and external import routing (e.g., CSV ingestion from other task
systems). Prefixes are NEVER persisted as part of the primary key.

### §2.1 Registered Prefixes

| Prefix | Tier / Meaning                                  | Storage encoding                                |
|--------|-------------------------------------------------|--------------------------------------------------|
| (none) | Subtask                                         | `T####` with `type='subtask'`                   |
| `T-`   | Task                                            | `T####` with `type='task'`                      |
| `E-`   | Epic                                            | `T####` with `type='epic'`                      |
| `SG-`  | Saga                                            | `T####` with `type='epic'` AND `label='saga'`   |
| `SD-`  | SignalDock subsystem namespace (reserved)        | not a task ID — code/namespace identifier        |
| `ADR-` | Architecture Decision Record                     | filesystem (`.cleo/adrs/*.md`)                   |
| `D-`   | BRAIN decision record                            | brain.db (`decisions` table)                     |

### §2.2 Registry Rules

1. **Permanence.** Once registered, a prefix is permanent. The no-migration
   storage layer has no rename primitive for relation IDs.
2. **Amendment process.** A new prefix MAY be added only via a PR that amends
   §2.1 and cites a governing ADR.
3. **Case normalization.** Lowercase variants (`sg-`, `e-`, `t-`) MUST be
   uppercased on parse. Mixed-case forms (`Sg-`, `Tt`) are rejected.
4. **No collision with TaskType column values.** Prefix letters MUST NOT match
   the literal `type` column strings `subtask`, `task`, `epic`.
5. **Display vs storage.** Display formatters MAY render `SG-9518` for a row
   whose stored `id='T9518'` and `label='saga'`. Storage operations MUST always
   resolve through the bare `T####` key.

---

## §3 Why Saga Was Chosen (original 2026-05-17 decision context)

### §3.1 Context

CLEO's hierarchy had three well-defined tiers (subtask → task → epic).
Multi-release initiatives (e.g., the LLM provider unification spanning Phase
1–6 and multiple release tags) had no canonical container above the epic
tier. Teams used ad-hoc conventions — "super-epic", "theme", "initiative" —
with no standard prefix, no CLI command, and no storage pattern.

The Council (run `2026-05-17T00:24:48Z`, verdict at
`.cleo/council-runs/20260517T002448Z-e4223249/verdict.md`) evaluated four
candidate names: **Initiative** (`I-`), **Arc** (`AR-`), **Saga** (`SG-`), and
a hybrid. The Council reached 5/5 unanimous PASS across all four gate dimensions.

### §3.2 Why the alternatives were rejected

- **`Initiative / I-`** (Contrarian + First Principles): Single-letter prefix burns
  the densest collision space (~26× denser than two-letter), `I-` is visually
  ambiguous with digit `1` / article "I" / lowercase `l` in monospace, and
  "initiative" is generic Jira-flavored vocabulary that breaks CLEO's
  deliberate narrative-canon aesthetic (Hearth, Sigil, Sentient, RCASD).
- **`Arc / AR-`** (First Principles, dictionary fit): "Arc" maps well semantically — a
  narrative spanning multiple installments. However, `AR-` collides immediately
  with `ADR-` in every CLI fuzzy search and `grep -r "AR-"` returns hundreds of
  ADR matches across `.cleo/adrs/`. Operational loss outweighs semantic win.

### §3.3 Why Saga was chosen

- **Narrative fit.** A Saga is explicitly a multi-chapter, multi-release
  narrative. The word carries the multi-installment weight natively.
- **Two-letter prefix safety.** `SG-` operates in a ~26× less dense collision space
  than single-letter alternatives.
- **Canon aesthetic.** Saga joins Hearth, Sigil, Sentient, and RCASD as a
  deliberate mythic-narrative noun. Because `task_relations.type='groups'` is
  generic, Saga is a recursive narrative-graph noun on day one — `SG-X groups
  SG-Y groups E-Z` is a legal traversal without schema migration.
- **Collision risk neutralized.** The Contrarian's sharpest finding was that `SG-`
  could collide with the actively-expanding SignalDock namespace. §2.1 closes
  the trap at decision time by reserving both `SG-` and `SD-`.

---

## §4 Storage Shape (preserved from 2026-05-17)

**Saga is NOT a new `TaskType` enum value.** It is a labeled role that a
top-level Epic plays. Concretely:

- A Saga is an existing `type='epic'` task with `label='saga'` set via
  `cleo update --label saga` (or created directly via `cleo saga create`).
- The `TaskType` enum remains `{subtask, task, epic}` per ADR-066. No schema
  migration is required.
- Saga-level grouping is expressed through `task_relations.type='groups'` edges
  (implemented in T9519) that link the Saga-labeled Epic to its child Epics.

This protects against future drift where someone proposes adding `saga` to the
`TaskType` enum. If such a proposal surfaces, it MUST reference this clause and
provide a full migration path for every existing Saga.

### §4.1 Wire mechanism

Saga-to-Epic grouping uses `task_relations.type='groups'`. A `SG-X` Saga groups
child Epics via:

```bash
cleo update SG-X --relates E-Y:groups
```

The `groups` relation is generic and supports recursive traversal: `SG-A groups
SG-B groups E-C` is a legal graph on day one.

### §4.2 Gating dependency

**T9514** (`cleo update --relates` writer fix) MUST merge before any Saga is
materialized. The `groups` relation write path is broken until T9514 lands.
Creating Saga nodes before T9514 merges will produce relation records that
cannot be reliably read back.

---

## §5 Alternatives Considered

| Name       | Prefix | Rejection reason                                                                                    |
|------------|--------|-----------------------------------------------------------------------------------------------------|
| Initiative | `I-`   | Single-letter; visually ambiguous; generic Jira vocabulary; breaks CLEO narrative canon             |
| Arc        | `AR-`  | Collides with `ADR-` in every CLI grep and fuzzy search across `.cleo/adrs/`                        |
| Theme      | `TH-`  | Not evaluated by Council; generic vocabulary, no narrative weight                                   |

---

## §6 Consequences

### §6.1 Positive

- Single canonical SSoT for the full 4-tier hierarchy — no more drift across AGENTS.md, skills, and ADRs.
- Multi-release themes have a canonical container (Saga) with clear name, prefix, storage pattern, and lifecycle rules.
- Zero schema migration: Saga reuses the existing `type='epic'` row with a label.
- The `groups` relation is generic; Saga-to-Epic and Saga-to-Saga traversals work on day one.
- Prefix collision risk closed permanently via §2.1 registry.
- Tier promotion / demotion rules (§1.3) are machine-checkable — agents and CI can flag violations.
- I8 (Subtask-to-PR aggregation) provides a load-bearing rule distinguishing Subtask from Task at every decision point.

### §6.2 Negative / Trade-offs

- `cleo list` without filters surfaces Saga-labeled Epics alongside regular Epics; filter by label to see only Sagas. `cleo saga list` is the preferred path.
- The `groups` relation overloads `task_relations` alongside dedupe-merge semantics. A discriminator column may be warranted if semantic ambiguity causes bugs.
- The `SG-` display prefix on stored `T####` IDs creates a display/storage indirection that all CLI formatters and search helpers MUST honor.
- Tier-promotion enforcement (I3) is currently a guideline, not a CI gate. Future work may add a `cleo doctor` check that flags tier-scope violations.

---

## §7 References

- **ADR-066** — Task Taxonomy Consolidation (enum mechanics: TaskType / TaskKind / TaskSeverity; AC-everywhere; severity attestation).
- **ADR-070** — Three-tier Orchestration (Orchestrator / Phase Lead / Worker role contract; wave topology).
- **ADR-065** — PR-required release flow (release scheme is project config, not hierarchy concern).
- **ADR-062** — Worktree merge strategy (referenced for context on permanent decisions).
- **T9518** — Above-Epic naming epic (parent).
- **T9514** — `cleo update --relates` writer fix (gating dependency).
- **T9519** — `task_relations.type='groups'` implementation.
- **T9624** — Hierarchy Charter consolidation (this amendment).
- **Council verdict** — `.cleo/council-runs/20260517T002448Z-e4223249/verdict.md`.
- **Code SSoT** — `packages/core/src/tasks/id-generator.ts` (TASK_ID_PATTERN), `packages/contracts/src/task.ts` (TaskType enum), `packages/contracts/src/release/plan.ts` (RELEASE_SCHEME).

---

## §8 Change Log

- **2026-05-17** — Initial ADR. Saga tier adopted (`SG-`). Prefix registry created with `SG-`, `SD-`, `ADR-`, `D-`.
- **2026-05-18** — Amended under T9624. Added §0 SSoT boundary, §1 Hierarchy Charter (4-tier table + 8 invariants including I8 Subtask-to-PR aggregation rule + lifecycle decision table), §2 Prefix Registry expanded with `T-`, `E-`, and explicit display/import-only semantics. Release-scheme-agnostic wording (project's `release.scheme` config governs, not hierarchy). Original Saga decision content preserved verbatim as §3–§6. Charter now covers all 4 tiers as canonical SSoT, not only Saga.
