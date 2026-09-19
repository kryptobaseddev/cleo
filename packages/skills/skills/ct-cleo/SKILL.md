---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.11.0
  lastReviewed: 2026-09-19
  stability: stable
---

# CLEO Protocol Guide

<!-- thin-pointer: full protocol is in CLEO-INJECTION.md (T9148) -->
Full protocol content lives in `~/.cleo/templates/CLEO-INJECTION.md`.
Emit any section with: `cleo briefing inject --section <name>`

Supported sections: `session-start` · `work-loop` · `triggers` · `task-creation`
· `task-discovery` · `task-relationships` · `session-commands` · `memory` · `nexus`
· `orchestration` · `playbooks` · `documents` · `error-handling` · `pre-complete-gate`
· `spawn-tiers` · `rules` · `memory-jit` · `escalation`

Task find defaults to lexical query terms. Fuzzy character-subsequence matching requires `--fuzzy`; inspect per-row `match.kind` and `match.fields` before inferring related work. `--in` restricts the source field. Matching mode and fuzzy field explanations survive scalar/human output on stderr. Semantic retrieval remains separately identified.

List/find expose `data.population` with matched and returned counts, truncation, pagination, and archive eligibility. Count output equals emitted rows; use `--all` or `--limit 0` to enumerate all matches, and `--include-archive` to include archives under the same filters. Scalar/ID/table/summary modes preserve population facts on stderr. Do not treat a page as complete.

## Quick Reference

| Need | Command |
|------|---------|
| Start session | `cleo session status` → `cleo briefing` |
| Find work | `cleo next` → `cleo focus <id>` |
| Search tasks | `cleo find "query"` |
| Complete task | `cleo verify T### --gate ... --evidence "..."` → `cleo complete T###` |
| Save memory | `cleo memory observe "..." --title "..."` |
| Spawn subagent | `cleo orchestrate spawn <taskId> --tier 2` |
| Create a Saga | `cleo saga create --title "..." --acceptance "..."` |
| Saga-level ready | `cleo orchestrate ready <sagaId>` |
| Saga-level waves | `cleo orchestrate waves <sagaId>` |
| Saga rollup | `cleo saga rollup <sagaId>` |
| List Saga members | `cleo saga members <sagaId>` |
| Attach doc to task | `cleo docs add T### file.md --type note --slug handle` |
| Read a doc | `cleo docs fetch <slug>` |
| Browse docs | `cleo docs list --task T###` |

## Acceptance input and historical evidence

Add, update, batch, and saga creation share one acceptance-input boundary. Pass
arrays of strings in JSON parameters; `--acceptance` also accepts a JSON array
string or the documented pipe-delimited form. Array entries keep literal pipes
and quoted unions. Strings are trimmed and blank strings omitted; nonstring
entries and malformed explicit JSON arrays reject the whole mutation. Bracketed
prose and the existing delimiter escaping rules retain their interpretation.

On update, an explicit `[]` (including an all-blank string array) requests a clear;
omitting acceptance leaves it unchanged. Policy and immutability checks apply to
normalized criteria, and a locked change still requires `--reason`. Fresh reads
retain an empty acceptance array. Malformed stored criteria produce a diagnostic;
valid historical strings and structured gates are preserved without normalization.
Do not infer historical splits from pipes alone: repairs need original input or
explicit provenance, a snapshot, and a guarded receipt.

## Read completeness before editing

Use `cleo show <id> --full` to inspect task fields before editing them. Compact
records name every omitted field in `_withheld`, including empty or null values;
the size is UTF-8 content bytes for strings and serialized JSON bytes otherwise.
Repeated projection retains earlier omissions. A record without `_withheld` is
complete at the record projection boundary; an envelope can separately report
omitted records or fields. Never overwrite a field because a compact read omitted it.

Coverage, failure diagnostics, authority corrections, and pending repair facts
survive budgeting before examples. If mandatory facts cannot fit, the operation
rejects the budget. Request a narrower scope or a larger budget, and do not treat
that failure as clean coverage or absent impact.

## Skill-Specific Extensions

- Task hierarchy, Saga commands, add-batch decomposition, docs policy, and CLI output details live in CLEO-INJECTION.md; emit `task-creation`, `documents`, and `pre-complete-gate` when needed.
- For add-batch input, The top-level JSON MUST be an array of task objects, not an object wrapper like `{ "tasks": [...] }`.
- Dry-run count semantics: `/data/count` and `/data/wouldCreate` predict writes; `/data/insertedCount` must be `0` for dry-run.
- Mutation output paths: use `/data/created/0`, `/data/updated/0`, and `/data/deleted/0`; never parse legacy full records.
- Docs path policy and strict preflight: keep docs repo-relative. Do not pass arbitrary external absolute paths. The canonical six-verb docs path is **add, update, fetch, list, remove, publish** (T10516). Use `cleo docs list` for discovery; `cleo docs list-types` (ADVANCED) and `DocKindRegistry` resolve runtime kinds when `list` is insufficient.

### Task Relationship Systems — depends, blockedBy, relates

CLEO has **three distinct relationship systems** with different storage, semantics, and CLI exposure. Do not conflate them.

| System | Storage | Semantics | CLI Exposure |
|--------|---------|-----------|--------------|
| `depends` | `task_dependencies` table (`task_id`, `depends_on`) | **Blocking dependency** — task cannot start until all `depends` tasks are `done` | `cleo add --depends T1,T2` / `cleo update --depends` / `--add-depends` / `--remove-depends` |
| `blockedBy` | `tasks.blocked_by` column (free-text) | **Human-readable reason** why a task is blocked (e.g. "waiting for API key") | `cleo update --blocked-by "reason"` / `--clear-blocked-by` |
| `relates` | `task_relations` table (`task_id`, `related_to`, `relation_type`, `reason`) | **Semantic, non-blocking** relationships: `blocks`, `related`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes` | `cleo relates add <from> <to> <type> <reason>` / `cleo relates remove` / `cleo relates list` |

#### Key distinction

- **`depends`** controls **execution order** (wave planning, `cleo next` eligibility). It is a hard dependency.
- **`blockedBy`** is a **status annotation** — it does NOT link to another task, it just explains why this task is `blocked`.
- **`relates`** is **informational linkage** — it does NOT block execution, but it records that two tasks have a semantic relationship (e.g. "T1001 supersedes T1002" or "T1003 duplicates T1004").

#### CRITICAL: Do NOT use `relates` for execution gates

`relates` is **never** a blocking dependency. If task B must wait for task A to finish, use `--depends`:

```bash
# CORRECT — execution dependency
cleo add "Implement auth" --depends T1001,T1002

# WRONG — relates does NOT block execution
cleo relates add T1003 T1001 blocks "waiting for auth"
```

#### Common pitfall: using `blockedBy` for task IDs

`--blocked-by` expects a **string reason**, not task IDs. To express "this task is blocked until that task finishes", use `--depends`:

```bash
# CORRECT
cleo add "Implement auth" --depends T1001

# WRONG — blocked-by is free text, not a task reference
cleo update T1003 --blocked-by T1001
```

#### `cleo relates` command reference

```bash
# Add a semantic relationship
cleo relates add T1001 T1002 supersedes "T1002 is absorbed into the new auth flow"

# List relations for a task
cleo relates list T1001

# Remove a relation
cleo relates remove T1001 T1002

# Suggest related tasks based on shared attributes
cleo relates suggest T1001 --threshold=50

# Discover related tasks using various methods
cleo relates discover T1001
```

Valid relation types: `blocks`, `related`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`.

#### Schema types mismatch note

The DB schema `TASK_RELATION_TYPES` (`related`, `blocks`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`) must match the runtime types. The CLI `cleo relates add` accepts the DB schema types. Always normalize to the DB enum before persisting.

## Task Hierarchy (PM-Core V2 — ADR-088)

**Canonical source:** `docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md`.
Legacy charter ADR-073 remains authoritative for pre-PM-Core V2 semantics; ADR-088
governs the PM-Core V2 target. The **T10638 migration removed** legacy
`task_relations.groups` hierarchy reads and the dual-shape `label='saga'` fallback —
containment is now read exclusively from `tasks.parent_id`.

| Tier    | Prefix | type value | Scope-of-change                                    |
|---------|--------|------------|----------------------------------------------------|
| Saga    | `SG-`  | `saga`     | Theme grouping ≥2 Epics across ≥2 releases         |
| Epic    | `E-`   | `epic`     | One releasable slice; ≥1 PR to `main`              |
| Task    | `T-`   | `task`     | One atomic PR-sized change; single wave            |
| Subtask | (none) | `subtask`  | One commit; ≤2 files; contributes to Task's PR     |

**Containment (I1):** `tasks.parent_id` is the **only** containment edge. Direct children,
ancestor/descendant traversal, closure rollups, and default parent completion are all derived
from `parent_id`. The parent matrix is:

| Child type | Parent type     |
|------------|-----------------|
| `subtask`  | `task`          |
| `task`     | `epic`          |
| `epic`     | `saga` or `null`|
| `saga`     | `null`          |

**Storage (I2):** All IDs stored as `T####`; `type` column discriminates tier (not `label`).
Prefixes (`SG-`, `E-`) are DISPLAY + import-mapping only.

**Non-containment (I3):** `task_relations` is for secondary graph semantics ONLY — dependency,
ordering, cross-reference, evidence, supersession, provenance. A `task_relations` row
MUST NOT satisfy containment, child listing, ancestor/descendant traversal, parent rollup,
parent completion, nesting-budget, or closure semantics. The `groups` relation type is
retired for hierarchy; do not use `task_relations.groups` for parent/child semantics.

## Typed Completion Criteria (PM-Core V2)

PM-Core V2 introduces **typed acceptance criteria** — `task_acceptance_criteria.kind`
is one of:

| Kind | Requires `target_task_id` | Purpose |
|------|--------------------------|---------|
| `text` | No | Human-authored acceptance criterion |
| `child_task` | **Yes** | Deterministic projection from a direct `parent_id` child |
| `evidence_bound` | No | Gate-backed criterion (`implemented`, `testsPassed`, `qaPassed`) |

**Key rules:**
- A parent with children uses `child_task` criteria by default; these are **deterministic
  projections** from `parent_id` containment (the T10639 child_task-projection backfill
  derives parent completion from child state — mixed-criteria mode is migration-only or
  explicit advanced scope).
- `text` and `evidence_bound` criteria must NOT use `target_task_id`.
- Cancelled children do NOT automatically satisfy parent completion; they require waiver
  or replacement evidence.
- Adding or reopening required child work under a done parent reopens affected ancestors.

## Saga Operations (PM-Core V2)

Saga-level orchestration is first-class. Saga membership uses `parent_id`
containment (NOT `task_relations.groups`). Use saga IDs directly with orchestrate commands:

```bash
# Saga-level ready frontier — parallel-safe tasks across all member epics
cleo orchestrate ready <sagaId>

# Saga-level dependency waves — unified wave plan across all member epics
cleo orchestrate waves <sagaId>

# Saga status rollup — completion %, member counts
cleo saga rollup <sagaId>

# Saga membership listing via parent_id containment
cleo saga members <sagaId>
```

**Epic-level fallback:** If saga-level orchestrate fails, enumerate member epics from
`cleo saga members <sagaId>` and call `cleo orchestrate ready <epicId>` for each member
individually. Do not use `task_relations.groups` as a fallback for hierarchy — it is
non-containment only per I3.

## WorkGraph (PM-Core V2 — T10632/T10633/T10634)

The WorkGraph subsystem provides scaffold validation (T10632), atomic application (T10633),
and planning document generation (T10634):

| Feature | What it does |
|---------|--------------|
| Scaffold Dry-Run Validator | Validates WorkGraph JSON payloads against schema invariants before mutation. Returns `wouldCreate`/`wouldUpdate`/`wouldDelete` without side effects. |
| Scaffold Apply Engine | Atomically applies validated WorkGraph scaffolds to the task database. Creates, updates, and deletes tasks/relations/ACs in a single transaction. Sibling-relation-based (SQLite trigger blocks parent-child relation edges). |
| Planning Doc Generator | `generatePlanningDoc()` produces structured markdown plans from the WorkGraph. Supports "agent" (compact) and "maintainer" (prose) output modes. |

Example — dry-run a scaffold before applying:
```bash
# Validate scaffold payload
cleo workgraph validate --file scaffold.json --dry-run

# Apply validated scaffold atomically
cleo workgraph apply --file scaffold.json
```

## Task Context (PM-Core V2 — T10629/T10630/T10631)

Bounded task context with token budgeting for agent ergonomics:

| Feature | What it does |
|---------|--------------|
| Task Context Pack | The `tasks.context` operation (T10629) backs `coreTaskContext` (T10630): it returns targeted task information (identity, acceptance criteria, blockers, attached docs, graph edges, recent activity) respecting a configurable token budget (default 1500). Uses `TasksContextOmission` to track overages and provides expansion hints. |
| Saga Context & Readiness | Saga-level aggregate rollups: completion percentages, ready-frontiers, and blocker enumeration across all member epics via `parent_id` containment. Grouped readiness report via `orchestrate.report` (T10631). |

The task-context **pack** is surfaced for agents via `cleo focus <taskId>` (compact, for
prompt injection) and `cleo orchestrate report <taskId>` (full grouped readiness). Do not
confuse this with `cleo context`, which is the separate context-WINDOW usage monitor
(`cleo context status` / `cleo context check`).

Example — get the task-context pack for agent use:
```bash
# Full grouped readiness report for a task
cleo orchestrate report <taskId>

# Compact context pack for prompt injection
cleo focus <taskId>
```

## BRAIN Decision-Store — Durable Architecture Decisions

Architectural decisions belong in the BRAIN decision-store, not in adrs markdown
blobs or agent-outputs ledgers. Use `cleo memory` commands to create, find, and
cite decisions by durable BRAIN decision IDs.

| Need | Command |
|------|---------|
| Store a decision | `cleo memory store --type decision --content "..." --title "..."` |
| Search decisions | `cleo memory decision-find --query <term>` |
| Find by type | `cleo memory find <term> --type decision` |
| Fetch full record | `cleo memory fetch <decisionId>` |
| List by epic | `cleo memory decision-find --epic <epicId>` |
| Check status | `cleo memory fetch <id>` → check `confirmation_state` field |

**Why BRAIN decisions over markdown ledgers:**
- Decisions are durable, queryable, and have source provenance (`source_table`, `source_rowid`)
- Decision IDs disambiguate overloaded D0xx/AGT-* identifiers via provenance tracking
- The decision-store supports lifecycle tracking (pending → accepted → superseded)
- Memory link pattern: cite a BRAIN decision ID in task descriptions, then `cleo memory fetch <id>` for full context

**Migration rule:** When you encounter a decision ONLY in a markdown ledger
(`.cleo/adrs/`, `.cleo/agent-outputs/`), store it in the BRAIN with
`cleo memory store --type decision` and cite the BRAIN ID going forward.

## Evidence must prove task criteria

Merged PRs and passing CI are provenance. Implementation requires changed artifacts related to the task; testing and review require their own actual results. For tasks with canonical criteria, append explicit links such as `satisfies:T1234#AC1` to each relevant gate's evidence. Fetch the PR merge commit so artifact hashes can be inspected. A changed criterion invalidates its recorded proof. Completing a child preserves an open parent whose own criteria remain unproven; child waivers never transfer to parent criteria.
