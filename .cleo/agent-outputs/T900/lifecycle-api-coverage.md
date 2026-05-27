# Lifecycle API Coverage Audit (T881)

**Epic**: T876 (owner-labelled T900)
**Task**: T881 — verify every RCASD-IVTR+C stage is reachable via CLI + document the canonical stage-advancement flow.

## Summary

The `cleo lifecycle` CLI exposes **9 subcommands** covering **10 canonical stages**. Every stage can be started, completed, skipped, reset, and gated from the command line. Studio's Pipeline view is read-only today — drag-drop stage advancement is deferred (see "Gaps" below).

## Canonical Stages (RCASD-IVTR+C)

| Order | Stage | Category | Skippable | CLI label | UI label |
|------:|-------|----------|:---------:|-----------|----------|
| 1 | `research` | planning | no | `research` | Research |
| 2 | `consensus` | decision | yes | `consensus` | Consensus |
| 3 | `architecture_decision` | decision | yes | `architecture_decision` | **Design / ADR** (T880) |
| 4 | `specification` | planning | no | `specification` | Specification |
| 5 | `decomposition` | planning | no | `decomposition` | Decomposition |
| 6 | `implementation` | execution | no | `implementation` | Implementation |
| 7 | `validation` | validation | no | `validation` | Validation |
| 8 | `testing` | validation | no | `testing` | Testing |
| 9 | `release` | delivery | yes | `release` | Release |
| 10 | `contribution` | (cross-cutting terminal) | — | `contribution` | Contribution |

Plus two terminal display buckets:
* `done` — Studio-only display column; a `status='done'` + `pipeline_stage='contribution'` task lands here.
* `cancelled` — enum value (order 11) AND Studio column; `status='cancelled'` + `pipeline_stage='cancelled'`.

## CLI Surface

```
cleo lifecycle show <epicId>                    # snapshot of all stages for an epic
cleo lifecycle start <epicId> <stage>           # mark stage in_progress
cleo lifecycle complete <epicId> <stage>        # mark stage completed
cleo lifecycle skip <epicId> <stage> --reason   # mark stage skipped (requires reason)
cleo lifecycle gate <epicId> <stage>            # validate gate before advancing (exit 80 on fail)
cleo lifecycle guidance [stage] [--epicId TXXX] # LLM-friendly prompt guidance per stage
cleo lifecycle history <taskId>                 # ordered history of stage transitions
cleo lifecycle reset <epicId> <stage> --reason  # reset a stage back to pending
cleo lifecycle gate-record pass <epicId> <gate> # record a gate pass (with --agent/--notes)
cleo lifecycle gate-record fail <epicId> <gate> # record a gate fail (with --reason)
```

Additional dispatch surface (not under `lifecycle` group):
* `cleo verify <id> --gate <g> --value <v> --evidence "<atom>..."` — T832 evidence-based verification gates (per-task, not per-stage).
* `cleo show <id>` — surfaces `pipeline_stage` and `verification_json` directly.
* `cleo pipeline` alias → `cleo phase` — project-level phase lifecycle (different from per-task IVTR).

## Canonical Advancement Flow

Drive a task from inception to `done` with this command sequence:

```bash
# 1. Create the task (auto-assigned to pipeline_stage=research for epics,
#    or inherited from parent for subtasks).
cleo add "Build feature X" --type task --parent T876 \
  --acceptance "crit 1|crit 2|crit 3"

# 2. Advance the parent epic's lifecycle through the chain. Children cannot
#    complete until the parent epic's lifecycle is past decomposition.
cleo lifecycle complete T876 research
cleo lifecycle complete T876 consensus
cleo lifecycle complete T876 architecture_decision
cleo lifecycle complete T876 specification
cleo lifecycle complete T876 decomposition
cleo lifecycle start T876 implementation

# 3. Work the task. Set verification gates with evidence before completing.
cleo verify T<id> --gate implemented  --value true \
  --evidence "commit:<sha>;files:src/x.ts,tests/x.test.ts"
cleo verify T<id> --gate testsPassed --value true \
  --evidence "test-run:<path-to-vitest-json>"
cleo verify T<id> --gate qaPassed    --value true \
  --evidence "tool:biome;tool:pnpm-test"

# 4. Complete the task — the gate ritual ensures verification passes.
cleo complete T<id>
# Automatically sets status=done + pipeline_stage=contribution (T877 invariant).

# 5. Optional: advance epic through validation/testing/release as milestones hit.
cleo lifecycle complete T876 implementation
cleo lifecycle complete T876 validation
cleo lifecycle complete T876 testing
cleo lifecycle complete T876 release
# (or skip release with --reason "batched into parent release")
```

## Gates and Evidence (T832/T877)

`cleo complete <id>` now enforces three verification gates: `implemented`,
`testsPassed`, `qaPassed`. Each gate requires evidence (T832):

| Gate | Evidence kinds |
|------|---------------|
| `implemented` | `commit:<sha>` **AND** `files:<p1,p2>` |
| `testsPassed` | `test-run:<path-to-vitest-json>` (file must exist + parse + have passCount > 0) |
| `qaPassed` | `tool:biome|tsc|eslint|pnpm-build|pnpm-test|security-scan` (with exit 0) |

`cleo verify <id> --gate <name> --value true --evidence "<atom>..."` records
evidence; multiple atoms separate with `;`.

## Structural Invariants (T877)

The database now ENFORCES these rules via SQLite triggers
(`trg_tasks_status_pipeline_insert` / `trg_tasks_status_pipeline_update`):

1. `status='done'` ⇒ `pipeline_stage IN ('contribution','cancelled')`
2. `status='cancelled'` ⇒ `pipeline_stage='cancelled'`

Any INSERT/UPDATE violating these raises `T877_INVARIANT_VIOLATION`. The
production code paths (`complete`, `cancel-ops`, converter `taskToRow`) all
satisfy this automatically; callers don't need to think about it.

## Studio Surface

| Surface | Stage-aware? | Notes |
|---------|:-----------:|-------|
| `/tasks` dashboard | read-only | T874/T878: epic progress, status/priority/type counts, deferred + archived toggles |
| `/tasks/pipeline` | read-only | Kanban columns mapped to enum stages (T873/T880: `architecture_decision` labelled "Design / ADR") |
| `/tasks/graph` | read-only | T879: SVG force-directed graph showing parent, blocks, depends edges |
| `/tasks/tree/[epicId]` | read-only | Hierarchical tree view |
| `/tasks/[id]` | read-only | Full task detail with pipeline_stage + verification state |

## Gaps (intentional, deferred)

* **Drag-drop stage advance in Studio Pipeline view** — not in T900 scope. Users advance stages via `cleo lifecycle complete` today. This is a future-work candidate (call it `T-STUDIO-DRAG`).
* **Bulk-operations UI** — archiving + completing multiple tasks from Studio is CLI-only. Also future work.
* **Pipeline view mutation** — Pipeline and Graph views are data-only. All mutations flow through CLI so the lifecycle gate ritual is enforced uniformly.

## Evidence

* All existing `cleo lifecycle` subcommands demonstrated working against the CLEO project epic T876 during T877 implementation (research→decomposition→implementation successfully advanced).
* Studio Pipeline column labels verified against enum via
  `packages/studio/src/routes/tasks/pipeline/__tests__/resolve-column-id.test.ts`
  (COLUMN_LABELS test block added in T880).
* Tests in `packages/studio/src/routes/tasks/graph/__tests__/graph.test.ts`
  verify the new Graph route emits correct node/edge shapes.

---

Generated: 2026-04-17 · T881 · Epic T876 (owner-labelled T900)
