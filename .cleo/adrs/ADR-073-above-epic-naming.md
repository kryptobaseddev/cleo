---
id: ADR-073
title: Above-Epic Naming — Saga (prefix SG-)
status: Accepted
date: 2026-05-17
task: T9520
linkedTasks: [T9518, T9514, T9519]
supersedes: null
supersededBy: null
---

# ADR-073: Above-Epic Naming — Saga (prefix SG-)

**Status:** Accepted
**Date:** 2026-05-17
**Task:** T9520
**Linked Tasks:** T9518 (parent epic), T9514 (gating dep — relates writer fix), T9519 (task_relations groups type)

## Context

CLEO's task hierarchy has three well-defined tiers: subtask → task → epic. Multi-release
initiatives (e.g., the LLM provider unification spanning Phase 1–6 and multiple CalVer tags)
have no canonical container above the epic tier. Teams have been using ad-hoc conventions —
"super-epic", "theme", "initiative" — with no standard prefix, no CLI command, and no storage
pattern.

The Council (run `2026-05-17T00:24:48Z`, verdict at
`.cleo/council-runs/20260517T002448Z-e4223249/verdict.md`) evaluated four candidate names:
**Initiative** (`I-`), **Arc** (`AR-`), **Saga** (`SG-`), and a hybrid. The Council reached
5/5 unanimous PASS across all four gate dimensions.

### Why the alternatives were rejected

- **`Initiative / I-`** (Contrarian + First Principles): Single-letter prefix burns the densest
  collision space (~26× denser than two-letter), `I-` is visually ambiguous with digit `1` /
  article "I" / lowercase `l` in monospace, and "initiative" is generic Jira-flavored vocabulary
  that breaks CLEO's deliberate narrative-canon aesthetic (Hearth, Sigil, Sentient, RCASD).

- **`Arc / AR-`** (First Principles, dictionary fit): "Arc" maps well semantically — a narrative
  spanning multiple installments. However, `AR-` collides immediately with `ADR-` in every CLI
  fuzzy search and `grep -r "AR-"` returns hundreds of ADR matches across `.cleo/adrs/`. This is
  a daily-friction failure, not a hypothetical risk. Semantic win cannot survive operational loss.

### Why Saga was chosen

- **Narrative fit (First Principles atom 1):** A Saga is explicitly a multi-chapter, multi-release
  narrative. The word carries the multi-installment weight natively; no teaching required.
- **Two-letter prefix safety (First Principles atom 6):** `SG-` is a two-letter prefix, operating
  in a ~26× less dense collision space than single-letter alternatives.
- **Canon aesthetic (Expansionist):** Saga joins Hearth, Sigil, Sentient, and RCASD as a
  deliberate mythic-narrative noun. Because `task_relations.type = 'groups'` is generic, Saga is
  a recursive narrative-graph noun on day one — `SG-X groups SG-Y groups E-Z` is a legal
  traversal without any schema migration.
- **Contrarian risk neutralized:** The Contrarian's sharpest finding was that `SG-` could
  collide with the actively-expanding SignalDock namespace. This ADR closes the trap at decision
  time by explicitly reserving both `SG-` and `SD-` in the prefix registry below.

---

## Decision

### Name and prefix

Adopt **Saga** (prefix `SG-`) as the above-Epic grouping tier in the CLEO task hierarchy.

The hierarchy is now:

```
subtask (no prefix)
  ↓
Task  (T-)
  ↓
Epic  (E-)
  ↓
Saga  (SG-)   ← this ADR
```

### Storage shape — Saga is a role, not a new TaskType

**Saga is NOT a new `TaskType` enum value.** It is a labeled role that a top-level Epic plays.

Concretely:
- A Saga is an existing `type = 'epic'` task with `label = 'saga'` set via `cleo update --label saga`.
- The `TaskType` enum remains `{subtask, task, epic}`. No schema migration is required.
- Saga-level grouping is expressed through `task_relations.type = 'groups'` edges (implemented in
  T9519) that link the Saga-labeled Epic to its child Epics.

This protects against future drift where someone adds `saga` to the `TaskType` enum. If such a
proposal surfaces, it MUST reference this clause and provide a migration path.

### Wire mechanism

Saga-to-Epic grouping uses `task_relations.type = 'groups'` — a new relation type added in T9519.
A `SG-X` Saga groups child Epics via:

```bash
cleo update SG-X --relates E-Y:groups
```

The `groups` relation is generic and supports recursive traversal: `SG-A groups SG-B groups E-C`
is a legal graph on day one.

### Gating dependency

**T9514** (`cleo update --relates` writer fix) MUST merge before any Saga is materialized.
The `groups` relation write path is broken until T9514 lands. Creating Saga nodes before T9514
merges will produce relation records that cannot be reliably read back.

---

## Prefix Registry

All two-character (and longer) prefixes used for CLEO task IDs MUST be registered here.
Single-character prefixes are reserved for TaskType dispatch only (`T-`, `E-`, `S-`).

| Prefix | Reserved for | Notes |
|--------|-------------|-------|
| `SG-`  | **Saga** (above-Epic grouping) | This ADR |
| `SD-`  | **SignalDock** (identity / messaging subsystem) | Reserved to prevent future collision with `SG-`; SignalDock does not currently issue task-style IDs but uses `SD-*` / `signaldock-*` namespaces in code |
| `ADR-` | Architecture Decision Records | Legacy; not task IDs |
| `D-`   | BRAIN decision records | Stored in brain.db, not tasks.db |

**Rule:** Before introducing a new prefix, add it to this table in a PR that references the
governing ADR. Prefix decisions are permanent — the no-migration storage layer has no rename
primitive for relation IDs.

---

## Consequences

### Positive

- Multi-release themes have a canonical container with a clear name, prefix, and storage
  pattern — no more ad-hoc "super-epic" conventions.
- Zero schema migration: Saga reuses the existing `type = 'epic'` row with a label.
- The `groups` relation is generic; Saga-to-Epic and Saga-to-Saga traversals work on day one.
- The Contrarian's collision risk is closed permanently via the prefix registry.
- CLEO's narrative-canon aesthetic is extended, not diluted.

### Negative

- `cleo list` without filters will surface Saga-labeled Epics alongside regular Epics; users
  must filter by label to see only Sagas. A `cleo saga list` command is a follow-up UX task.
- The `groups` relation overloads `task_relations` alongside dedupe-merge semantics (Contrarian
  finding #2). A discriminator column may be warranted if semantic ambiguity causes bugs;
  filed as a follow-up under T9514 scope or as a new task at the owner's discretion.
- Agents trained on prior CLEO docs will not know the `saga` label convention until
  CLEO-INJECTION.md and AGENTS.md are updated (done in T9520).

---

## Alternatives Considered

| Name | Prefix | Rejection reason |
|------|--------|-----------------|
| Initiative | `I-` | Single-letter; visually ambiguous; generic Jira vocabulary; breaks CLEO narrative canon |
| Arc | `AR-` | Collides with `ADR-` in every CLI grep and fuzzy search across `.cleo/adrs/` |
| Theme | `TH-` | Not evaluated by Council; generic vocabulary, no narrative weight |

---

## References

- Council verdict: `.cleo/council-runs/20260517T002448Z-e4223249/verdict.md`
- T9518 — above-Epic naming epic (parent)
- T9514 — `cleo update --relates` writer fix (gating dependency)
- T9519 — `task_relations.type = 'groups'` implementation
- ADR-066 — Task taxonomy consolidation (TaskType enum definition)
- ADR-062 — Worktree merge strategy (referenced for context on permanent decisions)
