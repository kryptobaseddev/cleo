# CLEO Protocol — on-demand reference

Version: 2.24.4 | Companion to the always-loaded `CLEO-INJECTION.md` core

Not injected into agent context. Print one section with `cleo briefing inject --section <name>`; tier-2 spawn prompts embed this whole file. Section names are the `CLEO-INJECTION:section` markers below.

<!-- CLEO-INJECTION:section=knowledge-repair -->
## Knowledge repair

`cleo doctor knowledge --dry-run`, then `--prepare FILE --actor AGENT`. Discover retained work with `--jobs --actor AGENT`, `--limit` and returned JSON `--cursor`; follow exact `inspectArgv`, not latest-job guesses. Retain partial diagnostics. Use `--apply JOB`, `--inspect JOB`, `--cancel JOB`, or `--resume JOB` with the original explicit `--actor AGENT --proposal-id PROPOSAL`; never borrow stored actor attribution. Verify receipts and paged lifecycle evidence (`--limit`/`--offset`); retain diagnostic failures and `prepared`/`attemptFailure` recovery details. Cancellation is a request, not rollback. Each invocation shares a default 2000ms budget (`--budget-ms`); a later explicit attempt is fresh, without renewing an active deadline or preempting synchronous SQLite. Resume preserves prior outcomes and uncertain expired attempts; live owners remain fenced. Stale source requires reassessment. After rollback, apply/resume return `E_REPAIR_ROLLED_BACK` with original and rollback receipts in `recoveryState`, not current repaired effects. Use `--rollback RECEIPT --actor AGENT --proposal-id NEW_ID`; inspect both receipts. Versioned quarantine recovery restores only `invalid_at`, preserving validated paired citation usage; protected edits conflict. Legacy receipts require exact images. Prepared rollback still guards the full current image. `cleo doctor repair` remains database recovery.
<!-- /CLEO-INJECTION:section=knowledge-repair -->

<!-- CLEO-INJECTION:section=projection -->
## Projections, budgets and mutation receipts

Projection markers include omitted empty/null fields and survive repeated projection. `_withheld` maps omitted fields to UTF-8 content bytes (JSON bytes for structured values). A `list/*/field` key (e.g. `acRows/*/id` on `cleo show`) names a field omitted from every element of that list, with the summed size. A record without `_withheld` is complete. Budgeting preserves coverage, diagnostic failures, authority corrections and pending repair facts before examples. A read budget too small for mandatory facts fails explicitly; request narrower scope or more budget. Never treat this failure as clean coverage.

An impossible internal mutation budget rejects before execution. If a successful mutation's actual receipt exceeds a viable budget, its success and complete receipt remain available with `_budgetEnforcement.withinBudget: false`; overflow does not mean rollback. Inspect the receipt before retrying a mutation.

Output detail (ADR-086): `--output count` counts the returned rows, agreeing with IDs/table. `data.population` separates matched/returned counts and archive scope; scalar modes disclose these facts on stderr. `--field` resolves projected `description`/`acceptance`/`verification` without `--full`. `--output id` emits affected IDs once in created/updated/deleted order; `--full` restores full records. Delete receipts retain every affected ID, including cascaded children. Rejected output parsing: `cleo show … | tail -1 | jq …`, `cleo list … | jq -r '.data.tasks[].id'`, `cleo add 'X' 2>&1 | grep -oE 'T[0-9]+'`.
<!-- /CLEO-INJECTION:section=projection -->

<!-- CLEO-INJECTION:section=task-creation -->
## Task Creation (ADR-066)

`--acceptance` required for ALL tasks. `cleo bug`/`--role` removed — use `cleo add --kind bug --severity Px --acceptance "..."`. Axes: `--type {epic|task|subtask}`, `--kind {work|research|experiment|bug|spike|release}`, `--severity {P0-P3}` (orthogonal to `--priority`; triggers Ed25519 attestation).

| Goal | Command |
|------|---------|
| Create a single task | `cleo add --type task --parent <epicId> --title "..." --acceptance "..."` |
| Create N tasks atomically | `cleo add-batch --file tasks.json --parent <epicId>` (file is a top-level JSON array of task objects) |
| Preview batch before inserting | `cleo add-batch --file tasks.json --parent <epicId> --dry-run` |
| Batch from stdin | `echo '[...]' \| cleo add-batch --file - --parent <epicId>` |

Acceptance input normalizes identically across add, update, batch and saga creation: string arrays in JSON parameters; for `--acceptance`, a JSON-array string or the documented pipe-delimited form. Array entries preserve literal pipes and quoted unions. Strings are trimmed and blank strings omitted; nonstring entries or malformed explicit JSON arrays reject the whole mutation. An explicit `[]` on update requests a clear; omitted acceptance stays unchanged. Normalized criteria still obey policy and immutability, including `--reason` for locked changes. Invalid stored criteria are diagnostic failures; never split historical records without original-input provenance and a guarded repair receipt.

Explicit `critical` priority on add/update requires a dependency or a nonempty `--depends-waiver`; updates check the resulting dependency set. CLI flags, JSON params, and SDK calls share this policy. Explicit severity changes use the project's signing identity: a nonempty `ownerPubkeys` allowlist restricts signers; an absent or empty list keeps the existing opt-in policy. Unreadable or malformed authority is an explicit configuration failure. Committed severity, duplicate-bypass, and dependency-waiver evidence lives in the task transaction audit. Historical filesystem attestations alone do not prove a task committed. Dry-run creates no committed attestation; failed writes leave no committed receipt.

`cleo add-batch` inserts all tasks in a single transaction — ANY failure rolls back ALL inserts. Use `--dry-run` first; the projected mutation envelope reports `/data/count` and `/data/wouldCreate` as the predicted create count while `/data/insertedCount` remains `0`. See `ct-cleo` skill section "Decomposing an epic into N tasks" for the JSON schema and rollback semantic.

### Sagas — PM-Core V2 containment (ADR-088 supersedes ADR-073)

A **Saga** (`SG-`) is a multi-release theme grouping multiple Epics. `type='saga'` is canonical (PM-Core V2). Member Epics link via `tasks.parent_id` containment.

| Goal | Command |
|------|---------|
| Create a Saga | `cleo saga create --title "..." --description "..." --acceptance "ac1\|ac2\|ac3\|ac4\|ac5"` |
| Link an Epic to a Saga | `cleo saga add <sagaId> <epicId>` |
| List all Sagas | `cleo saga list` |
| List member Epics of a Saga | `cleo saga members <sagaId>` |
| Aggregate status across members | `cleo saga rollup <sagaId>` |

Parent matrix: Saga `parent_id IS NULL`; Epic `parent_id` = Saga (or null for standalone); Task `parent_id` = Epic; Subtask `parent_id` = Task. `task_relations` (incl. `groups`) is non-containment only — dependencies, ordering, cross-reference, evidence, supersession, provenance.

### Depth + decomposition

`saga 0 → epic 1 → task 2 → subtask 3`; `hierarchy.maxDepth` (default 3) is the max depth VALUE, **inclusive**, so a subtask under a task is legal. `E_CLEO_DEPTH_EXCEEDED` now means only: you parented under a subtask, the leaf tier. `--type` is honoured verbatim — so `--type subtask --parent <epic>` is REFUSED, not silently retyped. A task is **either** a leaf with its own text ACs **or** a container with children, never both (PM-Core V2 design-point 3) — so the first `cleo add` under a task carrying `--acceptance` text is refused, as expected. Convert it:

| Goal | Command |
|------|---------|
| Add the subtask AND convert in one call | `cleo add --type subtask --parent <id> --title "..." --acceptance "..." --auto-decompose` |
| Convert first, then add normally | `cleo decompose <id>` (`--dry-run`, `--child-title "..."`) |

`--auto-decompose` is opt-in: it rewrites the PARENT and reports `autoDecomposed: { childId, movedAcceptance }` — read it, the task you filed is now a container. `cleo update <id> --acceptance ""` does NOT work (enforcement rejects empty).
<!-- /CLEO-INJECTION:section=task-creation -->

<!-- CLEO-INJECTION:section=task-discovery -->
### Overlap reconciliation across a saga

`cleo add` checks duplicates only at insert, so partial overlap and later drift go unseen. Sweep for it:

| Goal | Command |
|------|---------|
| Report overlapping scope (read-only) | `cleo reconcile scope <sagaId\|epicId>` |
| Narrow to strongest signals | `cleo reconcile scope <id> --threshold 0.75` |
| Write the proposed `relates` edges | `cleo reconcile scope <id> --apply` |

Actions: **merge** (same tier+parent, ≥90%) · **absorb** (≥90% across containers) · **split** (shared scope apart — use `cleo decompose`) · **link** (siblings, usually intended sequencing). `--apply` writes ONLY `relates` edges (nothing merged, retitled, reparented or deleted; the earlier task survives). Shared naming inflates `link` similarity; act on `merge`/`absorb`.

## Task Discovery

Task search defaults to lexical. For approximate character-subsequence matches, use `cleo find "query" --fuzzy`. Check `match.kind`, `match.fields`, and reason before inferring related work or duplicates. Compact output retains fuzzy provenance; scalar/human output explains it on stderr. `--in title|description|notes|id` restricts fields. Semantic retrieval is separately identified.

Compact SDK list/find `_withheld` retains omitted names and original UTF-8 sizes through later CLI projections. Fetch full records; absence is not emptiness.

List/find default to excluding archived rows; `--include-archive` applies the same filters to archives. Inspect `data.population` before inferring completeness; `truncated: true` includes nonzero offsets. Budgets cannot silently remove population facts or their rows.

**Use `cleo focus` to orient on a task. Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo focus <id>` | ≤ 1 500 | **Primary orient surface** — identity + scope + blockers + ready wave + docs + brain context in ONE call |
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id> --full` | 300-600 | Full record beyond focus; bare show withholds fields (`_withheld`) |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |
<!-- /CLEO-INJECTION:section=task-discovery -->

<!-- CLEO-INJECTION:section=task-relationships -->
## Task Relationships — depends, blockedBy, relates

| System | Semantics | CLI |
|--------|-----------|-----|
| `depends` | **Blocking execution dependency** — task cannot start until all `depends` tasks are `done` | `cleo add --depends T1,T2` / `cleo update --depends ...` |
| `blockedBy` | **Free-text reason** why a task is blocked (e.g. "waiting for API key") | `cleo update --blocked-by "reason"` / `--clear-blocked-by` |
| `relates` | **Semantic, non-blocking** linkage (`blocks`, `related`, `duplicates`, `absorbs`, `fixes`, `extends`, `supersedes`) | `cleo relates add <from> <to> <type> <reason>` |

**Rule:** `relates` never blocks; `blocked-by` takes a reason, not a task ID. Details: `ct-cleo` → "Task Relationship Systems".

**Ranking inputs (D11161):** agents may change `priority`, `severity`, `kind` and `depends` directly. Every change records actor, session, reason and before/after. Say why with `cleo update <id> --priority high --reason "<why>"`. `cleo history ranking <id>` shows who changed what; `cleo history revert <entryId>` undoes one change.
<!-- /CLEO-INJECTION:section=task-relationships -->

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

Memory context: `cleo memory digest` defaults to a live project summary; no `--brief` flag. Set `brain.memoryBridge.mode = "file"` for legacy `@.cleo/memory-bridge.md` injection.
<!-- /CLEO-INJECTION:section=memory -->

<!-- CLEO-INJECTION:section=memory-jit -->
## Memory Protocol (JIT)

| Need | Command |
|------|---------|
| Prior decisions | `cleo memory find "<topic>" --type decision` |
| Known patterns | `cleo memory find "<domain>" --type pattern` |
| Timeline context | `cleo memory timeline <id>` |
| Code context | `cleo nexus context <symbol>` |
| Impact analysis | `cleo nexus impact <symbol>` |

### Decision Lookup (prefer BRAIN decision-store over inline ledgers)

Store architectural decisions in BRAIN (`.cleo/brain.db` → `brain_decisions`), not Markdown ledgers; cite durable IDs.

**Primary lookup — always try first:**
1. `cleo memory decision-find --query <term>` — keyword search of decision records
2. `cleo memory find <term> --type decision` — broader, decision-scoped
3. `cleo memory fetch <id>` — full record

**Decision IDs (D0xx, AGT-*) are NOT globally unique.** Verify BRAIN `source_table`/`source_rowid` when citing; documents can reuse IDs.

**Historical fallback:** `cleo docs list` and `cleo docs fetch <slug>`. Preserve provenance; do not promote historical text over sourced current guidance.

Check pending/accepted/superseded status. `decision-find` has **no epic filter**: use query text (`cleo memory decision-find "<epicId>"`).

Budget: 3 JIT calls per task phase. More = task is underspecified.
<!-- /CLEO-INJECTION:section=memory-jit -->

<!-- CLEO-INJECTION:section=data-location -->
## Where the data lives — never read `.cleo/*.db` directly

Store = **`.cleo/cleo.db`**; task rows are in PREFIXED tables (`tasks_tasks`, …). Three decoys make a HEALTHY project look corrupt:

| Decoy | Reality |
|-------|---------|
| `.cleo/tasks.db`, small + months old | The pre-migration store, left under the old live name |
| `.cleo/backups/sqlite/tasks-<ts>.db`, ~100× bigger | Snapshots **of `cleo.db`**; `tasks-` is a legacy label |
| bare `tasks` table, 0 rows | Empty relic beside the populated `tasks_tasks` |

Small legacy DBs beside large snapshots do not prove corruption. `cleo doctor superseded-store` identifies the live store by row counts; `briefing`/`focus` already read it. Use `cleo backup inspect <snapshot> --record-id <id>` for read-only historical evidence; scoped absence or unknown provenance is not recovery authority.
<!-- /CLEO-INJECTION:section=data-location -->

<!-- CLEO-INJECTION:section=nexus -->
## Nexus — when to use which scope

`cleo nexus` queries this repo's symbol graph.

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
| Refresh the index | `cleo nexus analyze` |

**FIRST CALL IS `cleo nexus status`.** Check `nodeCount`, `lastIndexedAt`, `staleFileCount`/`fileCount`. Queries report `_nexus.freshness` and auto-refresh ≤25 stale files; beyond that they warn `W_NEXUS_INDEX_STALE`. `analyze` is incremental (`--full` rebuilds). For stale coverage, refresh or inspect source with `git grep` and disclose that basis. Impact/context `E_NOT_FOUND` includes index size, median age and a repair command; inspect these first.

**Project resolution**: `--project-id` > `--path` > `cwd`.
Identity is the portable `project_id` (`.cleo/project.json`, legacy `.cleo/project-id`); a path is a per-device hint.

**Rule**: BEFORE editing any symbol, run `cleo nexus impact <symbol>`.
HIGH/CRITICAL requires reviewing affected callers before editing. For stale, partial, missing, or failed coverage, inspect source and report the remaining uncertainty. An empty footprint alone never establishes `NONE`.
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

`cleo orchestrate spawn` provisions a Git worktree at `<cleoHome>/worktrees/<projectHash>/<taskId>/`. Its required `## Worktree Setup (REQUIRED)` section names the path, branch and `FIRST ACTION: cd '<path>'`. Confine reads/writes/Git operations there. Integrate with `git merge --no-ff` to preserve commit SHAs and authors (ADR-062). Use `--no-worktree` for meta-tasks.

## Playbook Domain

`.cantbook` YAML encodes staged agent flows (deterministic state machine, HMAC-signed HITL resume tokens; ADR-053).

| Goal | Command |
|------|---------|
| Execute a `.cantbook` playbook | `cleo playbook run <name>` |
| Inspect run state | `cleo playbook status <runId>` |
| Resume after HITL approval | `cleo playbook resume <runId>` |

Starters (`@cleocode/playbooks`): `rcasd`, `ivtr`, `release`.
<!-- /CLEO-INJECTION:section=playbooks -->

<!-- CLEO-INJECTION:section=documents -->
## Documents & Attachments

| Goal | Command |
|------|---------|
| Attach file/url to task | `cleo docs add <taskId> <repo-relative-file> --type <kind> --slug <slug>` or `--url <url>` |
| List task attachments | `cleo docs list --task <id>` |
| List valid doc kinds | `cleo docs list-types` |
| Generate llms.txt summary | `cleo docs generate --for <taskId>` |

Use current repo-relative paths, never arbitrary external absolute paths (`/tmp`, other checkouts). Publish: `cleo docs publish --for <ownerId> --to <repo-relative-path>`. Runtime kinds: `cleo docs list-types` / `DocKindRegistry`, not stale lists. Document storage success is separate from optional projection verification. Read `data.projection` after `cleo docs add`: retain coverage, diagnostics, captured project identity, deadline, and any job/receipt reference. Pending work can have an unresolved committed outcome; inspect it before explicit resume, never repeat the add blindly. One two-second maintenance budget covers preparation through verification; timer expiry does not preempt synchronous SQLite. Verify exact bytes with `cleo docs fetch <slug>` JSON `data.bytesBase64` and `data.metadata.sha256`; rendered content can add a newline.
<!-- /CLEO-INJECTION:section=documents -->

<!-- CLEO-INJECTION:section=human-render -->
## Human Render Contract (ADR-077)
Typed `RenderableEnvelope<T>` from `@cleocode/contracts`. `envelope.data.kind` ∈ `tree | table | list | grouped-list | section | single | generic` — agents route on `kind`. Register with `registerRenderer(command, kind, fn)` (`packages/core/src/render/`). Commands: `cleo show T<id>` (typed), `cleo show T<id> --human` (force), `cleo tree T<id>` (generic walk of parent + `groups` edges).
<!-- /CLEO-INJECTION:section=human-render -->

<!-- CLEO-INJECTION:section=spawn-tiers -->
## Spawn Prompt Contents (what subagents receive)

`cleo orchestrate spawn <taskId>` embeds a resolved prompt. Tier 2 is self-contained; tiers 0-1 carry the core and point subagents at `cleo briefing inject --section <name>` for reference sections. Content tiers:

| Tier | Contents |
|------|----------|
| `0` | Task identity · file paths · session linkage · stage guidance · evidence gates · quality gates · return format · protocol pointer |
| `1` | tier 0 + **CLEO-INJECTION.md core embed** (on-demand sections by `cleo briefing inject --section <name>`) — **default** |
| `2` | tier 1 + this reference embedded in full + **ct-cleo** + **ct-orchestrator** skill excerpts + **SUBAGENT-PROTOCOL-BLOCK** + anti-patterns |

`cleo orchestrate spawn T1234 --tier 0|1|2`: tier 0 for quick workers, tier 2 for autonomous ones.

Before dispatch, assert these required sections: `## Task Identity` · `## File Paths (absolute — do not guess)` · `## Session Linkage` · `## Stage-Specific Guidance` · `## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)` · `## Quality Gates` · `## Return Format Contract (MANDATORY)`.
<!-- /CLEO-INJECTION:section=spawn-tiers -->

<!-- CLEO-INJECTION:section=evidence -->
## Evidence reference (ADR-051 · ADR-061)

A merged PR and green CI provide provenance. For `implemented`, pair `pr:<number>` with `files:<changed-paths>`; CLEO checks task linkage, complete changed-file coverage, and the actual merge commit's bytes. Documentation and research tasks may use appropriate documentary artifacts. The receipt retains criterion hashes, artifact paths, and result references. A valid child completion leaves any parent with unproven criteria open.

| Exit | Code | Fix |
|:----:|------|-----|
| — | `E_EVIDENCE_TESTS_FAILED` | Fix failing tests before re-verifying with `tool:test-affected`, a targeted `test-run:<json>`, or `ci:<pr>` once merged |
| — | `E_EVIDENCE_INVALID_DECISION` | `decision:<id>` atom — decision ID not found or not accepted/proposed in BRAIN |
| — | `E_EVIDENCE_GIT_ROOT` | The CLEO root is not a git checkout — a LAYOUT fact, not a failing atom. One child repo, or a `commit:` SHA that exists in exactly one child, resolves automatically. Otherwise declare it: `"evidence": { "gitRoot": "<subdir>" }` in `.cleo/project-context.json`, or `CLEO_EVIDENCE_GIT_ROOT=<repo>` for one invocation |
| — | `E_FLAG_REMOVED` | `cleo complete --force` removed per ADR-051. Use `--evidence` or `CLEO_OWNER_OVERRIDE=1` |

### Typed acceptance gates — observe before you attest

Typed gates (`cleo req add <id> --gate '<json>'`) EXECUTE during any `cleo verify … --gate … --evidence …` write on a task that carries them. To run them without recording anything:

```bash
cleo verify T### --run          # executes typed gates, records no verification, caches passes
```

`--run` records no verification and cannot be combined with `--gate`/`--all`/`--reset`. Passes are cached (HMAC-sealed per machine) by gate + HEAD + dirty tree + inputs, so the next write reuses them, marked `source: cache` on the result and receipt; add `--no-run` to forbid execution. `evidence.allowCachedGates: false` in `.cleo/project-context.json` disables reuse. A `test` gate with `minCount` needs its OWN command to emit a machine-readable report (`--reporter=json` for vitest, `--json` for jest); an exit code carries no count, and a report file from a separate invocation is not bound to this run — record that as `test-run:<path>` evidence instead.

### Emergency override (audited)

```bash
CLEO_OWNER_OVERRIDE=1 \ CLEO_OWNER_OVERRIDE_REASON="incident 1234 hotfix" \ cleo verify T### --gate cleanupDone --evidence "note:owner-approved"
```

All overrides append a line to `.cleo/audit/force-bypass.jsonl`. Use sparingly.

### Tool resolution + result cache (ADR-061)

`tool:<name>` resolves through `.cleo/project-context.json`, then the project's `package.json` script of that name (`<pm> run <name>`), then `primaryType` fallbacks (references-only tsconfig → `tsc -b`, which emits). A script that writes files (an auto-fixing `lint`) edits the checkout and later fails `E_EVIDENCE_STALE`; keep verification scripts read-only. Cache `.cleo/cache/evidence/<key>.json`, keyed on the command `(canonical, cmd, args)` and the tree content under test: identical tree content shares one result across worktrees and commits, and a repeat verify on an unchanged tree never re-runs. After a failure the previously failing test files re-run first, and a failure that passes on its single rerun is recorded as `flaky`. Parallel verifies coalesce; cross-worktree semaphores: `~/.local/share/cleo/locks/tool-<canonical>/`, limit `CLEO_TOOL_CONCURRENCY_<TOOL>=<n>`. Deadlines: **1800000 ms (30 min) for `test` and `build`**, otherwise 300000 ms (5 min). Positive-integer override: `CLEO_TOOL_TIMEOUT_<TOOL>=<ms>`; invalid values explicitly fail with the tool default. Timeouts cache nothing; increase the deadline before an unchanged retry (gh#1221). `cleo verify --fresh` (or `CLEO_EVIDENCE_FRESH=1`) bypasses the cache for one call.

### Test evidence without churn (T12957)

The evidence run is the one run. Start with `cleo done <id> --plan`, which picks affected → ci → full and shows each tool's cache state. When the PR has merged and the project sets `evidence.ciSatisfies`, record `testsPassed`/`qaPassed` with `ci:<pr>` and run nothing locally. Otherwise, when `testing.affectedCommand` is configured, use `tool:test-affected` (packages the diff touches plus dependents); a full `tool:test` is then only for changes to root config, which affected planning refuses. Without it, use a targeted `test-run:<json>` of the test files you changed, or `tool:test`. While iterating, run only the failing or changed test files; never run the suite by hand and then again through `tool:test`. On macOS heavy `test`/`build` runs take one machine-wide slot by default (`CLEO_TOOL_CONCURRENCY_TEST=<n>` raises it).

### `pr:<number>` retroactive atom (T9764)

`pr:` proves merge provenance, not completion. CLEO checks actual `mergeCommit`, task linkage and changed files; incomplete inventories or unavailable merge artifacts remain unverified. Fetch the merge commit before `files:` evidence. Task `files` must intersect its diff; prose mentions cannot establish scope. Explicit research/spike and documentation scope retain documentary evidence.

A task PR merged into an integration branch is a component: `pr:<component>@<integration>` (and `ci:<component>@<integration>`) takes the merge commit and CI from the integration PR that landed it, and the task linkage and changed files from the component PR — only its files that survive the integration merge, never the whole integration diff (T12671). `cleo done` derives this from either PR number. A file a later change also edited still counts while the component's own hunks apply to the landed version. A component that only deleted files implements with `pr:<component>@<integration>;note:<deleted paths>`, because a deletion has no bytes for `files:`.

### `ci:<number>` merge-commit CI atom (D11149 · T12742)

With `evidence.ciSatisfies: true`, `ci:<number>` attests `testsPassed`/`qaPassed` from the required checks (`evidence.ciChecks`) green on the merged PR's merge commit, or on a final PR head whose tree equals it. When a concurrency group CANCELLED (or skipped) the merge commit's own push run, a later default-branch commit's green `push` run may stand in (T12742). That run proves the DESCENDANT's tree, not the merge tree, so it counts only when all of these hold: no merge-commit run or job failed; the PR's final head has a green latest `pull_request` run for every stood-in check; the commit descends from the merge commit and is one of the first 10 first-parent commits within 7 days; NO commit between them, merge commits included, touched the PR's changed files, a pinned workflow file or `.github/actions`; and it is the first candidate with a decisive verdict. A red first decisive candidate refuses, and a pending one refuses with "wait for <sha>"; only cancelled, skipped or never-started runs move on. The atom records `descendantSha`, `descendantRange` and `descendantPrHeadSha`, and `cleo complete` re-fetches both runs' latest attempts, because a re-run can turn a completed check red.

Required checks: explicit configuration or target repository protection. `release.prRequiredWorkflows: []` requires no checks; it proves neither testing nor review. `.cleo/cache/evidence/pr-<num>.json` retains provenance and changed files; obsolete versions reject. Use `tool:test-affected` (full `tool:test` only for root-config changes) or a targeted `test-run:<json>` plus appropriate QA tools, linking each result to verified criteria.
<!-- /CLEO-INJECTION:section=evidence -->
