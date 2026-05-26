# CLEO Protocol

Version: 2.6.0 | CLI-only dispatch | `cleo <command> [args]`

<!-- CLEO-INJECTION:section=session-start -->
## MANDATORY: Run `cleo briefing` BEFORE Any Other Tool

**HARD PROHIBITION**: BEFORE any tool use other than `cleo briefing`, the orchestrator
MUST run `cleo briefing` first.

Do NOT read `.cleo/agent-outputs/*.md`, `NEXT-SESSION-HANDOFF.md`,
`HONEST-HANDOFF-*.md`, or ANY markdown file as a substitute for `cleo briefing`.
These files are deprecated, go stale, and have historically caused orchestrators to
act on false information. They contain redirect stubs — not state.

The ONLY canonical sources of session state are:
- `cleo briefing` — structured handoff + next tasks + BRAIN context
- `cleo focus <id>` — **primary orient surface** — single call replacing 8: identity, scope, blockers, ready wave, docs, git activity, brain context (≤ 1 500 tokens)
- `cleo memory find "<query>"` — BRAIN memory lookup
- `cleo show <taskId>` — individual task detail (use when you need the raw task record)

If you find yourself reading a markdown file for orientation, STOP. Run `cleo briefing`.

## Session Start (cheapest-first)

**FIRST COMMAND IS ALWAYS `cleo briefing`** — no exceptions.

1. `cleo briefing` — canonical session context: handoff note, next tasks, BRAIN digest (~600 tokens)
2. `cleo session status` — resume existing? (~200 tokens)
3. `cleo current` — active task? (~100 tokens)
4. `cleo next` — what to work on (~300 tokens)
5. `cleo focus {id}` — **preferred orient call** — single envelope with identity + scope + blockers + ready wave + docs + brain context (≤ 1 500 tokens, replaces 8 calls)
6. `cleo show {id}` — full task record details when you need the raw record (~400 tokens)
7. `cleo orchestrate start --epic TXXX` — for epics with ≥ 5 children (~300 tokens, auto-inits LOOM)
<!-- /CLEO-INJECTION:section=session-start -->

<!-- CLEO-INJECTION:section=work-loop -->
## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo focus {id}` → orient: identity + blockers + ready wave + docs + brain context (1 call ≤ 1 500 tokens)
3. Do the work (code, test, document)
4. `cleo complete {id}` → mark done
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
| Multiple related tasks ready in parallel | Run `cleo orchestrate ready --epic <id>` for the wave set |
| About to call `cleo complete` | First: check gates via `cleo show <id>` → run tests → then complete |
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

`cleo add-batch` inserts all tasks in a single transaction — ANY failure rolls back ALL inserts.
Use `--dry-run` first; the projected mutation envelope reports `/data/count` and
`/data/wouldCreate` as the predicted create count while `/data/insertedCount` remains `0`.
See `ct-cleo` skill section "Decomposing an epic into N tasks" for the JSON schema and rollback semantic.

### Sagas — above-Epic grouping (ADR-073)

A **Saga** (`SG-`) is a multi-release theme grouping multiple Epics. It is a labeled top-level
Epic (`label='saga'`), NOT a new TaskType. Members are linked via `task_relations.relation_type='groups'` —
Sagas do NOT use parent edges, so `cleo list --parent` will not surface members.

Available since v2026.5.77 (T9518 epic; T9514 relates-writer fix as gating dep).

| Goal | Command |
|------|---------|
| Create a Saga | `cleo saga create --title "..." --description "..." --acceptance "ac1\|ac2\|ac3\|ac4\|ac5"` |
| Link an Epic to a Saga | `cleo saga add <sagaId> <epicId>` |
| List all Sagas | `cleo saga list` |
| List member Epics of a Saga | `cleo saga members <sagaId>` |
| Aggregate status across members | `cleo saga rollup <sagaId>` |

Sagas hold N Epics at zero nesting-budget cost — the Epic→Task→Subtask depth ladder (maxDepth=3) stays
untouched under each member Epic. Use Sagas for release themes that span multiple shippable Epics.
<!-- /CLEO-INJECTION:section=task-creation -->

<!-- CLEO-INJECTION:section=task-discovery -->
## Task Discovery

**Use `cleo focus` to orient on a task. Use `cleo find` for discovery. NEVER `cleo list` for browsing.**

| Command | ~Tokens | Use |
|---------|---------|-----|
| `cleo focus <id>` | ≤ 1 500 | **Primary orient surface** — identity + scope + blockers + ready wave + docs + brain context in ONE call |
| `cleo find "query"` | 200-400 | Search tasks (default) |
| `cleo show <id>` | 300-600 | Raw task record (fallback when focus envelope is not sufficient) |
| `cleo list --parent <id>` | 1000-5000 | Direct children only |
<!-- /CLEO-INJECTION:section=task-discovery -->

<!-- CLEO-INJECTION:section=session-commands -->
## Session Commands

| Goal | Command |
|------|---------|
| Check session | `cleo session status` |
| Resume context | `cleo briefing` |
| Start session | `cleo session start --scope global` |
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

Memory context: `cleo memory digest --brief` gives a live project memory summary (default mode). Legacy file mode: set `brain.memoryBridge.mode = "file"` in config to restore `@.cleo/memory-bridge.md` injection.
<!-- /CLEO-INJECTION:section=memory -->

<!-- CLEO-INJECTION:section=nexus -->
## Nexus — when to use which scope

`cleo nexus` is the code-intelligence surface. It has **5 scopes**. Pick by intent, not name.

| Intent                                      | Scope          | First-reach command                     |
|---------------------------------------------|----------------|-----------------------------------------|
| Edit/refactor *this* repo safely            | `project`      | `cleo nexus impact <symbol>`            |
| Explore *this* repo by concept or symbol    | `project`      | `cleo nexus query` / `context`          |
| One-shot machine-readable repo snapshot     | `project`      | `cleo nexus report` (LAFS JSON)         |
| Recall what the agent knows across sessions | `living-brain` | `cleo nexus brain find "<q>"`           |
| Compare or share patterns across repos      | `cross-project`| `cleo nexus compare` / `shared`         |
| Blend code + memory + cross-repo            | `hybrid`       | `cleo nexus synthesize <topic>`         |
| Index health / reindex / purge              | `global-infra` | `cleo nexus admin <status|analyze|clean>` |

**Project resolution** (project + hybrid scopes only):
`--project-id` > `--path` > `cwd`. Default ID = `base64url(path).slice(0,32)`.

**Every nexus envelope returns**:
- `meta.scope` — confirms which scope answered
- `meta.projectId` — confirms which project (if applicable)
- `meta.suggestedNext: string[]` — chained-reasoning hints (use these before re-discovering)

**Rule**: BEFORE editing any symbol, run `cleo nexus impact <symbol>`. HIGH/CRITICAL = stop and warn.

**Skip the help dump**: `cleo nexus report` answers most agent project-questions in one call.
<!-- /CLEO-INJECTION:section=nexus -->

<!-- CLEO-INJECTION:section=orchestration -->
## Orchestration (for epics ≥ 5 tasks)

| Goal | Command |
|------|---------|
| Initialize epic pipeline | `cleo orchestrate start <epicId>` (auto-inits LOOM research stage) |
| Get parallel-safe wave | `cleo orchestrate ready --epic <id>` |
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

Every `cleo orchestrate spawn` automatically provisions a git worktree for the agent under `~/.local/share/cleo/worktrees/<projectHash>/<taskId>/` (D029 canonical layout via env-paths). The spawn prompt contains a `## Worktree Setup (REQUIRED)` section that:

- Names the worktree path and branch (`task/<taskId>`).
- States the context-isolation constraint: "authorized only within `<path>`".
- Provides `FIRST ACTION: cd <path>` so the agent initializes its cwd.

Agents MUST `cd` to the worktree path as their first action. All reads, writes, and git operations MUST occur inside the worktree boundary. A git shim on the PATH blocks forbidden operations (checkout, switch, force-push, etc.).

The orchestrator integrates the worktree branch back to the project's target branch with `git merge --no-ff` after the agent completes (ADR-062) — preserving every original commit SHA, the author's identity, and `git log --grep "<task-id>"` traceability. Agents NEVER touch the target branch directly. To skip provisioning (e.g. for meta-tasks that only run CLI commands), pass `--no-worktree`. The opt-out is always logged to the audit log.

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
| Attach file/url to task | `cleo docs add <taskId> <file>` or `--url <url>` |
| List task attachments | `cleo docs list --task <id>` |
| Generate llms.txt summary | `cleo docs generate --for <taskId>` |
<!-- /CLEO-INJECTION:section=documents -->
<!-- CLEO-INJECTION:section=human-render -->
## Human Render Contract (ADR-077)
Typed `RenderableEnvelope<T>` from `@cleocode/contracts`. `envelope.data.kind` ∈ `tree | table | list | grouped-list | section | single | generic` — agents route on `kind`. Render logic in `packages/core/src/render/`, primitives in `packages/animations/render/`, icon enums in `@cleocode/contracts/render/icon.ts`. Families self-register via `registerRenderer(command, kind, fn)`. Commands: `cleo show T<id>` (typed), `cleo show T<id> --human` (force), `cleo tree T<id>` (generic walk of parent + `groups` edges). Full: `cleo docs fetch adr-077-human-render-contract`.
<!-- /CLEO-INJECTION:section=human-render -->

<!-- CLEO-INJECTION:section=output-contract -->
## CLI Output Contract (ADR-086)

`cleo` stdout = ONE LAFS envelope per call (single JSON object + `\n`). All logs/progress → stderr. NEVER pipe through `tail`/`jq`/`python` — use flags.

| Need | Flag | Example |
|------|------|---------|
| Scalar extract | `--field <jsonpointer>` | `id=$(cleo add 'X' --acceptance "..." --field /data/created/0)` |
| ID-only pipeline | `--output id` | `cleo list --parent EPIC --output id \| while read c; do …; done` |
| Affected count | `--output count` | `cleo list --parent EPIC --status pending --output count` |
| TSV (no header) | `--output table` | `cleo list --parent EPIC --output table` |
| Silent (exit-code only) | `--output silent` | `cleo update T123 --status done --output silent` |
| 1-line per record | `--summary` | `cleo list --parent EPIC --summary` |
| Suppress stderr | `--quiet` | `cleo add-batch --file f.json --parent T1 --quiet --output id` |
| Force full record | `--full` | `cleo show T123 --full` |

Mutate ops (`add`, `add-batch`, `update`, `complete`, `delete`) return `{count, created[], updated[], deleted[], ids[]}` by default (T9931). Use contract-backed paths: `/data/created/0` for create/add-batch, `/data/updated/0` for update/complete, `/data/deleted/0` for delete, and `/data/count` for counts. `ids[]` is a deprecated compatibility alias; opt back to full record via `--full`. Anti-patterns (REJECTED): `cleo show … | tail -1 | jq …`, `cleo list … | jq -r '.data.tasks[].id'`, `cleo add 'X' 2>&1 | grep -oE 'T[0-9]+'`. Full contract: `cleo docs fetch adr-086-cli-output-contract-e9`.
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
<!-- /CLEO-INJECTION:section=error-handling -->

<!-- CLEO-INJECTION:section=pre-complete-gate -->
## Pre-Complete Gate Ritual (ADR-051 — evidence required)

MANDATORY before every `cleo complete <id>`. Every gate write MUST be backed by programmatic evidence that CLEO validates against git, the filesystem, or the toolchain. `cleo verify --all` alone is REJECTED with `E_EVIDENCE_MISSING`.

### 1. Capture evidence for each gate

```bash
# implemented — commit + file list
cleo verify T### --gate implemented \
  --evidence "commit:<sha>;files:path/a.ts,path/b.ts"

# implemented — decision-only task (no code change, deliverable is a recorded decision)
# Eliminates CLEO_OWNER_OVERRIDE on decision-only completion paths (T1875).
cleo verify T### --gate implemented \
  --evidence "decision:D-arch-001;files:docs/research-note.md"
#   OR with a note instead of a file
cleo verify T### --gate implemented \
  --evidence "decision:D-arch-001;note:decision recorded in BRAIN"

# testsPassed — structured test JSON OR project-resolved tool
cleo verify T### --gate testsPassed --evidence "tool:test"
#   OR (legacy alias — pnpm-test, cargo-test, pytest, etc. all map to canonical `test`)
cleo verify T### --gate testsPassed --evidence "tool:pnpm-test"
#   OR (anchored test-run JSON — preferred for sharing across sibling tasks)
cleo verify T### --gate testsPassed --evidence "test-run:/tmp/vitest-out.json"
#   OR (retroactive — references a merged PR; satisfies BOTH testsPassed AND qaPassed) (T9764)
cleo verify T### --gate testsPassed --evidence "pr:357"

# qaPassed — lint + typecheck exit 0 (project-resolved: biome/eslint/clippy/ruff, tsc/mypy/...)
cleo verify T### --gate qaPassed --evidence "tool:lint;tool:typecheck"
#   OR via legacy aliases — both still work
cleo verify T### --gate qaPassed --evidence "tool:biome;tool:tsc"
#   OR retroactive PR atom — same atom can verify testsPassed + qaPassed (T9764)
cleo verify T### --gate qaPassed --evidence "pr:357"

# documented — docs files or URL
cleo verify T### --gate documented --evidence "files:docs/spec.md"

# securityPassed — scan or waiver
cleo verify T### --gate securityPassed --evidence "tool:security-scan"
#   OR with justification
cleo verify T### --gate securityPassed --evidence "note:no network surface"

# cleanupDone — summary
cleo verify T### --gate cleanupDone --evidence "note:removed dead branches"
```

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
  cleo verify T### --all --evidence "note:owner-approved"
```

All overrides append a line to `.cleo/audit/force-bypass.jsonl`. Use sparingly.

### Tool resolution + result cache (ADR-061)

`tool:<name>` evidence is project-agnostic. Canonical names: `test`, `build`, `lint`, `typecheck`, `audit`, `security-scan`. They resolve via `.cleo/project-context.json` (`testing.command`, `build.command`) with per-`primaryType` fallbacks (cargo, pytest, go, bun, …). Legacy aliases (`pnpm-test`, `tsc`, `biome`, `cargo-test`, `pytest`, …) still work.

Results are cached under `.cleo/cache/evidence/<key>.json`, keyed on `(canonical, cmd, args, HEAD, dirty-tree fingerprint)`. Parallel verifies against identical state coalesce to one execution via a per-key lock; cross-worktree parallelism is bounded by a machine-wide per-tool semaphore at `~/.local/share/cleo/locks/tool-<canonical>/`. Tune with `CLEO_TOOL_CONCURRENCY_<TOOL>=<n>` (`0` disables).

### `pr:<number>` retroactive atom (T9764)

For tasks that already shipped via the standard PR + admin-merge flow, `pr:<number>` resolves through `gh pr view <num>` and accepts the atom IFF the PR is `state=MERGED` AND every required-workflow check (defaults: `CI`, `Lockfile Check`, `Contracts Dep Lint`) is `SUCCESS` or `SKIPPED`. The single atom satisfies BOTH `testsPassed` and `qaPassed` simultaneously — no need to re-run the monorepo suite or lint pipeline. Results cache under `.cleo/cache/evidence/pr-<num>.json`, keyed on `(prNumber, mergedAt)` so re-verifies skip the network round trip. Override required workflows via `CLEO_PR_REQUIRED_WORKFLOWS="<csv>"`.

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

Invoke with an explicit tier:

```bash
cleo orchestrate spawn T1234 --tier 0   # minimal (quick workers)
cleo orchestrate spawn T1234            # tier 1 (default)
cleo orchestrate spawn T1234 --tier 2   # full (autonomous workers)
```

Every spawn prompt contains these required sections — orchestrators can programmatically assert their presence before dispatching a subagent:

- `## Task Identity`
- `## File Paths (absolute — do not guess)`
- `## Session Linkage`
- `## Stage-Specific Guidance`
- `## Evidence-Based Gate Ritual (MANDATORY · ADR-051 · T832)`
- `## Quality Gates`
- `## Return Format Contract (MANDATORY)`
<!-- /CLEO-INJECTION:section=spawn-tiers -->

<!-- CLEO-INJECTION:section=rules -->
## Rules

- No time estimates — use `small`, `medium`, `large` sizing
- Token budget: avoid `cleo list` without `--parent`, avoid `cleo help --tier 2` before tier 0
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

### Decision Lookup (D0xx ID Overload Warning)

Decision IDs (D0xx, AGT-*) are **NOT globally unique** — same ID can mean different things across documents. Always verify source. Lookup order: (1) `cleo memory decision-find --query <term>` (2) `cleo memory find <term>` (3) `grep -r "D0xx" .cleo/adrs/` (4) `grep -r "D0xx" .cleo/agent-outputs/`. Check outcome status (pending/accepted/superseded) and fetch sibling decisions from same epic.

Budget: 3 JIT calls per task phase. More = task is underspecified.
<!-- /CLEO-INJECTION:section=memory-jit -->

<!-- CLEO-INJECTION:section=escalation -->
## Escalation

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
<!-- /CLEO-INJECTION:section=escalation -->
