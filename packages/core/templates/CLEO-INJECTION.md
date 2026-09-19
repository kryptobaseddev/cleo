# CLEO Protocol

Version: 2.17.0 | CLI-only dispatch | `cleo <command> [args]`

<!-- CLEO-INJECTION:section=session-start -->
## Universal protocol

1. **Orient.** Confirm the assigned project/worktree, then run `cleo briefing` and
   `cleo focus <id>`. Follow explicit user scope and provider safety instructions.
   Read relevant repository instructions before editing. A failed briefing is a
   diagnostic, not evidence that the project has no history.
2. **Check authority and coverage.** Distinguish current evidence, historical
   guidance, conflicting claims, and missing knowledge. Fetch cited records and
   their sourced successors. Recency or similarity alone does not establish authority.
3. **Inspect evidence.** Before editing, inspect impact and its coverage. `UNKNOWN`
   means assessment is incomplete; `NONE` means no impact detected in the assessed
   graph. Static analysis cannot prove all runtime callers. Resolve ambiguous
   symbols using qualified candidate identifiers and verify against source.
4. **Act.** Use the repair matrix: scope, evidence, repair class, proposed operation,
   prerequisites, verification, and recovery. Automatic repairs must be bounded and
   reversible. The calling agent supplies sourced resolutions for ambiguous findings;
   owner decisions stay explicit. No background LLM is required for repair.
5. **Verify.** Run relevant checks, record validated evidence, then complete. Report
   unresolved and failed findings and missing coverage rather than claiming success.
6. **Learn.** Record actionable incident knowledge with source, project, revision,
   observation, correction, and verification through `cleo memory observe`. Preserve
   historical handoffs; present corrections separately. Avoid empty completion traces.

Use `cleo <command> --help` and the `ct-cleo` skill for command details.
Use `cleo show <id> --full` when focus is insufficient: the default projection
withholds description and verification, listing them in `_withheld`.

Projection markers include omitted empty/null fields and survive repeated projection.
`_withheld` maps omitted fields to UTF-8 content bytes (JSON bytes for structured
values). A record without `_withheld` is complete. Budgeting preserves coverage,
diagnostic failures, authority corrections and pending repair facts before examples.
A read budget too small for mandatory facts fails explicitly; request narrower scope
or more budget. Never treat this failure as clean coverage.

An impossible internal mutation budget rejects before execution. If a successful
mutation's actual receipt exceeds a viable budget, its success and complete receipt
remain available with `_budgetEnforcement.withinBudget: false`; overflow does not
mean rollback. Inspect the receipt before retrying a mutation.

<!-- /CLEO-INJECTION:section=session-start -->

<!-- CLEO-INJECTION:section=work-loop -->
## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo focus {id}` → orient: identity + blockers + ready wave + docs + brain context (1 call ≤ 1 500 tokens)
3. Check authority, coverage, and source evidence; do the work
4. Record verification evidence, then `cleo complete {id}` → mark done
5. `cleo next` → continue or end session
<!-- /CLEO-INJECTION:section=work-loop -->

<!-- CLEO-INJECTION:section=triggers -->
## Triggers (when to call what)

| Signal | Action |
|--------|--------|
| Epic with ≥ 5 child tasks just created | Run `cleo orchestrate start <epicId>` before touching any child |
| You just ran `cleo complete <id>` for a non-trivial task | Run `cleo memory observe "..." --title "..."` with what you learned |
| Task acceptance criterion contains "test" | Propose an `AcceptanceGate` with `kind:"test"` via `cleo req add` |
| Session token budget ≈ 80% consumed | Run `cleo session end --note "..."` and hand off |
| Multiple related tasks ready in parallel | Run `cleo orchestrate ready <epicId>` for the wave set |
| About to call `cleo complete` | First: check gates via `cleo show <id> --full` → run tests → then complete |
| Writing a canonical doc (spec/adr/research/handoff/note/llm-readme) | Use `cleo docs add --type <kind> --slug <kebab-handle>` — NEVER raw fs write to `.cleo/adrs/`, `.cleo/research/`, `.cleo/agent-outputs/`, or `docs/` |
| Reading an ADR/spec/research note/handoff | `cleo docs fetch <slug>` — never grep the filesystem for canonical docs |
<!-- /CLEO-INJECTION:section=triggers -->

<!-- CLEO-INJECTION:section=task-creation -->
## Task Creation (ADR-066)

`--acceptance` required for ALL tasks. `cleo bug`/`--role` removed — use `cleo add --kind bug --severity Px --acceptance "..."`. Axes: `--type {epic|task|subtask}`, `--kind {work|research|experiment|bug|spike|release}`, `--severity {P0-P3}` (orthogonal to `--priority`; triggers Ed25519 attestation).

| Goal | Command |
|------|---------|
| Create a single task | `cleo add --type task --parent <epicId> --title "..." --acceptance "..."` |
| Create N tasks atomically | `cleo add-batch --file tasks.json --parent <epicId>` (file is a top-level JSON array of task objects) |
| Preview batch before inserting | `cleo add-batch --file tasks.json --parent <epicId> --dry-run` |
| Batch from stdin | `echo '[...]' \| cleo add-batch --file - --parent <epicId>` |

Acceptance input is normalized consistently across add, update, batch, and saga
creation: use arrays of strings in JSON parameters, or a JSON-array string / the
documented pipe-delimited form for `--acceptance`. Array entries preserve literal
pipes and quoted unions. Strings are trimmed and blank strings omitted; nonstring
entries or malformed explicit JSON arrays reject the whole mutation. An explicit
`[]` on update requests a clear; omitted acceptance stays unchanged. Normalized
criteria still obey policy and immutability, including `--reason` for locked
changes. Invalid stored criteria are diagnostic failures; never split historical
records without original-input provenance and a guarded repair receipt.

Explicit `critical` priority on add/update requires a dependency or a nonempty
`--depends-waiver`; updates check the resulting dependency set. CLI flags, JSON
params, and SDK calls share this policy. Explicit severity changes use the
project's signing identity: a nonempty `ownerPubkeys` allowlist restricts signers;
an absent or empty list keeps the existing opt-in policy. Unreadable or malformed
authority is an explicit configuration failure. Committed severity,
duplicate-bypass, and dependency-waiver evidence lives in the task transaction
audit. Historical filesystem attestations alone do not prove a task committed.
Dry-run creates no committed attestation; failed writes leave no committed receipt.

`cleo add-batch` inserts all tasks in a single transaction — ANY failure rolls back ALL inserts.
Use `--dry-run` first; the projected mutation envelope reports `/data/count` and
`/data/wouldCreate` as the predicted create count while `/data/insertedCount` remains `0`.
See `ct-cleo` skill section "Decomposing an epic into N tasks" for the JSON schema and rollback semantic.

### Sagas — PM-Core V2 containment (ADR-088 supersedes ADR-073)

A **Saga** (`SG-`) is a multi-release theme grouping multiple Epics. `type='saga'` is canonical (PM-Core V2). Member Epics link via `tasks.parent_id` containment; `task_relations.groups` is non-containment provenance only.

| Goal | Command |
|------|---------|
| Create a Saga | `cleo saga create --title "..." --description "..." --acceptance "ac1\|ac2\|ac3\|ac4\|ac5"` |
| Link an Epic to a Saga | `cleo saga add <sagaId> <epicId>` |
| List all Sagas | `cleo saga list` |
| List member Epics of a Saga | `cleo saga members <sagaId>` |
| Aggregate status across members | `cleo saga rollup <sagaId>` |

Parent matrix: Saga `parent_id IS NULL`; Epic `parent_id` = Saga (or null for standalone);
Task `parent_id` = Epic; Subtask `parent_id` = Task. `task_relations` is non-containment
only — dependencies, ordering, cross-reference, evidence, supersession, provenance.
<!-- /CLEO-INJECTION:section=task-creation -->

<!-- CLEO-INJECTION:section=task-discovery -->
## Task Discovery

Task search is lexical by default. Use `cleo find "query" --fuzzy` only when approximate character-subsequence matches are wanted. Check each result's `match.kind`, `match.fields`, and reason before treating it as related work or duplicate evidence. Fuzzy provenance survives compact output; scalar/human modes explain it on stderr. `--in title|description|notes|id` restricts the searched field. Semantic retrieval is a separate, explicitly identified capability.

Compact SDK list/find records also carry `_withheld`: omission names and original UTF-8 sizes are recorded before fields are discarded, then retained through later CLI projections. Use full records to inspect those values; absence is not emptiness.

List/find default to excluding archived rows; `--include-archive` applies the same filters to archives. Inspect `data.population` before inferring completeness; `truncated: true` includes nonzero offsets. Budgets cannot silently remove population facts or their rows.

**Use `cleo focus` to orient on a task. Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo focus <id>` | ≤ 1 500 | **Primary orient surface** — identity + scope + blockers + ready wave + docs + brain context in ONE call |
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id> --full` | 300-600 | Full record when focus is insufficient. Bare show withholds description + verification; inspect `_withheld` before interpreting absence. |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |
<!-- /CLEO-INJECTION:section=task-discovery -->

<!-- CLEO-INJECTION:section=task-relationships -->
## Task Relationships — depends, blockedBy, relates

Keep these three relationship systems distinct:

| System | Semantics | CLI |
|--------|-----------|-----|
| `depends` | **Blocking execution dependency** — task cannot start until all `depends` tasks are `done` | `cleo add --depends T1,T2` / `cleo update --depends ...` |
| `blockedBy` | **Free-text reason** why a task is blocked (e.g. "waiting for API key") | `cleo update --blocked-by "reason"` / `--clear-blocked-by` |
| `relates` | **Semantic, non-blocking** linkage (`blocks`, `related`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`) | `cleo relates add <from> <to> <type> <reason>` |

**Rule:** `relates` never blocks execution; use `--depends` to wait for tasks. `blocked-by` takes a reason, not a task ID. Details: `ct-cleo` → "Task Relationship Systems".
<!-- /CLEO-INJECTION:section=task-relationships -->

<!-- CLEO-INJECTION:section=session-commands -->
## Session Commands

| Goal | Command |
|------|---------|
| Check session | `cleo session status` |
| Resume context | `cleo briefing` |
| Start session | `cleo session start --scope global --name "<what you are doing>"` (both flags are REQUIRED) |
| End session | `cleo session end --note "..."` |
<!-- /CLEO-INJECTION:section=session-commands -->

<!-- CLEO-INJECTION:section=memory -->
## Memory (BRAIN)

3-layer retrieval — search first, then fetch:

| Step | Command | ~Tokens |
|------|---------|---------|
| Search | `cleo memory find "query"` | 50/hit |
| Context | `cleo memory timeline <id>` | 200-500 |
| Details | `cleo memory fetch <id>` | 500/entry |
| Save | `cleo memory observe "text" --title "title"` | — |
| LLM status | `cleo memory llm-status` | 50 |
| Ground-truth promote | `cleo memory verify <id>` (owner only) | 50 |

Memory context: `cleo memory digest` gives a live project memory summary (this is the default mode; there is no `--brief` flag). Legacy file mode: set `brain.memoryBridge.mode = "file"` in config to restore `@.cleo/memory-bridge.md` injection.
<!-- /CLEO-INJECTION:section=memory -->

<!-- CLEO-INJECTION:section=data-location -->
## Where the data lives — never read `.cleo/*.db` directly

Store = **`.cleo/cleo.db`**; task rows are in PREFIXED tables (`tasks_tasks`, …).
Three decoys make a HEALTHY project look corrupt:

| Decoy | Reality |
|-------|---------|
| `.cleo/tasks.db`, small + months old | The pre-migration store, left under the old live name |
| `.cleo/backups/sqlite/tasks-<ts>.db`, ~100× bigger | Snapshots **of `cleo.db`**; `tasks-` is a legacy label |
| bare `tasks` table, 0 rows | Empty relic beside the populated `tasks_tasks` |

Small legacy DBs beside large snapshots do not prove corruption. `cleo doctor superseded-store` identifies the live store by row counts; `briefing`/`focus` already read it.
<!-- /CLEO-INJECTION:section=data-location -->

<!-- CLEO-INJECTION:section=nexus -->
## Nexus — when to use which scope

`cleo nexus` is the code-intelligence surface over THIS repo's symbol graph.
Pick by intent. Every command below is verified to exist — see the gate note.

| Intent | Command |
| --- | --- |
| **Check the index before trusting it** | `cleo nexus status` |
| Blast radius before editing a symbol | `cleo nexus impact <symbol>` |
| Callers / callees / community of a symbol | `cleo nexus context <symbol>` |
| Everything about one symbol in one call | `cleo nexus full-context <symbol>` |
| Find a symbol by code text | `cleo nexus search-code "<text>"` |
| Symbols touched by a task | `cleo nexus task-symbols <taskId>` |
| Why does this symbol exist / who needs it | `cleo nexus why <symbol>` |
| Detected communities / execution flows | `cleo nexus clusters` / `flows` |
| Rebuild the index | `cleo nexus analyze` |

**FIRST CALL IS `cleo nexus status`.** Inspect `nodeCount`, `lastIndexedAt`, and `staleFileCount`. The index is NOT auto-refreshed; post-index symbols are absent and may return `E_NOT_FOUND`. If many files are stale relative to `fileCount`, run `cleo nexus analyze` or inspect source with `git grep` and disclose that basis. Impact/context `E_NOT_FOUND` includes index size, median entry age and a repair command; inspect these before diagnosing Nexus failure.

**Project resolution**: `--project-id` > `--path` > `cwd`.
Default ID = `base64url(path).slice(0,32)`.

**Rule**: BEFORE editing any symbol, run `cleo nexus impact <symbol>`.
HIGH/CRITICAL requires reviewing affected callers before editing. For stale, partial,
missing, or failed coverage, inspect source and report the remaining uncertainty.
An empty footprint alone never establishes `NONE`.

> `scripts/lint-injection-commands.mjs` (T12069) checks these commands against the CLI. Previously documented `nexus report`, `nexus brain find`, `nexus compare`, `nexus shared`, `nexus synthesize`, and `nexus admin` never existed.
<!-- /CLEO-INJECTION:section=nexus -->

<!-- CLEO-INJECTION:section=orchestration -->
## Orchestration (for epics ≥ 5 tasks)

| Goal | Command |
|------|---------|
| Initialize epic pipeline | `cleo orchestrate start <epicId>` (auto-inits LOOM research stage) |
| Get parallel-safe wave | `cleo orchestrate ready <epicId>` |
| Get spawn prompt for a task | `cleo orchestrate spawn <taskId>` |
| Spawn without worktree (opt-out) | `cleo orchestrate spawn <taskId> --no-worktree` |
| Multi-agent IVTR loop | `cleo orchestrate ivtr <taskId> --start` |
| View epic wave plan | `cleo orchestrate waves <epicId>` |
| Grant HITL approval (paused playbook) | `cleo orchestrate approve <resumeToken>` |
| Deny HITL approval with reason | `cleo orchestrate reject <resumeToken> --reason "<r>"` |
| List awaiting HITL approvals | `cleo orchestrate pending` |
<!-- /CLEO-INJECTION:section=orchestration -->

<!-- CLEO-INJECTION:section=playbooks -->
## Worktree-by-Default (T1140 · ADR-055)

`cleo orchestrate spawn` provisions a Git worktree at `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/`. Its required `## Worktree Setup (REQUIRED)` section names the path, branch and `FIRST ACTION: cd <path>`. Confine reads/writes/Git operations there. Integrate with `git merge --no-ff` to preserve commit SHAs and authors (ADR-062). Use `--no-worktree` for meta-tasks.

## Playbook Domain (v2026.4.93 · T910 Orchestration Coherence v4)

`.cantbook` playbooks encode multi-stage agent flows (research → spec → impl → review, release with HITL gate, etc.) as YAML. The playbook runtime is a deterministic state machine with HMAC-signed resume tokens for HITL gates — see `docs/architecture/orchestration-flow.md` (6-layer pipeline) and `.cleo/adrs/ADR-053-playbook-runtime.md` (state-machine decision).

| Goal | Command |
|------|---------|
| Execute a `.cantbook` playbook | `cleo playbook run <name>` |
| Inspect run state | `cleo playbook status <runId>` |
| Resume after HITL approval | `cleo playbook resume <runId>` |

Starter playbooks ship with `@cleocode/playbooks`: `rcasd.cantbook`, `ivtr.cantbook`, `release.cantbook`.
<!-- /CLEO-INJECTION:section=playbooks -->

<!-- CLEO-INJECTION:section=documents -->
## Documents & Attachments

| Goal | Command |
|------|---------|
| Attach file/url to task | `cleo docs add <taskId> <repo-relative-file> --type <kind> --slug <slug>` or `--url <url>` |
| List task attachments | `cleo docs list --task <id>` |
| List valid doc kinds | `cleo docs list-types` |
| Generate llms.txt summary | `cleo docs generate --for <taskId>` |

Use repo-relative paths within the current repo/worktree, never arbitrary absolute paths from `/tmp` or another checkout. Publish tracked copies with `cleo docs publish --for <ownerId> --to <repo-relative-path>`. Before batch writes, run `cleo add-batch --dry-run` and check `/data/insertedCount` = 0. `cleo docs list-types` and `DocKindRegistry` define runtime kinds; prefer them over stale lists.
<!-- /CLEO-INJECTION:section=documents -->
<!-- CLEO-INJECTION:section=human-render -->
## Human Render Contract (ADR-077)
Typed `RenderableEnvelope<T>` from `@cleocode/contracts`. `envelope.data.kind` ∈ `tree | table | list | grouped-list | section | single | generic` — agents route on `kind`. Render logic in `packages/core/src/render/`, primitives in `packages/animations/render/`, icon enums in `@cleocode/contracts/render/icon.ts`. Families self-register via `registerRenderer(command, kind, fn)`. Commands: `cleo show T<id>` (typed), `cleo show T<id> --human` (force), `cleo tree T<id>` (generic walk of parent + `groups` edges).
<!-- /CLEO-INJECTION:section=human-render -->

<!-- CLEO-INJECTION:section=output-contract -->
## CLI Output Contract (ADR-086)

`cleo` stdout = ONE LAFS envelope per call (single JSON object + `\n`). All logs/progress → stderr. NEVER pipe through `tail`/`jq`/`python` — use flags.

| Need | Flag | Example |
|------|------|---------|
| Scalar extract | `--field <jsonpointer>` | mutate: `id=$(cleo add 'X' --acceptance "..." --field /data/created/0)` · read: `st=$(cleo show T123 --field /data/task/status)` |
| ID-only pipeline | `--output id` | `cleo list --parent EPIC --output id --limit 0 \| while read c; do …; done` — **`--limit 0` means EVERY match on BOTH `list` and `find`** (gh#1302, fixed). Without it, list returns a page of 10 and find a page of 20. `--output count` counts the returned rows, agreeing with IDs/table. `data.population` separates matched/returned counts and archive scope; scalar modes disclose these facts on stderr. |
| Returned/affected count | `--output count` | `cleo list --parent EPIC --status pending --output count` |
| TSV (no header) | `--output table` | `cleo list --parent EPIC --output table` |
| Silent (exit-code only) | `--output silent` | `cleo update T123 --status done --output silent` |
| 1-line per record | `--summary` | `cleo list --parent EPIC --summary` |
| Suppress stderr | `--quiet` | `cleo add-batch --file f.json --parent T1 --quiet --output id` |
| Force full record | `--full` | `cleo show T123 --full` |

**READ and MUTATE envelopes NEST DIFFERENTLY.** Mutation records are FLAT; reads nest them: `cleo show` uses `/data/task/status`, NEVER `/data/status`. `--field` resolves projected `description`/`acceptance`/`verification` without `--full`. Unresolvable pointers fail with `E_FIELD_NOT_FOUND` and valid pointers; use those instead of guessing. `cleo verify` returns the full `verification` object, so no confirmation read is needed; its MUTATE pointer is `/data/verification`, never `/data/task/...` (gh#1420).

Mutations (`add`, `add-batch`, `update`, `complete`, `delete`) return `{count, created[], updated[], deleted[], ids[]}` (T9931). Use `/data/created/0` for create/add-batch, `/data/updated/0` for update/complete, `/data/deleted/0` for delete, `/data/count` for counts. `--output id` emits affected IDs once in created/updated/deleted order. `ids[]` is a deprecated alias; `--full` restores full records. Deletion is a soft archive: `cleo delete <id> --cascade` includes descendants; `--force` alone orphans children and permits dependents. Without either, parents with children are rejected. Receipts retain every affected ID, including cascaded children. Rejected output parsing: `cleo show … | tail -1 | jq …`, `cleo list … | jq -r '.data.tasks[].id'`, `cleo add 'X' 2>&1 | grep -oE 'T[0-9]+'`.
<!-- /CLEO-INJECTION:section=output-contract -->

<!-- CLEO-INJECTION:section=error-handling -->
## Error Handling

Check exit code (`0` = success) and `"success"` in JSON output after every command.

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | `cleo find` to verify ID |
| 6 | `E_VALIDATION` | Check field lengths |
| 10 | `E_PARENT_NOT_FOUND` | `cleo exists <id>` |
| 80 | `E_LIFECYCLE_GATE_FAILED` | Parent epic not in implementation stage yet — advance with `cleo lifecycle complete` (now auto-syncs `tasks.pipelineStage`) |
| 83 | `E_IVTR_INCOMPLETE` | IVTR loop not released — run `cleo orchestrate ivtr <id> --next` |
| — | `E_EVIDENCE_MISSING` | `cleo verify … --evidence <atoms>` — see "Pre-Complete Gate Ritual" |
| — | `E_EVIDENCE_INSUFFICIENT` | Add missing atom kind for the gate (e.g. `commit:<sha>` + `files:<list>` for `implemented`) |
| — | `E_EVIDENCE_TESTS_FAILED` | Fix failing tests before re-verifying with `tool:pnpm-test` or `test-run:<json>` |
| — | `E_EVIDENCE_TOOL_FAILED` | Tool (biome/tsc/…) exited non-zero; fix source and re-run |
| — | `E_EVIDENCE_STALE` | Files/commits changed since `verify`; re-verify with updated evidence |
| — | `E_EVIDENCE_INVALID_DECISION` | `decision:<id>` atom — decision ID not found or not accepted/proposed in BRAIN |
| — | `E_FLAG_REMOVED` | `cleo complete --force` removed per ADR-051. Use `--evidence` or `CLEO_OWNER_OVERRIDE=1` |
| — | `E_IDEMPOTENCY_UNSUPPORTED` | That verb ignores `--idempotency-key`; the key was NOT applied. Query before retrying |
| 143 / 137 | *(killed — no code)* | **A killed write carries NO information about whether it committed** |

### A killed write is not a failed write

A 143/137 exit or missing output does not establish whether a write committed; teardown may hang after commit. **Never retry a killed mutation blindly.** Read `cleo show <id> --full`: a HIT proves presence even while the writer hangs; a MISS proves nothing until it exits. For discovery use `cleo find "<title>" --include-archive --all` or `cleo list --parent <id> --limit 0`; default find hides archives and list shows only 10 rows with new children last. `add`/`add-batch`/`update`/`docs add`/`memory observe`/`relates add` reject `--idempotency-key`; it cannot make their retries safe.

<!-- /CLEO-INJECTION:section=error-handling -->

<!-- CLEO-INJECTION:section=pre-complete-gate -->
## Pre-Complete Gate Ritual (ADR-051 — evidence required)

MANDATORY before every `cleo complete <id>`. Every gate write MUST be backed by programmatic evidence that CLEO validates against git, the filesystem, or the toolchain. `cleo verify --all` alone is REJECTED with `E_EVIDENCE_MISSING`.

### 1. Capture evidence for each gate

Every gate takes `cleo verify T### --gate <gate> --evidence "<atoms>"`:

| gate | evidence that satisfies it |
|------|----------------------------|
| `implemented` | `commit:<sha>;files:path/a.ts,path/b.ts` — or `decision:<id>` for decision-only tasks |
| `testsPassed` | `tool:test` (canonical) or `test-run:<json>` |
| `qaPassed` | `tool:lint;tool:typecheck` |
| `documented` | `files:docs/spec.md` |
| `securityPassed` | `tool:security-scan` |
| `cleanupDone` | `note:removed dead branches` |

A merged PR and green CI provide provenance. For `implemented`, pair `pr:<number>` with `files:<changed-paths>`; CLEO checks task linkage, complete changed-file coverage, and the actual merge commit's bytes. Documentation-only PRs cannot implement a code-fix task. Documentation and research tasks may use appropriate documentary artifacts.

When a task has canonical acceptance criteria, name the criteria proved by each implementation, test, or review result using existing syntax such as `satisfies:T1234#AC1`. Example: `cleo verify T1234 --gate implemented --evidence "pr:42;files:src/fix.ts;satisfies:T1234#AC1"`. Record `testsPassed` and `qaPassed` separately with actual verification results and explicit criterion links. The receipt retains criterion hashes, artifact paths, and result references; changed criteria require fresh evidence. A valid child completion leaves any parent with unproven criteria open, and a child waiver does not waive parent criteria.

### 2. Then complete

```bash
cleo complete T###
```

On complete, CLEO re-validates every hard atom (commit reachable, file sha256 match, test-run hash match). Tampering → `E_EVIDENCE_STALE`, re-verify required.

### 3. Record learnings

```bash
cleo memory observe "..." --title "..."
```

### Emergency override (audited)

```bash
CLEO_OWNER_OVERRIDE=1 \
CLEO_OWNER_OVERRIDE_REASON="incident 1234 hotfix" \
  cleo verify T### --gate cleanupDone --evidence "note:owner-approved"
```

All overrides append a line to `.cleo/audit/force-bypass.jsonl`. Use sparingly.

### Tool resolution + result cache (ADR-061)

`tool:<name>` resolves via `.cleo/project-context.json` and per-`primaryType` fallbacks. Cache: `.cleo/cache/evidence/<key>.json`, keyed by `(canonical, cmd, args, HEAD, dirty-tree fingerprint)`. Parallel verifies coalesce; cross-worktree runs use per-tool semaphores at `~/.local/share/cleo/locks/tool-<canonical>/`, tuned by `CLEO_TOOL_CONCURRENCY_<TOOL>=<n>`. Deadlines: **1800000 ms (30 min) for `test` and `build`**, 300000 ms (5 min) otherwise. Override with positive-integer `CLEO_TOOL_TIMEOUT_<TOOL>=<ms>`; invalid values fail explicitly with that tool's default. Timeouts cache nothing: increase an insufficient deadline before retrying the unchanged tool (gh#1221).

### `pr:<number>` retroactive atom (T9764)

`pr:` records merge provenance, not task completion by itself. CLEO verifies actual `mergeCommit` identity, task relationship and changed files; incomplete file inventories or unavailable merge artifacts remain unverified. Fetch the actual merge commit before recording its `files:` evidence. Task `files` declarations must intersect the PR diff; prose path mentions do not establish scope. Explicit research/spike work and declared documentation scope retain documentary evidence paths.

Required check names come from explicit configuration or the target repository's protection rules. An explicit `release.prRequiredWorkflows: []` declares that no checks are required; it does not prove testing or review. Cache under `.cleo/cache/evidence/pr-<num>.json` stores merge provenance and changed-file inventory; obsolete cache versions are rejected. Use `tool:test` or `test-run:<json>` for testing and appropriate QA tools for review, each linked to the criteria it actually verifies.

### Anti-patterns to avoid

- ❌ Calling `cleo complete` without verifying tests actually ran
- ❌ `cleo verify --all` without `--evidence` (REJECTED post-ADR-051)
- ❌ `cleo complete --force` (REMOVED post-ADR-051)
- ❌ Skipping `cleo memory observe` on non-trivial tasks
- ❌ Self-attesting without programmatic proof
- ❌ Modifying files after `cleo verify` but before `cleo complete` (caught by staleness check)
<!-- /CLEO-INJECTION:section=pre-complete-gate -->

<!-- CLEO-INJECTION:section=spawn-tiers -->
## Spawn Prompt Contents (what subagents receive) — T882 / v2.6.0

`cleo orchestrate spawn <taskId>` returns a fully-resolved, self-contained prompt. Subagents never re-resolve protocol content; everything required is embedded. Three tiers control content depth:

| Tier | Contents |
|------|----------|
| `0` | Task identity · file paths · session linkage · stage guidance · evidence gates · quality gates · return format · protocol pointer |
| `1` | tier 0 + full **CLEO-INJECTION.md embed** (this document) — **default** |
| `2` | tier 1 + **ct-cleo** + **ct-orchestrator** skill excerpts + **SUBAGENT-PROTOCOL-BLOCK** + anti-patterns |

Invoke with `cleo orchestrate spawn T1234 --tier 0|1|2` — tier 0 for quick workers, tier 2 for autonomous ones; omitting `--tier` gives tier 1.

Every spawn prompt contains these required sections, so an orchestrator can programmatically assert their presence before dispatching: `## Task Identity` · `## File Paths (absolute — do not guess)` · `## Session Linkage` · `## Stage-Specific Guidance` · `## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)` · `## Quality Gates` · `## Return Format Contract (MANDATORY)`.
<!-- /CLEO-INJECTION:section=spawn-tiers -->

<!-- CLEO-INJECTION:section=rules -->
## Rules

- No time estimates — use `small`, `medium`, `large` sizing
- Token budget: avoid `cleo list` without `--parent`; get usage from `cleo <command> --help` (there is no top-level help command)
- Do not read full task details for tasks you won't work on
<!-- /CLEO-INJECTION:section=rules -->

<!-- CLEO-INJECTION:section=memory-jit -->
## Memory Protocol (JIT)

Pull context on demand — don't pre-load everything:

| Need | Command |
|------|---------|
| Prior decisions | `cleo memory find "<topic>" --type decision` |
| Known patterns | `cleo memory find "<domain>" --type pattern` |
| Timeline context | `cleo memory timeline <id>` |
| Full details | `cleo memory fetch <id>` |
| Code context | `cleo nexus context <symbol>` |
| Impact analysis | `cleo nexus impact <symbol>` |

### Decision Lookup (prefer BRAIN decision-store over inline ledgers)

Architectural decisions belong in BRAIN (`.cleo/brain.db` → `brain_decisions`), not ADR or agent-output markdown ledgers. Query durable decision IDs with `cleo memory decision-find` and use them in citations.

**Primary lookup — always try first:**
1. `cleo memory decision-find --query <term>` — search BRAIN decision records by keyword
2. `cleo memory find <term> --type decision` — broader memory search scoped to decisions
3. `cleo memory fetch <id>` — retrieve full decision record by ID

**Decision IDs (D0xx, AGT-*) are NOT globally unique** — same ID can mean different things across documents. BRAIN decisions include source provenance (`source_table`, `source_rowid`) that disambiguates. Always verify the source when citing a decision ID.

**Historical fallback:** use `cleo docs list` and `cleo docs fetch <slug>` to inspect canonical documents. Preserve their provenance and do not promote historical text over sourced current guidance.

Check outcome status (pending/accepted/superseded). `decision-find` has **no epic filter** — it searches by QUERY text only, so scope it with the epic id as the query (`cleo memory decision-find "<epicId>"`) and read `source_table`/`source_rowid` to confirm provenance.

Budget: 3 JIT calls per task phase. More = task is underspecified.
<!-- /CLEO-INJECTION:section=memory-jit -->

<!-- CLEO-INJECTION:section=escalation -->
## Escalation

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
<!-- /CLEO-INJECTION:section=escalation -->
