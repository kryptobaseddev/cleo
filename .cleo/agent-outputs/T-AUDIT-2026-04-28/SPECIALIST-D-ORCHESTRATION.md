# SPECIALIST D — Orchestration / Lifecycle / Agent Registry / Playbook / HITL

**Auditor**: Specialist D (5-member CLEO project audit team, 2026-04-28)
**HEAD ref**: `fd395af0f` (main, v2026.4.154 + handoff)
**Scope**: orchestrator runtime, agent registry (signaldock.db), playbook DSL (.cantbook), HITL HMAC resume tokens, doctor/reconcile, agent attach/install/spawn pipeline, dynamic skills composition, persona resolution, thin-agent enforcement, CANT DSL v3, worktree provisioning + perf, conduit messaging end-to-end, BRAIN auto-reconcile, lifecycle gates, IVTR/orchestrate/playbook dispatch handlers, T1242–T1244 GAPs, T-INV invariant series.

---

## 1. Domain Summary

The agent-composition pipeline (epic **T889 / T910**) is **largely shipped in code but only partially closed in the task DB**, producing a pervasive "shipped-but-pending" drift class. Concretely:

- The 6-layer pipeline doc (`docs/architecture/orchestration-flow.md`, 298 LOC) **exists** and is the canonical reference, despite **T896 still pending**.
- The playbook runtime (`packages/playbooks/`) **ships** parser, state-machine executor, HMAC resume tokens (`approval.ts`), policy DSL, and 3 starter `.cantbook` files. ADR-053 is accepted. T904 / T908 acceptance criteria are largely satisfied via shipped commits `f52a77a22` (Wave D), `3f9abc99c` (T935 CLI), and `c1dc49078` (T1261 contract enforcement) — both tasks remain pending.
- HITL gates: `cleo orchestrate approve|reject|pending` **are live** (verified at HEAD via `cleo orchestrate pending` returning `{success:true, approvals:[]}`).
- Agent registry: `cleo agent doctor`, `attach`, `install`, `mint`, `pack`, `create` all shipped (T901, T897, T1259). What is **NOT** shipped: T1242 (`cleo init` force-reinstall), T1243 (`cleo upgrade` registry sync), T1244 (worktree on unborn HEAD).
- Dispatch refactor (ADR-058, T1538-T1541): playbook + pipeline + ivtr have migrated to `OpsFromCore`; **`orchestrate.ts` and `release.ts` have NOT** (47 + 4 untyped casts respectively, 1431 LOC).

The biggest gap is **task-DB hygiene**: 14 of the 14 T896-T909 tasks remain `pending` even after the work shipped. This is the precise failure class that the **T-INV (T1408-T1413)** epic was created to prevent.

---

## 2. Outstanding Epics & Critical Series

### 2.1 T896-T909 — Agent Registry / Playbook / HITL (Epic T889 + T910)

| ID | Title | Status | Stage | Code state | Est. residual |
|----|-------|--------|-------|-----------|---------------|
| T896 | orchestration-flow.md doc + Mermaid | pending | — | **Shipped** at `docs/architecture/orchestration-flow.md` 298 LOC, Mermaid block exists, refs ADR-052/053 | Verify gates + complete; minor: 5 entries still labelled `Planned (T935)` despite CLI being live. |
| T897 | Seed-agent auto-install on install/upgrade | pending | — | **Shipped** at `packages/core/src/agents/seed-install.ts` (T897 + T1238 + T1239 + T1241). Idempotent via `.seed-version` marker. | Verify gates + complete. |
| T898 | Registry-backed persona resolution | pending | — | **Partially shipped**: `core/src/store/agent-resolver.ts` + classifier↔registry contract (T1326 commit `0f826e139`). Vocabulary now narrowed to registered agents. | Validate AC#7 boundary; verify gates + complete. |
| T899 | global→project→packaged tier precedence | pending | — | **Shipped**: `core/src/orchestration/registry-resolver.ts` + `__tests__/registry-resolver.test.ts` exists. | Verify gates. |
| T900 | install/attach → spawn integration | pending | — | **Shipped**: `cleo agent attach/install` + spawn lookup confirmed wired. | Verify gates. |
| T901 | Agent registry doctor | pending | — | **Shipped**: `cleo agent doctor` live with `--repair`, `--import-legacy-json`, `--migrate-path`. | Verify gates + complete. |
| T902 | Dynamic skills composition (classify→recommend→compose) | pending | — | **Shipped**: `core/src/skills/dispatch.ts`, `dynamic-skill-generator.ts`, `routing-table.ts`, `precedence-integration.ts`. | Validate against AC; complete. |
| T903 | CANT DSL v3 — formal types + requires/ensures | pending | — | **Shipped**: T1261 PSYCHE E4 contract enforcement landed (`c1dc49078`). Implemented gate=true, tests=false, qa=false. | Add evidence for testsPassed + qaPassed; complete. |
| T904 | Playbook DSL `.cantbook` runtime | pending | — | **Shipped**: `packages/playbooks/{runtime,approval,parser,policy,state,schema}.ts` + 3 starters + 18 dispatch tests passing. ADR-053 accepted. | Verify gates + complete. |
| T905 | Unify seed-agents source (kill 3 dup dirs) | pending | — | **Shipped**: `packages/cleo-os/seed-agents/` is now a stub README pointing at `packages/agents/seed-agents/` SSoT. Implemented gate=true. | Tests + complete. |
| T906 | agent_skills table → spawn integration | pending | — | **Partial**: `core/src/skills/agents/` exists, but signaldock-side `agent_skills` SSoT-vs-spawn wiring should be verified end-to-end. | Verification TBD. |
| T907 | Thin-agent runtime enforcement | pending | — | **Shipped**: `core/src/orchestration/thin-agent.ts` + tests. T931 thin-agent enforcer commit `f305d595c`. | Verify gates + complete. |
| T908 | Resume tokens + HITL gates | pending | — | **Shipped**: HMAC tokens at `packages/playbooks/src/approval.ts`, `playbook_approvals` table, `cleo orchestrate approve|reject|pending` CLI live (verified at runtime). T935 commit `3f9abc99c`. | Verify gates + complete. |
| T909 | Conduit.db topology audit | pending | — | **Shipped**: `getProjectRoot` trap + paths sanity (T1463 commit `1463`). Implemented gate=true. | Verify + complete. |

**Net**: All 14 are physically shipped or near-shipped. The blocker is **completion ritual**, not implementation. Filing closure work as a single follow-up reconciliation epic is recommended.

### 2.2 T1029-T1032 — Sentient Tier-3 Merge Ritual

| ID | Title | Status | Code state |
|----|-------|--------|-----------|
| T1029 | abort-to-clean-state protocol (`abortExperiment`) | pending | Designed in DESIGN.md §8 T1011-S3. **Not implemented** — `core/src/sentient/` lacks `abort.ts` / `experiment-runner.ts`. |
| T1030 | full merge ritual orchestrator (10-step flow) | pending | Commit `8dfe36209` claims "feat(T1074+T1030): state-pause subsystem + Tier 3 merge ritual orchestrator" — but no `experiment-runner.ts` exists. **Likely partial/regressed.** |
| T1032 | merge ritual integration test (kill-switch step 6) | pending | Depends on T1030. |

**Note**: parent T1011 is also pending; T1074 (Tier-3 state-pause) is pending. The whole Tier-3 sandbox auto-merge stack is open.

### 2.3 T1408-T1413 — T-INV Self-Enforcing Release Invariant (Epic T1407)

| ID | Title | Status | Code state |
|----|-------|--------|-----------|
| T1408 | archiveReason TEXT → enum migration | pending | **Shipped** in commit `5153dd477` "feat(T1408): migrate archive_reason TEXT → 6-value enum + CHECK constraint" + follow-through `b0d3f1338` in v2026.4.145. |
| T1409 | enum in contracts + caller updates | pending | **Shipped** alongside T1408 in v2026.4.145 (`b8e084369`). |
| T1410 | commit-msg lint (T\d+ ID required) | pending | **Shipped** commit `ee0e55592` "feat(T1410): commit-msg lint requiring T-IDs in release commits". |
| T1411 | Post-release reconciliation hook | pending | **Shipped** commit `a10994cc5` (v2026.4.146): `cleo reconcile release --tag <tag>`. Follow-up `b696bdb88` for conduit topic ops registry. |
| T1412 | ADR for invariant + escape hatches | pending | **Shipped** commit `c4b9b27ea` "docs(T1412): ADR-056 DB SSoT, naming convention, release-completion invariant". |
| T1413 | Test suite for hook + migration round-trip | pending | Tests visible at `packages/core/src/release/invariants/__tests__/archive-reason-invariant.test.ts`. **Likely shipped** — needs verification. |

**Net**: All 6 T-INV tasks shipped in v2026.4.145/146 but never closed in the task DB. **This is the canonical case the T-INV epic itself was designed to prevent** — a striking proof-of-need. The reconciliation CLI exists (T1411) but has not been run for these 6 tasks.

### 2.4 T1242-T1244 — GAPs Blocking Dogfooding

| ID | Title | Status | Stage | Verified |
|----|-------|--------|-------|----------|
| T1242 | `cleo init` force-reinstall agents at project tier | pending | research | **Not shipped**. `seed-install.ts` does not call `agent install --force` per .cant. |
| T1243 | `cleo upgrade` agent registry reconciliation | pending | research | **Not shipped**. `cleo upgrade` has 7 actions, none touch registry. |
| T1244 | worktree provisioning needs initial commit on fresh git init | pending | research | **Not shipped**. `init.ts` does not run `git commit --allow-empty` for unborn HEAD; D-003 / WARN fallback fires on every fresh project. |

**These three GAPs each produce reproducible new-project D-003 errors or worktree fallbacks**. T1242 + T1243 are coupled (both write to signaldock.db). T1244 is independent. All three are **small/medium**.

### 2.5 T1538-T1541 — ADR-058 Dispatch Migration

| ID | Title | Status | Stage | Cast count today |
|----|-------|--------|-------|-----------------|
| T1538 | orchestrate.ts → OpsFromCore | pending | implementation | **47 casts** at HEAD; 1431 LOC handler; not migrated. |
| T1539 | IVTR dispatch → OpsFromCore + extract next/loop-back to Core | pending | implementation | 7 casts; 536 LOC; partial. |
| T1540 | Extract orchestrateClassify (116 LOC) + orchestrateFanout (76 LOC) into Core | pending | implementation | Both still inline in `orchestrate.ts`. |
| T1541 | Extract verify.explain → Core `checkExplainVerification()` | pending | implementation | Logic still in `cleo/src/cli/commands/verify.ts`; Core has no `checkExplainVerification`. |

**These are real outstanding work**, unlike most T896-T909. T1538 is the largest residual ADR-058 gap, since release + orchestrate are the only two domains where the migration has not landed (per Teammate-2 audit T1522).

---

## 3. Cross-Cutting Concerns

### 3.1 T1131 — Verify Conduit Messaging End-to-End (Phase 4)
- **Status**: `done`. `completedAt: 2026-04-28T22:03:51Z`, `pipelineStage: contribution`, all gates green.
- The conduit-orchestration wiring deliverable exists at `.cleo/agent-outputs/conduit-orchestration-wiring.md`.
- Bridge from orchestration to conduit substrate: complete in dispatch (`orchestrate.ts` exposes `conduit-status|peek|start|stop|send`), and operations registry was patched in `b696bdb88` for T1411 follow-up.

### 3.2 T1139 — BRAIN Auto-Reconcile (Semantic Conflict Detection)
- **Status**: pending (stage=implementation). Owner-flagged 2026-04-21 as "missing half of T-BRAIN-LIVING".
- Code state: `core/src/reconciliation/` exists (with tests). Hebbian plasticity (step 1) shipped. Step 2 (semantic conflict + auto-supersession) is not yet wired, despite stage being `implementation`. AC count: 12 — large surface.
- **Bridges orchestration to BRAIN**: when an `executePlaybook` run produces a decision via memory-bridge, the reconciliation pass MUST run, otherwise contradictory active decisions surface to future agents.

These two are the orchestration-to-substrate bridges. T1131 closes the conduit one. T1139 leaves the BRAIN one open.

---

## 4. Priority-Ranked Task List

### P0 — block dogfooding now
1. **T1244** — worktree provisioning on fresh git init (`small`). Hits **every** new project's first spawn. Trivial fix (`git commit --allow-empty` in init.ts).
2. **T1242** — `cleo init` force-reinstall agents at project tier (`medium`). Produces 4 D-003 errors per fresh init.
3. **T1243** — `cleo upgrade` agent registry sync (`medium`). Same surface; required for migration ergonomics.
4. **Reconcile T1408-T1413 in DB** (`small`, ops). Run `cleo reconcile release --tag v2026.4.146` to close T1408-T1413. Single command.

### P1 — finish ADR-058 migration + close T908/T904 closure
5. **T1538** — orchestrate.ts OpsFromCore migration (`large`). 47 casts; 1431 LOC; primary remaining ADR-058 gap.
6. **T1540** — extract `orchestrateClassify` (116 LOC) + `orchestrateFanout` (76 LOC) to Core (`medium`). Mandatory thin-dispatch compliance per T1492.
7. **Reconcile T896-T909 in DB** (`small`, ops). 14 tasks shipped but pending. Each needs a `cleo verify` evidence pass + `cleo complete`. Recommend single audited script.
8. **T1139** — BRAIN auto-reconcile (`large`). Stage=implementation already; needs conflict-detection + auto-supersession wiring.

### P2 — Tier-3 merge ritual + verify.explain extraction
9. **T1029 / T1030 / T1032** — Sentient Tier-3 abort + merge ritual + integration test. Spec exists (DESIGN.md §8); commit `8dfe36209` is suspect/partial. Re-establish status.
10. **T1539** — IVTR dispatch OpsFromCore (`large`). 7 casts but `core/src/lifecycle/ivtr-loop.ts` already exists; lower risk.
11. **T1541** — extract `verify.explain` to Core (`medium`). Cleanup; no behavior change.

### P3 — observability + worker hardening
12. **T1135** — vendor-agnostic agent event bus (`medium`). Owner-flagged after a runaway worker shipped 4 versions unilaterally — preventable.
13. **T1137** — worker runaway prevention + scope boundary enforcement (`medium`). Companion to T1135. Cuts blast radius of any single agent.
14. **T1464** — per-worktree node_modules bloat investigation (`medium`). Spike to measure ext4 baseline + decide isolated-linker vs symlink-shared strategy.
15. **T1110 / T1111 / T1112** — sandbox proofs. T1110 has gates I=true Q=true already. T1111 / T1112 pending.

---

## 5. Deep Findings

### Finding 1: T908 (HITL gates) is operational but task is `pending`
**Evidence**: `cleo orchestrate pending` returns `{success:true, approvals:[]}` at HEAD; `cleo orchestrate approve --help` shows the full subcommand surface; `packages/playbooks/src/approval.ts` implements HMAC-SHA256 token binding; `tasks.db.playbook_approvals` table exists; commit `3f9abc99c` is "feat(T935): cleo playbook CLI + orchestrate approve/reject/pending".

The 9-AC list on T908 is satisfied: `requires_approval` flag (✓), `{status:'needs_approval', resumeToken,...}` (✓), `cleo orchestrate approve --token` (✓), `cleo orchestrate reject --reason` (✓), `cleo orchestrate pending` (✓), `playbook_approvals` audit table (✓), policy DSL (`packages/playbooks/src/policy.ts`, ✓), and pause/approve/resume + reject tests in `__tests__/orchestrate-approval.test.ts` (13 tests).

**Action**: file an explicit verification gate sweep — every gate `requires_evidence`. T908 is **safe to close** with `commit:3f9abc99c;files:packages/playbooks/src/approval.ts,packages/cleo/src/dispatch/domains/playbook.ts` + `tool:test` evidence.

### Finding 2: T-INV epic shipped but did not self-enforce on itself
**Evidence**: All six T1408-T1413 tasks remain `pending`. Yet:
- `5153dd477 feat(T1408): migrate archive_reason TEXT → 6-value enum + CHECK constraint`
- `ee0e55592 feat(T1410): commit-msg lint requiring T-IDs in release commits`
- `a10994cc5 feat(T1411): registry-driven 'cleo reconcile release' post-release invariants gate`
- `c4b9b27ea docs(T1412): ADR-056 DB SSoT, naming convention, release-completion invariant`
- v2026.4.145 commit `cc655cd48` calls out "T1408/T1409 archive-reason follow-through"
- v2026.4.146 commit `e14a9fe53` calls out "T1411 registry-driven release invariants gate"

This is the **canonical demonstration of the failure class T1407 was created to fix** — invariant code was shipped, but the very tool that auto-completes pending tasks on tagged release was the artifact being shipped. The chicken-and-egg is genuine: T1411 can't reconcile its own release. **Immediate fix**: run `cleo reconcile release --tag v2026.4.146` manually with evidence atoms; this is the proof of correctness for T1411 + closure for T1408-T1413 in one shot.

### Finding 3: T1244 (worktree on unborn HEAD) is unfixed and reproducibly hits every fresh project
**Evidence**: `grep` for `allow-empty` / `unborn` against `packages/cleo/src/cli/commands/init.ts` and `packages/core/src/spawn/` returns **zero matches** in production code (only test fixtures and revert-executor). Owner verification (in T1244 description, v2026.4.112): `mkdir /tmp/fresh && cd /tmp/fresh && git init && cleo init && cleo orchestrate spawn T_any` produces "fatal: invalid reference: main" and falls back to no-isolation with WARN. This is on the critical path for new-project dogfooding and tutorials.

**Action**: P0. Add `git commit --allow-empty -m 'initial: cleo init'` to `init.ts` post-scaffold step when `git rev-parse --verify HEAD` fails. Test: `mkdir /tmp/fresh && git init && cleo init && cleo orchestrate spawn <id>` must succeed without WARN.

### Finding 4: orchestration-flow.md still calls 5 commands "Planned (T935)" though they are live
**Evidence**: Lines near tail of `docs/architecture/orchestration-flow.md` contain a table where `cleo playbook run/status/resume`, `cleo orchestrate approve/reject/pending` are labelled `Planned (T935)`. But T935 commit `3f9abc99c` shipped them, and runtime invocation confirms they work.

**Action**: small doc patch. Could be folded into T896 closure.

### Finding 5: dispatch/orchestrate.ts is the largest remaining ADR-058 gap
**Evidence**: 1431 LOC, 47 type-cast occurrences (`as Record|string|number|boolean|unknown|[A-Z]`). Sibling `pipeline.ts` (1054 LOC) shipped clean OpsFromCore migration in T1441. `release.ts` (214 LOC) has 4 casts and **no** `releaseCoreOps` declaration in `core/src/release/`. The Teammate-2 audit (T1522) flagged this as a P1 RED.

**Action**: T1538 is correctly scoped. Teammate-2 also recommends T1540 (extract `orchestrateClassify` + `orchestrateFanout`) as a prerequisite — completing both as a wave is cleaner than serial.

### Finding 6: Tier-3 merge ritual code state is inconsistent with task state
**Evidence**: Commit `8dfe36209` is titled "feat(T1074+T1030): state-pause subsystem + Tier 3 merge ritual orchestrator", suggesting T1030 (10-step orchestrator) shipped. But `core/src/sentient/` directory contains `merge.ts` only — no `experiment-runner.ts` or `abort.ts` per the AC. T1029 spec states: "Write packages/core/src/sentient/abort.ts exporting abortExperiment(abortCtx)" — file does not exist at HEAD.

**Action**: Either commit `8dfe36209` regressed, or the AC was changed. Audit-driven status reconciliation needed before re-implementing.

---

## 6. Recommendations to Operator

### Top 5 Concrete Actions

1. **P0 — Fix the three GAPs (T1242, T1243, T1244) as one wave**. They are small/medium each, all currently force every fresh CLEO project to reproduce an error that prevents clean dogfooding. T1244 is a 5-line edit to `init.ts`. T1242 + T1243 share the same `agent install --force` plumbing. Estimated total: 1 day. **This unblocks new-project demos and tutorials.**

2. **P0 — Run `cleo reconcile release --tag v2026.4.146`** with proper evidence atoms to close **T1408-T1413** (the T-INV epic). This is a single CLI invocation if T1411 is correct. It is also the live proof-of-correctness for the post-release invariant gate. **Side effect**: catches ~13 additional shipped-but-pending tasks across recent releases (v2026.4.142 through v2026.4.154) per the recent commit log. File a dedicated reconciliation-pass session.

3. **P1 — Close T896-T909 wave with a single audited evidence pass**. 14 tasks shipped to head; running a doctor script to (a) `cleo verify <id> --evidence "commit:<sha>;files:<list>"` per task, (b) `tool:test`, (c) `cleo complete <id>` cleans the entire epic in one orchestrator session. Ship a 5-line doc patch for T896 to remove "Planned (T935)" mislabels in the same PR. **Side effect**: the cleo dashboard becomes accurate for the Orchestration Coherence v3 epic for the first time since v2026.4.86.

4. **P1 — Finish ADR-058 with T1538 + T1540 as a paired wave**. orchestrate.ts (47 casts, 1431 LOC) is the only large dispatch domain not yet migrated. Extracting `orchestrateClassify` (116 LOC) and `orchestrateFanout` (76 LOC) to `core/orchestration/` first reduces orchestrate.ts to ~1240 LOC, then OpsFromCore migration is straightforward (mirror T1441 / pipeline.ts pattern). Pair with T1539 (IVTR — only 7 casts) for completeness. **Side effect**: fully closes ADR-058 epic.

5. **P2 — Reconcile Sentient Tier-3 status before continuing T1029/T1030/T1032**. Investigate commit `8dfe36209` to determine whether T1030 (experiment-runner.ts) was reverted, refactored, or never merged. The `core/src/sentient/abort.ts` and `experiment-runner.ts` files do not exist at HEAD despite the commit title. This is a pre-execution audit, not implementation work. Without it, agents will waste capacity re-implementing already-shipped logic.

---

## Appendix A — Evidence Index

| Claim | Evidence atom |
|-------|---------------|
| HITL approve/reject/pending live | `cmd:cleo orchestrate pending` returns success envelope at HEAD `fd395af0f` |
| Playbook runtime shipped | `files:packages/playbooks/src/{runtime,approval,parser,policy,state,schema}.ts` + 18 dispatch tests |
| ADR-053 accepted | `files:docs/adr/ADR-053-playbook-runtime.md` 263 LOC, status "Accepted (2026-04-18)" |
| orchestration-flow doc shipped | `files:docs/architecture/orchestration-flow.md` 298 LOC, includes Mermaid |
| T1408 migration shipped | `commit:5153dd477` |
| T1410 commit-msg lint shipped | `commit:ee0e55592` |
| T1411 reconcile CLI shipped | `commit:a10994cc5` (v2026.4.146) |
| T1412 ADR-056 shipped | `commit:c4b9b27ea` |
| T1244 unfixed | `grep:allow-empty packages/cleo/src/cli/commands/init.ts` returns no match |
| orchestrate.ts cast count | `grep -cE "as (Record|string|number|boolean|unknown|[A-Z])" packages/cleo/src/dispatch/domains/orchestrate.ts` = 47 |
| Teammate-2 audit corroboration | `files:.cleo/agent-outputs/AUDIT-DOMAINS-2026-04-28/T2-orchestration-pipeline.md` |
| Teammate-7 playbook audit | `files:.cleo/agent-outputs/AUDIT-DOMAINS-2026-04-28/T7-playbook-release-ui.md` |
| T1131 conduit done | `cleo show T1131` → completedAt 2026-04-28T22:03:51Z |
| T910 archived | `cleo show T910` → status archived |
| seed-agents unification (T905) | `files:packages/cleo-os/seed-agents/README.md` is now redirect stub |

## Appendix B — Pending-vs-Shipped Tally

| Bucket | Pending in DB | Actually shipped at HEAD |
|--------|---------------|-------------------------|
| T896-T909 (Orchestration Coherence v3 closure) | 14 | 12 fully + 2 partial |
| T1408-T1413 (T-INV release invariant) | 6 | 6 fully |
| T1242-T1244 (GAPs) | 3 | 0 |
| T1538-T1541 (ADR-058 dispatch) | 4 | 0 (work not started, except partial typed casts in IVTR) |
| T1029-T1032 (Tier-3 merge ritual) | 3 | 0 confirmed (commit `8dfe36209` claims partial, not visible at HEAD) |
| T1110-T1112 (proofs) | 3 | T1110 partial (gates I=T Q=T) |
| T1131 (conduit phase 4) | 0 | 1 closed today |
| T1139 (BRAIN auto-reconcile) | 1 | 0 (stage=implementation in progress) |
| T1464 (worktree perf) | 1 | 0 (research only) |

**Net actionable**: ~10 GAPs require code, ~22 tasks require closure ritual. The 22 closure-ritual tasks should run as one batched audited pass, not 22 separate sessions.
