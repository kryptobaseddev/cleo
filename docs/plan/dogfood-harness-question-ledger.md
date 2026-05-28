# Dogfood harness question ledger

## Goal

Keep hard dogfood questions visible until they are inherited by the North Star, converted into owned CLEO work, answered by BRAIN decisions, or explicitly rejected. MUST ALWAYS wrap sessions with What did you learn about cleo code this session while using it, any issues or hurddles around using it while you went through this process that you would like to see optimized or improved. it can be functionality in cleo, observations about its tool uses, bugs, skill instructions issues. Must focus on always iterating and improving while dogfooding using Cleo Code removing any friction an LLM agent has and improving the CORE harness API and TOOLS first NOT the CLI as the CLI is only an extension of the CORE API

## Ledger protocol

Each question MUST have:
- stable ID: `DHQ-###`
- owner surface: saga/epic/task that owns the answer
- answer vehicle: BRAIN decision, ADR, accepted plan, shipped PR, or cancelled-with-rationale task
- status: open, researching, decided, implemented, retired
- next review trigger: session start, saga completion, release failure, or North Star refresh

Durable architectural answers MUST be stored with `cleo memory decision-store` and linked to tasks. This document is an index, not the source of truth for decisions.

## Open questions captured from triage:

### DHQ-001 — Worker state truth

Question: Why are agents still forced to infer worker state from worktree spelunking instead of an orchestrator dashboard?

Owner surface: `T10437` multi-agent observability.

Actionable tasks:
- `T10522` — Detect stalled dirty/unpushed worker worktrees.
- `T10523` — Surface DB/evidence lock contention and stale-lock cleanup guidance.

Answer vehicle: dashboard design + implementation tasks; later BRAIN decision if a state taxonomy is ratified.

Status: open / task-filed.

Next review trigger: before any next 5+ worker saga.

### DHQ-002 — Administrative closeout vs unsafe override

Question: Why does already-green administrative closeout still consume the same override path as unsafe bypass?

Owner surface: `T9496` / `T9505` override-cap cleanup, plus `T10437` observability.

Answer vehicle: BRAIN decision defining override taxonomy, then implementation task if accepted.

Status: open / mapped.

Next review trigger: next time `CLEO_OWNER_OVERRIDE` is needed for merged or already-green work.

### DHQ-003 — Release truth before tag/publish

Question: Why do release blockers show up after tag/publish instead of in preflight?

Owner surface: `T10431`, `T10434`, `T10436`, `T9758`, `T9761`.

Answer vehicle: release-readiness preflight + release provenance graph.

Status: open / partially owned.

Next review trigger: next release attempt or npm artifact inconsistency.

### DHQ-004 — Docs SSoT agent ergonomics

Question: Why does docs SSoT have correct architecture but an agent-hostile CLI and inconsistent publish/update model?

Owner surface: `T10516`.

Actionable epics:
- `T10517` — command surface and migration aliases.
- `T10518` — slug/latest owner-version SSoT repair.
- `T10519` — storage/query consolidation.
- `T10520` — decision-routing ergonomics.
- `T10521` — dogfood regression harness.

Answer vehicle: SG-DOCS-CLI-SIMPLIFICATION implementation plus regression tests.

Status: open / decomposed.

Session assessment 2026-05-28: still open. This session hit the same class of friction when `cleo docs sync --from ... --for ...` was advertised by help but returned `Unknown operation: mutate:docs.sync`. The agent had to patch a published file and add a new SSoT attachment instead of using a clean update/sync path. See DHQ-022 for the concrete follow-up.

Next review trigger: before editing or publishing another canonical North Star doc.

### DHQ-005 — Baselines encode unstable coordinates

Question: Why are lint baselines tracking line numbers instead of stable semantic intent?

Owner surface: `T10232`.

Actionable task:
- `T10524` — Replace line-anchored lint baselines with content-addressed markers.

Answer vehicle: lint baseline migration and tests.

Status: open / task-filed.

Next review trigger: next line-shift-induced lint baseline churn.

### DHQ-006 — CLI truth and help drift

Question: Why can CLI help/error hints advertise flags or workflows that are not implemented?

Owner surface: `T10430` fixed one instance; `T10516` covers docs-specific drift; broader CLI contract should be inherited by North Star trust foundation.

Answer vehicle: regression tests comparing error hints/help examples to actual CLI parser surface.

Status: open / partially owned.

Next review trigger: any `E_UNKNOWN_FLAG` caused by an official hint, skill, or help text.

### DHQ-007 — AC binding forces override for green-gate non-code tasks

Question: Why do non-code tasks (content trim, external verification, .gitignore restructuring, CI config changes) need `CLEO_OWNER_OVERRIDE=1` even when ALL gates are green?

Owner surface: `T9496` / `T9505` override-cap cleanup (same as DHQ-002).

Observed: T10466, T10467, T10489, T10490 all had implemented/testsPassed/qaPassed green via `tool:lint` but `cleo complete` failed on AC bindings. The same commit+files+tool evidence that satisfied gates should auto-bind ACs.

Answer vehicle: BRAIN decision defining AC auto-binding from gate evidence when all gates green.

Status: open.

Next review trigger: next non-code task completion.

### DHQ-008 — T9175 worktree warning noise on non-spawned tasks

Question: Why does `cleo complete` emit `[T9175] worktree integration failed — Branch task/TXXXX does not exist` for every task that was never spawned via orchestrate spawn?

Owner surface: `T9175` worktree integration.

Observed: All 4 tasks completed today emitted this warning. Tasks completed outside the spawn path (manual edits, external verification) shouldn't emit scary worktree-failure warnings.

Answer vehicle: check if worktree was provisioned before warning; downgrade to INFO for no-worktree-history tasks.

Status: open.

Next review trigger: next `cleo complete` on a non-spawned task.

### DHQ-009 — CI perma-failure on main does not block releases

Question: Why does the release process ship when main CI has pre-existing failures (Rust Vendor Parity, Saga Label, DB Open Chokepoint, Invariants Docs Render)?

Owner surface: `T10434` / `T10436` release preflight, `DHQ-003` release truth before tag/publish.

Observed: CI on main has `conclusion=failure` across 3 consecutive commits (542cd5c23, 4103a3b8b, ebd937640). All 4 failures are tracked pre-existing technical debt unrelated to the hygiene sweep. Yet v2026.5.123 shipped successfully to NPM.

Answer vehicle: release-readiness preflight gate that checks main CI green before proceeding.

Status: open / mapped to DHQ-003.

### DHQ-010 — Global cleo CLI uses npm binary, not local source

Question: Why does the globally installed cleo CLI run compiled code from the npm package instead of the local source tree, causing developers to repeatedly test dead code?

Owner surface: T9799 (skills compliance), T10401 (daemon harness).

Observed: 3+ rounds of debugging `cleo release plan` failures before realizing that fixes in `packages/core/src/release/plan.ts` were not live. The global `cleo` binary runs the npm-installed dist, not the local build. Fix: use `node packages/cleo/dist/cli/index.js <command>` for local testing.

Answer vehicle: `--dev` flag or local-build detection that swaps the runtime to the project's `packages/cleo/dist/cli/index.js` when invoked from a cleocode checkout.

Status: open.

Next review trigger: next time a fix doesn't take effect after a local build.

### DHQ-011 — typeForDepth destroys epic types during saga reparenting

Question: Why does `typeForDepth()` unconditionally overwrite task types to 'task'/'subtask' without preserving saga/epic identity?

Owner surface: `T10538` PM-Core V2, `T10638` saga parent type matrix.

Observed: `coreTaskReparent` called `typeForDepth(depth)` which returned 'task' for depth≥1, 'subtask' for depth≥2. Saga→epic reparents (depth 1) silently converted epics to 'task' type. The parent type matrix trigger correctly rejected 'task'→'saga' as invalid — the trigger was right, the type was wrong.

Fix: `typeForDepth(depth, currentType)` now preserves 'saga' and 'epic' types. Any function that changes task type must be saga/epic-aware post-PM-Core V2.

Answer vehicle: shipped in commit 3e76f6128.

Status: implemented.

Next review trigger: any future type-changing function added to the reparent pipeline.

### DHQ-012 — Evidence gate vs ADR-051 §11.1 deadlock for pre-system tasks

Question: Why does the release plan require evidence atoms on tasks that ADR-051 §11.1 explicitly prevents from receiving evidence?

Owner surface: `T9758` release, ADR-051.

Observed: 13 already-done tasks (T9491-T9499, T9580, T9752) blocked `cleo release plan` because they had zero evidence atoms. But `cleo verify` returned `E_ALREADY_DONE: verification evidence cannot be added to completed tasks`. Deadlock: the release gate required evidence, ADR-051 blocked adding it.

Fix: release plan grandfathers `status=done` tasks with zero evidence atoms. Shipped in commit 5d60cbc4a.

Answer vehicle: shipped.

Status: implemented.

Next review trigger: next pre-evidence-system saga release.

### DHQ-013 — Changelog-drift regex missing /m flag — only checks line 1

Question: Why does `/^## \[/.test(head)` only match line 1 of CHANGELOG.md, rejecting valid version headers on later lines?

Owner surface: `packages/core/src/hygiene/validate-spawn-readiness.ts:96`.

Observed: CHANGELOG.md with `# Changelog\n\n## [2026.5.124] (2026-05-27)` failed the changelog-drift gate because the regex with `^` anchor (no `m` flag) only matched line 1 (`# Changelog`). Single-character fix: add `/m` flag.

Answer vehicle: shipped in commit 5d60cbc4a.

Status: implemented.

Next review trigger: none — fix is live.

### DHQ-014 — Worktrunk lifecycle ownership drift escaped completion

Question: Why could `T10022` be marked done while `packages/worktree/src/worktree-create.ts` and `packages/core/src/spawn/branch-lock.ts` still owned git worktree lifecycle through raw shell-outs?

Owner surface: `T10650`, `T10853`, `T10907`, and `T9977`.

Observed: The original corrective scope focused on `packages/worktree/src/worktree-create.ts`, but dogfood inspection found a larger duplicate lifecycle engine in `packages/core/src/spawn/branch-lock.ts`. The current lint allowed `packages/worktree/` broadly and did not detect lifecycle-relevant `git branch`, `git log`, or `git status` calls.

Answer vehicle: Worktrunk Rust SSoT implementation, Core spawn consolidation, boundary lint hardening, and false-completion regression tests.

Status: open / decomposed.

Next review trigger: before starting Wave 1 implementation for `T10650` or `T10853`.

### DHQ-015 — Saga membership and traversal are not agent-reliable

Question: Why can a saga show `groups` relations in `cleo show --full` while `cleo saga members` returns zero members, and why does saga-to-epic containment still fail the parent matrix in some paths?

Owner surface: `T10965`, especially `T10966`.

Observed: `T9977` shows `groups` relations to `T10650`, `T10853`, `T10878`, `T10907`, `T10936`, and `T10965`, but `cleo saga members T9977` returned `total=0`. `cleo add --type epic --parent T9977 --dry-run` rejected `parentType=saga`, even though the PM-Core V2 guidance says saga-to-epic containment is canonical.

Answer vehicle: Core saga traversal contract, deep rollup implementation, and deprecation of dual `groups` versus `parent_id` semantics.

Status: open / task-filed.

Session assessment 2026-05-28: still open but better specified. `T11202`, `T11203`, and `T11204` were created under `T10965` to clarify soft relations, inherited dependency projection, reparent/retype cascade behavior, and stale `groups` doctrine. ADR-088 and `CLEO-TASKS-API-SPEC` were amended to state that `task_relations.groups` is dotted-line context only, not Saga membership.

Next review trigger: next time an agent plans or orchestrates work at saga scope.

### DHQ-016 — Planning decomposition still depends on brittle CLI loops

Question: Why does an agent need dozens of sequential `cleo add` calls to create a saga/epic/task/subtask graph instead of one Core WorkGraph scaffold operation?

Owner surface: `T10965`, especially `T10986`.

Observed: Creating the Worktrunk decomposition required long shell-driven loops. One loop timed out after partial creation, requiring manual resume and duplicate-avoidance checks. This is a Core API gap first, not a CLI ergonomics issue.

Answer vehicle: Transactional Core planning-scaffold API with dry-run validation, atomic apply, stable ID map, duplicate detection, and cycle/depth checks.

Status: open / task-filed.

Session assessment 2026-05-28: still open. The session still required sequential `cleo add` calls to log follow-up work (`T11202`, `T11203`, `T11204`) instead of one typed Core planning-scaffold mutation. This reinforces that the fix belongs in Core first, with CLI as a wrapper.

Next review trigger: next multi-epic decomposition or any 25+ node planning session.

### DHQ-017 — Docs fetch is correct but not agent-friendly

Question: Why does `cleo docs fetch` return base64/path-oriented envelopes instead of an explicit decoded-content mode for text documents?

Owner surface: `T10965`, especially `T10970`.

Observed: Fetching `adr-087-a-worktrunk-ssot-boundary` returned an inline base64 payload in the LAFS envelope. That is structurally correct, but it forces an agent to decode or switch tools before it can reason over the text.

Answer vehicle: Core docs fetch content modes: metadata-only, decoded text, bytes, and path fallback, with CLI flags as thin wrappers.

Status: open / task-filed.

Session assessment 2026-05-28: still open. `cleo docs fetch` again returned base64/path-oriented envelopes for canonical docs, forcing the agent to rely on direct file reads or decode paths when reasoning over text. The need remains a Core docs fetch decoded-text mode.

Next review trigger: next agent workflow that fetches a canonical doc for planning or validation.

### DHQ-018 — Evidence gates do not guide agents toward sufficient proof

Question: Why must an agent manually construct gate-specific evidence strings instead of asking Core what evidence is missing and getting suggested atoms?

Owner surface: `T10965`, especially `T10974`, and false-completion prevention in `T10932`.

Observed: `T10022` had PR/check evidence but still missed architecture-critical acceptance. The system needs better Core-level evidence suggestions and acceptance-to-file/path hints before a task is completed.

Answer vehicle: Core evidence suggestion/explanation tool plus false-completion regression scenarios.

Status: open / task-filed.

Next review trigger: before completing any architecture-boundary task or non-code verification task.

### DHQ-019 — Worktree inventory has multiple competing truths

Question: Why are Git worktree metadata, canonical XDG worktree directories, and `.cleo/worktrees.json` not reconciled by one Core lifecycle status API?

Owner surface: `T10936`.

Observed: `lint-worktree-location --warn` still reported four stale non-canonical `/mnt/projects/*` entries. Prior inspection also found a large gap between canonical on-disk worktrees and the sentinel index. Agents cannot safely reason about worktree state if the sentinel index is treated as complete when it is not.

Answer vehicle: Worktree reconciliation Core API, dry-run planner, adoption backfill, transient worktree policy, and bounded status concierge.

Status: open / decomposed.

Next review trigger: before lifecycle cleanup, spawn-readiness validation, or any worktree migration.

### DHQ-020 — Core tools are not yet the default agent interface

Question: Why do agents still reach for CLI commands and command-specific output parsing instead of typed Core SDK tools for spawn, worktree lifecycle, manifest handoff, hooks, validation, and docs?

Owner surface: `T10878` and `T10965`.

Observed: The session required CLI calls for planning, docs fetch, saga membership, task creation, memory, and worktree lint checks. The durable fix is not more CLI flags; it is a Core tool registry with typed contracts and CLI wrappers over that registry.

Answer vehicle: Core lifecycle SDK tools, contracts in `packages/contracts`, harness evals, and thin CLI adapter migration.

Status: open / decomposed.

Session assessment 2026-05-28: still open. The session used CLI envelopes for task discovery, docs lookup, docs add, test runs, and git-adjacent workflow checks because no typed Core tool surface was available through the harness. This caused output parsing, command pass-through ambiguity, and broad test side effects. See DHQ-023 and DHQ-025.

Next review trigger: North Star refresh or before adding any new CLI-first lifecycle command.

### DHQ-021 — Agent skills can contradict live PM-Core behavior

Question: Why do skills still describe saga/group workflows that conflict with current PM-Core parent matrix and command behavior?

Owner surface: `T10990`, `T10928`, and `T10666`.

Observed: The loaded orchestration and CLEO skills still include guidance around `saga add`/`groups` semantics, while current commands and PM-Core guidance disagree in practice. This increases LLM planning errors.

Answer vehicle: Skill coverage backfill, Tier-0 skill updates, and drift checks mapped to worktree/orchestration/Core paths.

Status: open / task-filed.

Session assessment 2026-05-28: still open. `ct-cleo` is closer to ADR-088 than older embedded guidance, but live repo docs and comments still contained `groups` containment language. `T11204` now tracks the sweep across ADR-073, ADR-076, task contracts, skills, and injection text.

Next review trigger: after `T10966` defines the canonical saga traversal contract or when Worktrunk runtime contracts change.

### DHQ-022 — Docs SSoT update/sync path is not agent-safe

Question: Why does the documented docs update/sync workflow fail or force agents into new attachment versions instead of a clear in-place update path for existing canonical docs?

Owner surface: `T10516`, especially `T10518` and `T10519`; related to DHQ-004.

Observed: `cleo docs sync --from docs/adr/ADR-088-pm-core-v2-workgraph-relations-completion-criteria.md --for T11202 --content-type text/markdown` returned `Unknown operation: mutate:docs.sync`, even though `cleo docs sync --help` advertises that mode. The agent then used raw file patch plus `cleo docs add` with a new slug instead of first discovering whether the canonical slug already existed and using `cleo docs update <slug> --file <path>`. Follow-up inspection showed `docs.update` was implemented and registered, while `docs.sync` was advertised by CLI help but not registered as a dispatch operation. This is both a CLI contract bug and an agent-protocol failure: the harness should make the correct operation obvious, and agents should not invent new SSoT slugs for canonical-looking files without a discovery/update preflight.

Answer vehicle: Core docs writer/update API with typed operations for update, supersede, publish, and reverse-ingest; CLI help generated from that registry; regression test that help-advertised docs verbs dispatch successfully; agent-facing preflight rule: before `docs add` for an existing repo doc, run `docs list`/slug discovery, then `docs update <slug> --file <path> --dry-run`, and only add a new slug when the doc is genuinely new or the user explicitly wants a separate artifact.

Status: open / newly captured.

Next review trigger: next canonical doc update, especially ADR/spec edits.

### DHQ-023 — Test command scoping is brittle and can fan out into unrelated suites

Question: Why can an agent request focused tests and accidentally run a broad package test suite with repository-wide side effects?

Owner surface: `T10965` Core agent ergonomics and `T10437` observability; likely needs a Core test-plan tool before CLI changes.

Observed: `pnpm --filter @cleocode/core run test -- --run src/tasks/__tests__/find-parent-filter.test.ts src/tasks/__tests__/list-saga-parent.test.ts` was interpreted by the package script as a broad Vitest invocation. It timed out after running many unrelated suites, produced unrelated failures, and spawned temporary git branches such as `task/T_WT4_S1` through `task/T_WT4_S4B`.

Answer vehicle: Core test selection helper that returns the exact command for a file/package/test-name tuple, dry-runs the resolved test plan, and warns when the command would run the full suite. CLI can wrap this later.

Status: open / newly captured.

Next review trigger: next targeted test run from an agent session.

### DHQ-024 — Test and git side effects are not isolated from the agent worktree

Question: Why can verification commands leave git branches, index locks, and dirty state in the shared repository during an agent session?

Owner surface: `T10936` worktree lifecycle, `T10437` multi-agent observability, and `T10965` Core ergonomics.

Observed: The broad test run changed git branch state internally (`Switched to a new branch 'task/T_WT4_S1'`, etc.) and a subsequent commit hit `.git/index.lock`. The lock cleared, but an agent should not have to reason about whether test code or another process owns git state before committing scoped work.

Answer vehicle: Core verification sandbox that runs tests in an isolated worktree or protected git environment, detects branch/index mutations, and returns a structured side-effect report before an agent continues.

Status: open / newly captured.

Next review trigger: any verification command that invokes tests with git/worktree fixtures.

### DHQ-025 — `cleo current` can point agents at completed or irrelevant task context

Question: Why can an agent session report a completed, unrelated current task as active work context?

Owner surface: `T10878` Core lifecycle SDK tools and `T10965` Core agent ergonomics.

Observed: `cleo current` returned `T10297`, a completed epic unrelated to the session’s relation-taxonomy work. The agent had to manually choose/create `T11202` for commit traceability. A Core task-context tool should detect terminal current tasks and recommend `start`, `focus`, or task creation instead of presenting stale state as usable context.

Answer vehicle: Core current-task validation API that classifies current task as active, terminal, stale, or unrelated; returns machine-readable next actions and safe commit task candidates.

Status: open / newly captured.

Next review trigger: before any commit when `cleo current` returns a terminal task.

### DHQ-026 — Repeated nested-nexus warning pollutes every agent command

Question: Why does every CLEO command repeat the same nested-nexus migration warning instead of surfacing it once through health/status?

Owner surface: `T10321` nested-nexus disposition and `T10437` observability.

Observed: Nearly every `cleo` command emitted the ADR-086 nested-nexus warning. The warning is actionable, but repetition obscures the actual command result and increases token/noise cost for agents parsing envelopes.

Answer vehicle: Core health finding persisted once per session or surfaced through `cleo health`, with command envelopes carrying a compact warning code instead of full repeated prose.

Status: open / newly captured.

Next review trigger: next session where repeated non-blocking health warnings appear in command output.

## North Star inheritance rule

A question graduates into the North Star when it changes one of:
- tier sequencing
- saga ownership
- architectural doctrine
- safety/trust contract
- agent-facing workflow contract

Until then it remains in this ledger and in its owning task/saga.
