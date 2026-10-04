# CLEO Protocol

Version: 2.24.6 | CLI-only dispatch | `cleo <command> [args]`

<!-- CLEO-INJECTION:section=session-start -->
## Universal protocol

1. **Orient.** Confirm project/worktree; run `cleo briefing` and `cleo focus <id>`. Follow user scope, provider safety, and repository instructions. Failed briefing is a diagnostic, not proof of absent history.
2. **Check authority and coverage.** Distinguish current evidence, historical guidance, conflicting claims, and missing knowledge. Fetch cited records and their sourced successors. Recency or similarity alone does not establish authority.
3. **Inspect evidence.** Before editing, inspect impact and its coverage. `UNKNOWN` means assessment is incomplete; `NONE` means no impact detected in the assessed graph. Static analysis cannot prove all runtime callers. Resolve ambiguous symbols using qualified candidate identifiers and verify against source.
4. **Act.** Use the repair matrix: scope, evidence, repair class, proposed operation, prerequisites, verification, and recovery. Automatic repairs must be bounded and reversible. The calling agent supplies sourced resolutions for ambiguous findings; owner decisions stay explicit. No background LLM is required for repair.
5. **Verify.** Run relevant checks, record validated evidence, then complete. Report unresolved and failed findings and missing coverage rather than claiming success.
6. **Learn.** Record actionable incident knowledge with source, project, revision, observation, correction, and verification through `cleo memory observe`. Preserve historical handoffs; present corrections separately. Avoid empty completion traces.
7. **Ask the owner.** Every owner answer, decision, approval or choice goes through the ask tool (`AskUserQuestion` or the provider equivalent) with concrete selectable options, recommended first, each stating what happens and its trade-offs. Never ask in prose or bury a question in a response. No routine status chatter: report when done or when a decision is needed. Subagents never ask the human; they return the question and options to their orchestrator, which asks. No ask tool: emit one LAFS `hitl.request` envelope `{question, options[{label, description}], recommended}` and stop.

Use `cleo <command> --help` (no top-level help) and the `ct-cleo` skill for command details. Bare `cleo show <id>` withholds description and verification and lists them in `_withheld`; use `cleo show <id> --full`. A record without `_withheld` is complete; absence is not emptiness.
<!-- /CLEO-INJECTION:section=session-start -->

## On-demand reference

Everything else is one command away — print a section with `cleo briefing inject --section <name>` before acting in that area:

| Section | Load it when you |
|---------|------------------|
| `task-creation` | file tasks, batches, sagas, subtasks; hit acceptance, priority or depth errors |
| `task-discovery` | search, dedupe, reconcile overlap, read `data.population` |
| `task-relationships` | add `depends` / `blockedBy` / `relates` |
| `memory` · `memory-jit` | search/fetch BRAIN, look up decisions |
| `nexus` | query the symbol graph (`impact`, `context`, freshness) |
| `data-location` | suspect store corruption or read `.cleo/*.db` |
| `orchestration` · `playbooks` · `spawn-tiers` | run an epic, spawn workers, worktrees, playbooks, HITL tokens |
| `documents` · `human-render` | attach/publish canonical docs; renderers |
| `evidence` | typed gates, `pr:` atoms, tool cache/timeouts, owner override |
| `projection` · `knowledge-repair` | read budgets, mutation receipts; `cleo doctor knowledge` repair jobs |

<!-- CLEO-INJECTION:section=work-loop -->
## Work Loop

1. `cleo current` or `cleo next` → pick task
2. `cleo focus {id}` → orient: identity + blockers + ready wave + docs + brain context
3. Check authority, coverage, and source evidence; do the work
4. Record verification evidence, then `cleo complete {id}` → mark done
5. `cleo next` → continue or end session

Discovery: `cleo find "query"` to search (default page 20; `--limit 0` for all), `cleo list --parent <id>` for direct children only — never bare `cleo list` for browsing. Create: `cleo add --type task --parent <epicId> --title "..." --acceptance "..."` (`--acceptance` is required on every task). Before editing a symbol: `cleo nexus impact <symbol>`; an empty footprint alone never establishes `NONE`.
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
| About to call `cleo complete` | `cleo done <id> --plan`, record what it names, then complete |
| Writing a canonical doc (spec/adr/research/handoff/note/llm-readme) | Use `cleo docs add --type <kind> --slug <kebab-handle>` — NEVER raw fs write to `.cleo/adrs/`, `.cleo/research/`, `.cleo/agent-outputs/`, or `docs/` |
| Reading an ADR/spec/research note/handoff | `cleo docs fetch <slug>` — never grep the filesystem for canonical docs |
| New device, restore or migration; known repo "Not inside a CLEO project"; unreachable registry path; nexus `ENOENT` | `cleo doctor global-delivery` (hub + skills resolve; `--repair`), `cleo doctor projects` (dry run; `--apply`/`--rollback <id>`), `cleo doctor project-identity`, `cleo doctor --all-projects`, `cleo nexus projects clean --orphans --dry-run` (`--dry-run` mandatory: it deletes moved projects), `cleo doctor credentials`; report. Never delete rows of projects that may have moved |
<!-- /CLEO-INJECTION:section=triggers -->

<!-- CLEO-INJECTION:section=session-commands -->
## Session Commands

| Goal | Command |
|------|---------|
| Check session | `cleo session status` |
| Resume context | `cleo briefing` |
| Start session | `cleo session start --scope global --name "<what you are doing>"` (both flags are REQUIRED) |
| End session | `cleo session end --note "..."` |

Sessions are terminal-bound: to the agent harness, pane, tab, CI job or ssh login, and to a known single-agent harness process (Kimi, aider, …) across its `bash -c` calls; in a human's tab it gets its own identity and runs `cleo session start` itself. Other hosts (orchestrators, IDE extension hosts, `opencode serve`, daemons) identify nobody: multi-agent hosts and multi-step scripts set `CLEO_SESSION_ID` (or `CLEO_AGENT_ID` in a long-lived host only) per agent. `E_SESSION_UNBOUND` → bind via `cleo session start`, `cleo session resume <id>` or `CLEO_SESSION_ID=<id>`, or pass `--session <id>`; separate one-shot `ssh host 'cleo …'` calls must export `CLEO_SESSION_ID`. Claude Code adopts a session a human started in its tab; Agent-tool subagents inherit the parent's `CLAUDE_CODE_SESSION_ID`, so they act in the parent's session.
<!-- /CLEO-INJECTION:section=session-commands -->

<!-- CLEO-INJECTION:section=output-contract -->
## CLI Output Contract (ADR-086)

`cleo` stdout = ONE LAFS envelope per call (single JSON object + `\n`). All logs/progress → stderr. NEVER pipe through `tail`/`jq`/`python` — use flags.

| Need | Flag | Example |
|------|------|---------|
| Scalar extract | `--field <jsonpointer>` | mutate: `id=$(cleo add 'X' --acceptance "..." --field /data/created/0)` · read: `st=$(cleo show T123 --field /data/task/status)` |
| ID-only pipeline | `--output id` | `cleo list --parent EPIC --output id --limit 0` — **`--limit 0` means EVERY match on BOTH `list` and `find`**; without it list returns 10, find 20 |
| Returned/affected count | `--output count` | `cleo list --parent EPIC --status pending --output count` |
| TSV / silent / 1-line | `--output table` · `--output silent` · `--summary` | `cleo update T123 --status done --output silent` |
| Suppress stderr / full record | `--quiet` · `--full` | `cleo show T123 --full` |

**READ/MUTATE nesting differs:** mutations are FLAT; reads nest: `cleo show` uses `/data/task/status`, NEVER `/data/status`. Unresolvable pointers fail with `E_FIELD_NOT_FOUND` and list valid pointers; use those instead of guessing. `cleo verify` returns the full `verification` object at `--field /data/verification`.

Mutations (`add`, `add-batch`, `update`, `complete`, `delete`) return `{count, created[], updated[], deleted[], ids[]}`: use `/data/created/0`, `/data/updated/0`, `/data/deleted/0`, `/data/count` (`ids[]` is deprecated). Deletion is a soft archive: `cleo delete <id> --cascade` includes descendants; `--force` alone orphans children and permits dependents; without either, parents with children are rejected.
<!-- /CLEO-INJECTION:section=output-contract -->

<!-- CLEO-INJECTION:section=error-handling -->
## Error Handling

Check exit code (`0` = success) and `"success"` in JSON output after every command.

| Exit | Code | Fix |
|:----:|------|-----|
| 4 | `E_NOT_FOUND` | `cleo find` to verify ID |
| 6 | `E_VALIDATION` | Check field lengths |
| 10 | `E_PARENT_NOT_FOUND` | `cleo exists <id>` |
| 80 | `E_LIFECYCLE_GATE_FAILED` | Parent epic not in implementation stage yet — advance with `cleo lifecycle complete` |
| 83 | `E_IVTR_INCOMPLETE` | IVTR loop not released — run `cleo orchestrate ivtr <id> --next` |
| — | `E_EVIDENCE_MISSING` / `E_EVIDENCE_INSUFFICIENT` | `cleo verify … --evidence <atoms>` with every atom kind the gate needs (e.g. `commit:<sha>` + `files:<list>` for `implemented`) |
| — | `E_EVIDENCE_TESTS_FAILED` / `E_EVIDENCE_TOOL_FAILED` | Fix the source or failing tests, then re-verify |
| — | `E_EVIDENCE_TOOL_VACUOUS` | Tool exited 0 but provably checked nothing (e.g. `tsc` without `-b` on a references-only tsconfig); run it in a covering mode |
| — | `E_EVIDENCE_STALE` | Files/commits changed since `verify`; re-verify with updated evidence |
| — | `E_EVIDENCE_GIT_ROOT` | The CLEO root is not a git checkout; declare `"evidence": { "gitRoot": "<subdir>" }` in `.cleo/project-context.json` or set `CLEO_EVIDENCE_GIT_ROOT=<repo>` |
| — | `E_FLAG_REMOVED` | `cleo complete --force` removed per ADR-051. Use `--evidence` |
| — | `E_IDEMPOTENCY_UNSUPPORTED` | That verb ignores `--idempotency-key` (list below); query before retrying |
| 143 / 137 | *(killed — no code)* | **Outcome unknown; see below** |

### A killed write is not a failed write

Missing output is equally inconclusive; teardown may hang after commit. **Never retry a killed mutation blindly.** Read `cleo show <id> --full`: a HIT proves presence even while the writer hangs; a MISS proves nothing until it exits. For discovery use `cleo find "<title>" --include-archive --all` or `cleo list --parent <id> --limit 0`. `add`/`add-batch`/`update`/`docs add`/`memory observe`/`relates add` reject `--idempotency-key`; it cannot make their retries safe.
<!-- /CLEO-INJECTION:section=error-handling -->

<!-- CLEO-INJECTION:section=pre-complete-gate -->
## Pre-Complete Gate Ritual (ADR-051 — evidence required)

Before `cleo complete <id>`, every gate requires programmatic evidence validated against git, files or tools: `cleo verify T### --gate <gate> --evidence "<atoms>"`. Bare `cleo verify --all` rejects with `E_EVIDENCE_MISSING`.

| gate | evidence that satisfies it |
|------|----------------------------|
| `implemented` | `commit:<sha>;files:path/a.ts,path/b.ts` — or `pr:<number>` with `files:<changed-paths>`, or `decision:<id>` for decision-only tasks |
| `testsPassed` | `ci:<pr>` if merged and `evidence.ciSatisfies`; else `tool:test-affected` (needs `testing.affectedCommand`), changed-file `test-run:<json>`, or `tool:test` |
| `qaPassed` | `ci:<pr>` likewise, else `tool:lint;tool:typecheck` |
| `documented` | `files:docs/spec.md` |
| `securityPassed` | `tool:security-scan` |
| `cleanupDone` | `note:removed dead branches` |

Name the acceptance criteria each result proves: `cleo verify T1234 --gate implemented --evidence "commit:abc123;files:src/fix.ts;satisfies:T1234#AC1"`. Record `testsPassed` and `qaPassed` separately with actual verification results and explicit criterion links. Documentation-only PRs cannot implement a code-fix task; changed criteria require fresh evidence, and a child waiver does not waive parent criteria. Then `cleo complete T###` re-validates every hard atom (commit reachable, file sha256, test-run hash); tampering → `E_EVIDENCE_STALE`. Typed gates, `pr:` rules, tool timeouts and the audited owner override: `cleo briefing inject --section evidence`.

Anti-patterns: completing without running tests · self-attesting without programmatic proof · running tests by hand, then again via `tool:test` · modifying files between `cleo verify` and `cleo complete`.
<!-- /CLEO-INJECTION:section=pre-complete-gate -->

<!-- CLEO-INJECTION:section=rules -->
## Rules

- No time estimates — use `small`, `medium`, `large` sizing
- Heavy work (tests, typechecks, builds): one at a time via `cleo run --wait --class <test|build|full-build> -- <cmd>` (exit 75: wait, retry). Never wrap `cleo run`/`cleo verify` in another queue or raise heap/workers (`NODE_OPTIONS`, `--maxWorkers`). Prove with single files, `tool:test-affected` or `ci:<pr>`, never a whole suite
- Do not read full task details for tasks you won't work on
- Never read `.cleo/*.db` directly — the store is `.cleo/cleo.db` (prefixed tables); `tasks.db` and `tasks-*.db` snapshots are decoys. Ask the CLI (`cleo doctor superseded-store`)
<!-- /CLEO-INJECTION:section=rules -->

<!-- CLEO-INJECTION:section=escalation -->
## Escalation

- Load **ct-cleo** skill for full protocol details
- Load **ct-orchestrator** skill for multi-agent workflows
<!-- /CLEO-INJECTION:section=escalation -->
