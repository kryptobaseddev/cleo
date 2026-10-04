---
name: ct-cleo
description: CLEO task management protocol - session, task, and workflow guidance. Use when managing tasks, sessions, or multi-agent workflows with the CLEO CLI protocol.
metadata:
  version: 2.24.5
  tier: core
  install: harness
  covers:
    - packages/cleo/src/cli/commands/session.ts
    - packages/cleo/src/cli/commands/focus.ts
    - packages/cleo/src/cli/commands/sticky.ts
  lastReviewed: 2026-10-04
  stability: stable
---

# CLEO Protocol Guide

## Trustworthy project knowledge

After confirming the assigned worktree, orient with briefing/focus. Check current
coverage and sourced authority before acting on retrieved guidance. `UNKNOWN`
impact is incomplete assessment; `NONE` is no detected impact in assessed static
coverage, never proof of no runtime callers. Resolve ambiguous symbols explicitly.
Preserve historical handoffs and follow sourced corrections separately.

Consume repair findings as a matrix of scope, evidence, responsibility, operation,
prerequisites, verification, and recovery. The calling agent supplies sourced resolutions; no background model is required. Escalate unresolved
owner decisions, reject stale proposals, verify postconditions, and record useful
incident learning with project/revision evidence. A failed diagnostic is not clean.
Provider reference delivery must be verified or embedded self-contained; static
instruction checks do not establish live Codex, Claude, or Kimi behavior.


## Asking the owner (HITL ask tool)

Whenever you need the owner to answer, decide, approve or choose ANYTHING, use the
ask tool (`AskUserQuestion` in Claude Code, or the provider equivalent listed in
CAAMP's `PROVIDER_ASK_TOOLS`) with concrete, detailed, selectable options. Never
ask inside a response, and never bury a question or decision in prose. Each option
states what happens and its trade-offs; put the recommended option first. Do not
send routine status chatter: report only when done or when a decision is needed.

- **Subagents never ask the human.** Return the question with its options to your
  orchestrator (`blocked` plus `{question, options[{label, description}], recommended}`
  in the manifest); the orchestrator asks via its ask tool.
- **No ask tool in the harness:** emit one LAFS `hitl.request` envelope
  `{question, options[{label, description}], recommended}` and stop.

## Project identity and moving between devices

A project is identified by its portable `project_id` in `.cleo/project.json`
(tracked, id write-once, plus its name; ADR-096; legacy mirror `.cleo/project-id`). A path is only a per-device hint, so a moved or
restored checkout keeps its identity. After a new device, restore or migration,
or when a known repo reports "Not inside a CLEO project", registry paths are
unreachable, or nexus hits `ENOENT` on an old path, run and report:

1. `cleo doctor projects` — machine-wide: moved, missing, split and temp rows with
   remedies. Dry-run by default; `--apply` rebinds only on nonce proof and writes a
   receipt; `--rollback <id>` restores.
2. `cleo doctor project-identity` — legacy, missing, conflicting or uncommitted id, name drift; `--resolve --dry-run` then `--resolve` is the only migration.
3. `cleo doctor --all-projects` — unreachable registered projects.
4. `cleo nexus projects clean --orphans --dry-run` — NEVER without `--dry-run`;
   it deletes rows for projects that merely moved.
5. `cleo doctor credentials` — credentials still keyed by an old path.
6. `cleo doctor global-delivery` — `~/.cleo`, the global hub reference and every
   harness CLEO skill install must resolve (a `~/.cleo` link carried by dotfiles from
   Linux dangles on macOS and silences all of them). `--repair` relinks with a receipt.

Never delete registry rows for projects that may have moved.

## Guarded knowledge repair

Use `cleo doctor knowledge --dry-run` to inspect findings and sourced proposals.
Persist reviewed JSON with `cleo doctor knowledge --prepare proposal.json --actor AGENT`.
Discover retained jobs with `--jobs --actor AGENT`; continue with `--limit` and returned
JSON `--cursor`. Follow each `inspectArgv`; never guess the latest job. Partial diagnostics
remain unresolved, and job status alone does not verify current effects.
For job operations, supply the original explicit actor and proposal ID:
`cleo doctor knowledge --apply JOB --actor AGENT --proposal-id PROPOSAL`;
replace `--apply` with `--inspect`, `--cancel`, or `--resume` for that operation.
Inspection returns original receipts, separate rollback corrections, diagnostic
failures, and a paged append-only ledger; use `--limit` and `--offset` until covered.
Never copy a stored actor merely to bypass `E_REPAIR_ACTOR`.

Each invocation shares one two-second default budget across assessment, preparation,
locks, application and verification (`--budget-ms` permits an explicit override).
A later explicit apply/resume starts a new bounded attempt; it does not renew an
expired attempt or bypass immutable resource checks. Synchronous SQLite is cooperative,
not timer-preemptible. On failure, retain any `prepared` job and `attemptFailure`
including pending finalization. Cancellation requests do not reverse committed effects.
Resume retains failed/cancelled outcomes and uncertain expired-running history;
live owners cannot be stolen and completed effects are not reapplied.
After rollback, apply/resume reject with `E_REPAIR_ROLLED_BACK`; inspect
`recoveryState` for the original historical receipt and separate rollback receipt.

Recover via `cleo doctor knowledge --rollback RECEIPT --actor AGENT --proposal-id NEW_ID`.
Inspect both receipts. Versioned quarantine recovery restores only `invalid_at`, preserving
validated paired citation-count/timestamp usage; protected edits conflict. Legacy receipts
require exact images. Recovery records actual before/after images, not byte restoration
of old usage. Prepared rollback still guards the full current image; later reads require
fresh preparation. Unrelated changes survive. Stale proposals need reassessment. `--resolve FILE`
applies reviewed input through the same lifecycle; `--fix --actor AGENT` handles bounded
confirmed stubs. `cleo doctor repair` retains its separate database-recovery semantics.

<!-- thin-pointer: full protocol is in CLEO-INJECTION.md (T9148) -->
The always-loaded core is `~/.cleo/templates/CLEO-INJECTION.md`; reference sections ship in the
package's `CLEO-REFERENCE.md` (T12580). Emit any section with: `cleo briefing inject --section <name>`

Core: `session-start` · `work-loop` · `triggers` · `session-commands` · `output-contract`
· `error-handling` · `pre-complete-gate` · `rules` · `escalation`. On demand: `task-creation`
· `task-discovery` · `task-relationships` · `memory` · `memory-jit` · `data-location` · `nexus`
· `orchestration` · `playbooks` · `documents` · `human-render` · `spawn-tiers` · `evidence`
· `projection` · `knowledge-repair`

Task find defaults to lexical query terms. Fuzzy character-subsequence matching requires `--fuzzy`; inspect per-row `match.kind` and `match.fields` before inferring related work. `--in` restricts the source field. Matching mode and fuzzy field explanations survive scalar/human output on stderr. Semantic retrieval remains separately identified.

Compact SDK list/find records also carry `_withheld`: omission names and original UTF-8 sizes are recorded before fields are discarded, then retained through later CLI projections. Use full records to inspect those values; absence is not emptiness.

List/find expose `data.population` with matched and returned counts, truncation, pagination, and archive eligibility. Count output equals emitted rows; use `--all` or `--limit 0` to enumerate all matches, and `--include-archive` to include archives under the same filters. Scalar/ID/table/summary modes preserve population facts on stderr. Do not treat a page as complete.

Use `cleo backup inspect <snapshot> --record-id <id>` for read-only historical evidence; scoped absence or unknown provenance is not recovery authority.

Code-graph answers (`cleo nexus impact`, `context`, `full-context`, `why`, `search-code`, `task-symbols`, `clusters`, `flows`) carry `meta._nexus.freshness`: stale file count and sample, whether the queried symbol's own file is stale, and the refresh command with an estimated cost. A query refreshes up to 25 stale files inline within a 60 s budget (`nexus.autoRefresh.maxFiles`/`budgetMs`/`enabled`) and discloses it in `freshness.autoRefresh`; beyond that it answers from the stale index with `W_NEXUS_INDEX_STALE`. `unknown` freshness is never fresh. `cleo nexus analyze` re-parses only changed files, re-resolves every file, and reports `mode`, `reason` and per-phase cost; it falls back to a full parse (and says why) when there is no parse cache, the extractor build changed, or over 30% of files changed. `--full` forces a rebuild.

## Sessions are terminal-bound (T12500)

`cleo session start` binds the calling agent process (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, …), pane (`TMUX_PANE`, …), tab (`TERM_SESSION_ID`, …), CI job (`GITHUB_RUN_ID`+`GITHUB_RUN_ATTEMPT`+`GITHUB_JOB`, `CI_JOB_ID`) or ssh login tty (`SSH_TTY`+`SSH_CONNECTION`).
With no provider key it also walks the process tree (T12864): a known single-agent harness (Kimi, aider, amp, cursor-agent, … — past its per-call `bash -c` shells) or an interactive / script shell becomes the identity, so `session start` then `cleo start` in separate `bash -c` calls share one session; a harness below a human's tab / pane, an ssh login or a CI job gets its own, more specific key, so it must run `cleo session start` itself.
Any other host (a node / python orchestrator, an IDE extension host, a daemon, anything under pid 1) identifies nobody and keeps the single-session guard: multi-agent hosts and multi-step scripts must set `CLEO_SESSION_ID` (or `CLEO_AGENT_ID`, only in a long-lived host process: under a short-lived one such as `make` the key changes per call) per agent.
Session mutations from an unbound caller fail with `E_SESSION_UNBOUND` instead of
guessing the newest session; bind with `cleo session start`, `cleo session resume
<id>` or `CLEO_SESSION_ID=<id>`, or name the target with `--session <id>`. Separate one-shot `ssh host 'cleo …'` calls are separate callers: export `CLEO_SESSION_ID` there.
Unattributed mutations warn on stderr; `session status` / `briefing` label a guessed session `unbound: true`.

- A session a human started in a tab is adopted by Claude Code in that tab
  (also after a Claude restart). An adopter works in it but cannot end it without
  `--session <id>`, and starting its own session never takes over the tab. A
  session Claude started can be ended from the tab.
- Two Claude instances that each start a session stay isolated; a sibling tmux
  pane never sees another pane's session.
- Agent-tool subagents inherit the parent's `CLAUDE_CODE_SESSION_ID` and act in
  the parent's session; `cleo orchestrate spawn` gives workers their own.

## Typed decisions (`cleo decide`, T12491)

`decide` answers typed questions (yes/no, choice, score) through a swappable Jev-wire provider and falls back to local heuristics when unconfigured or failing. Pick a provider and supply its key: `printf %s "$KEY" | cleo decide config --provider layahost --key-stdin` (layahost, the default, needs only the key and uses model `laya-auto`); a custom endpoint is `--provider jev --url <u>`. `--model` overrides the model and `--clear` removes the settings. On a terminal, `cleo decide config` with no flags runs a setup wizard that reads the key hidden. The key is kept in a 0600 file and never printed. `cleo decide status` probes reachability and `cleo decide ask --state <text> --noul <q>` runs one debug question.

## Quick Reference

| Need | Command |
|------|---------|
| Start session | `cleo session status` → `cleo briefing` |
| End session (from another terminal) | `cleo session end --session <id>` |
| Find work | `cleo next` → `cleo focus <id>` |
| Search tasks | `cleo find "query"` |
| Complete task | `cleo verify T### --gate ... --evidence "..."` → `cleo complete T###` |
| Run typed gates without recording | `cleo verify T### --run` |
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

## Document projection outcomes

`cleo docs add` preserves accepted canonical bytes when optional graph or sourced
observation work fails. Read `data.projection` for captured project identity,
coverage, diagnostics, deadline, and any durable job or verification receipt.
`pending` can mean a write outcome is still unresolved; retain the job reference
and inspect it before explicit resume. Repeating the add is not a recovery step.
The original two-second maintenance budget covers preparation through verification;
timer expiry does not preempt synchronous SQLite work.

Verify storage with `cleo docs fetch <slug>` and its JSON `data.bytesBase64` plus
`data.metadata.sha256`. Keep canonical storage success, optional projection
verification, and installed-provider workflow verification as separate evidence.

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

## Task controls and committed evidence

Explicit `critical` priority on add/update requires a dependency or a nonempty
`--depends-waiver`; updates check the resulting dependency set. CLI flags, JSON
params, and SDK calls share this policy. Explicit severity changes use the
project's signing identity: a nonempty `ownerPubkeys` allowlist restricts signers;
an absent or empty list keeps the existing opt-in policy. Unreadable or malformed
authority is an explicit configuration failure. Committed severity,
duplicate-bypass, and dependency-waiver evidence lives in the task transaction
audit. Historical filesystem attestations alone do not prove a task committed.
Dry-run creates no committed attestation; failed writes leave no committed receipt.

## Read completeness before editing

Use `cleo show <id> --full` to inspect task fields before editing them. Compact
records name every omitted field in `_withheld`, including empty or null values;
the size is UTF-8 content bytes for strings and serialized JSON bytes otherwise. A `list/*/field` key (`acRows/*/id`) names a field omitted from every element, summed.
Repeated projection retains earlier omissions. A record without `_withheld` is
complete at the record projection boundary; an envelope can separately report
omitted records or fields. Never overwrite a field because a compact read omitted it.

Coverage, failure diagnostics, authority corrections, and pending repair facts
survive budgeting before examples. Read operations reject budgets too small for
mandatory facts; request a narrower scope or a larger budget. Internal mutation
budgets that cannot hold the minimum envelope reject before execution. If a
successful mutation's actual receipt exceeds a viable budget, success and the
complete receipt are preserved with `_budgetEnforcement.withinBudget: false`.
Inspect the receipt before retrying; overflow is not rollback or clean coverage.
This internal budget contract does not add a `--token-budget` flag to add/update.

## Skill-Specific Extensions

### Reference files

| File | Load it when you |
|------|------------------|
| `references/session-protocol.md` | start, resume or end sessions; pick skills |
| `references/orchestrator-constraints.md` | spawn subagents from an orchestrator |
| `references/loom-lifecycle.md` | move an epic through the LOOM stages |
| `references/anti-patterns.md` | check a plan against known mistakes |
| `references/memory.md` | recall or record BRAIN memory (progressive disclosure) |
| `references/sticky-notes.md` | capture a thought before it is a task: `cleo sticky jot "..."`, then `cleo sticky convert <id> --to-task` |

- Task hierarchy, Saga commands, add-batch decomposition, docs policy, and evidence detail live in the on-demand reference; emit `task-creation`, `documents`, and `evidence` when needed.
- For add-batch input, The top-level JSON MUST be an array of task objects, not an object wrapper like `{ "tasks": [...] }`.
- Dry-run count semantics: `/data/count` and `/data/wouldCreate` predict writes; `/data/insertedCount` must be `0` for dry-run.
- Mutation output paths: use `/data/created/0`, `/data/updated/0`, and `/data/deleted/0`; never parse legacy full records. `--output id` emits affected IDs once in created/updated/deleted order from these canonical arrays.
- `cleo delete <id>` soft-archives the task. `--cascade` explicitly archives descendants; `--force` alone orphans and preserves children and permits dependents. Parents with children require one of these controls. Read `deleted[]` (or `--output id`) for all archived IDs, including cascade descendants.
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
# Validate scaffold payload (read-only)
cleo workgraph validate scaffold.json

# Preview, then apply the validated scaffold atomically
cleo workgraph apply scaffold.json --dry-run
cleo workgraph apply scaffold.json
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
| Store a decision | `cleo memory decision-store --decision "..." --rationale "..."` |
| Search decisions | `cleo memory decision-find --query <term>` |
| Find by type | `cleo memory find <term> --type decision` |
| Fetch full record | `cleo memory fetch <decisionId>` |
| Find by epic | `cleo memory decision-find "<epicId>"` (no epic filter — query text, then verify `source_table`/`source_rowid`) |
| Check status | `cleo memory fetch <id>` → check `confirmation_state` field |

**Why BRAIN decisions over markdown ledgers:**
- Decisions are durable, queryable, and have source provenance (`source_table`, `source_rowid`)
- Decision IDs disambiguate overloaded D0xx/AGT-* identifiers via provenance tracking
- The decision-store supports lifecycle tracking (pending → accepted → superseded)
- Memory link pattern: cite a BRAIN decision ID in task descriptions, then `cleo memory fetch <id>` for full context

**Migration rule:** When you encounter a decision ONLY in a markdown ledger
(`.cleo/adrs/`, `.cleo/agent-outputs/`), store it in the BRAIN with
`cleo memory decision-store --decision "..." --rationale "..."` and cite the
BRAIN ID going forward.

## Evidence must prove task criteria

Merged PRs and passing CI are provenance. Implementation requires changed artifacts related to the task; testing and review require their own actual results (`ci:<pr>` once the PR merged and the project sets `evidence.ciSatisfies`; else `tool:test-affected` when `testing.affectedCommand` is configured, otherwise a targeted `test-run:<json>` or `tool:test`; plan with `cleo done <id> --plan`, never run the suite by hand and again via `tool:test`). For tasks with canonical criteria, append explicit links such as `satisfies:T1234#AC1` to each relevant gate's evidence. Fetch the PR merge commit so artifact hashes can be inspected. A changed criterion invalidates its recorded proof. Completing a child preserves an open parent whose own criteria remain unproven; child waivers never transfer to parent criteria.
