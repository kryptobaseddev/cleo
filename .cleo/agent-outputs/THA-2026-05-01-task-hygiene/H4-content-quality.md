# H4 Audit: Acceptance Criteria + Content Quality

**Date**: 2026-05-01  
**Auditor**: Read-only audit subagent (H4)  
**Scope**: Pending tasks, priority critical/high (primary) + medium (secondary sample)

---

## Executive Summary

**Sample size**: 150 tasks sampled — 78 high/critical (76 valid) + ~50 medium priority pending tasks.  
Within the 76 valid high/critical records: 55 type=task, 13 type=epic, 8 type=subtask/null.

**Overall finding**: The task graph has a bimodal quality split.

- **Cohort A — Implementation-ready tasks** (e.g., T1057-T1073, T1408-T1413, T1029-T1032): Strong, specific, testable AC entries. Descriptions sometimes absent but AC compensates with exact file paths, function names, and numeric assertions. These tasks can ship to workers today.
- **Cohort B — Architectural/epic tasks** (e.g., T897-T908, T923-T925, T945-T946): AC is often too broad for an implementation gate. High Q2/Q3 counts, no files scope (Q4), and in some cases AC entries contradict or fail to operationalize the description (Q3/Q6).

**Defect counts by class (high/critical sample):**

| Class | Count | Severity |
|-------|-------|----------|
| Q1: Missing AC (type=task) | 0 | — |
| Q2: Vague AC | 12 entries across 8 tasks | Medium |
| Q3: Untestable AC | 8 entries across 7 tasks | High |
| Q4: Missing files scope (type=task) | 21 tasks | Medium |
| Q5: Missing description (all types) | 17 tasks (EP-series) | Medium |
| Q6: AC/description mismatch | 3 tasks | Medium |
| Q7: Stale stage (pending in contribution/implementation/release/testing) | 7 tasks | High |

---

## Q1: Missing Acceptance Criteria

Tasks of `type=task` with zero AC entries in the high/critical sample: **0**.

All sampled tasks have at least 3 AC entries. Q1 is a non-issue for high/critical priority tasks.

Medium sample: Zero tasks of type=task with missing AC.  
Exception: T800 (type=epic, medium, description="Description for T800", no AC — clearly a test artifact).  
T1335, T1364, T1367 (imported tasks, no type, no AC) — appear to be import artifacts with placeholder data.

---

## Q2: Vague Acceptance Criteria

AC entries that are too generic to constitute a verifiable signal (< 20 chars without specific verb-noun, or unmeasurable quality claims):

### T919 — G1: Fix GH issue #94 — task auto-complete inconsistency
- **Vague**: `"Policy decision documented"` — No assertion on WHERE it is documented, what format, or which policy was chosen.
- **Vague**: `"gh issue #94 closed"` — Closing a GitHub issue is not an engineering assertion; it is an artifact of the work, not a verification of correctness.

### T923 — E1c: cleo-sandbox harness — codex cli
- **Vague**: `"sandbox-install wires codex"` — "wires" has no verifiable meaning. What command? What output? What verification?

### T925 — E1e: cleo-sandbox harness — cursor
- **Vague**: `"decision recorded"` — No specification of where, in what format, or verifiable by whom.

### T913 — E2a: scenario — corrupted-db-recovery
- **Vague**: `"no crash"` — A negative assertion with no observable success criterion. What IS the expected output? What does "degraded" look like beyond exit code?

### T1493 — T-FU12 document SDK consumer dep boundary brain agents cant
- **Vague**: `"biome or lint rule enforces"` — Enforces WHAT, specifically? The rule name and the exact violation it catches are unspecified.

### T1494 — T-FU13 harden core public API surface remove internal wildcards
- **Vague**: `"forge-ts validates public surface stable"` — "stable" is undefined. What does forge-ts output when it passes? What assertion is being made?

### T1532 — Iterate on dialectic evaluator: add few-shot examples + tune confidence thresholds
- **Vague**: `"confidence threshold rationale documented in JSDoc"` — Documentation quality is inherently unmeasurable. What threshold values? What benchmark results triggered the change?

### T1620 — T-FOUND-V3-2: hotfix release ship auto-adds CHANGELOG section
- **Vague**: `"Hotfix ship auto-adds CHANGELOG section"` — Restates the task title. No assertion on format, content, or where it is added.

---

## Q3: Untestable Acceptance Criteria

AC entries that lack a verifiable signal and need operationalization:

### T919 — G1: Fix GH issue #94 — task auto-complete inconsistency
- **Untestable**: `"uniform behavior across docs/CLI/code tasks"` — "Uniform" is not testable without specifying the exact behavior contract.
- **Suggested rewrite**: `"Given a task with all gates verified (implemented=true, testsPassed=true, qaPassed=true), cleo complete <id> produces success=true without a second explicit call; verified via test fixture with types=[task, doc, code]"`

### T925 — E1e: cleo-sandbox harness — cursor
- **Untestable**: `"README explains cursor sandbox constraints"` — Content quality of a README is not programmatically verifiable.
- **Suggested rewrite**: `"README contains section 'Cursor Constraints' documenting at minimum: (1) why full harness is not possible, (2) what alternative exercise path was chosen"`

### T946 — Autonomous Self-Improving Loop — Tier1/2/3
- **Untestable**: `"Tier1 daemon executes unblocked tasks autonomously with gate enforcement"` — Far too broad. No integration test, no assertion boundary, no scope.
- **Suggested rewrite**: `"cleo sentient start runs and processes ≥1 unblocked task from the queue; evidence: task transitions from pending→done with gate evidence logged in .cleo/audit/"`
- **Untestable**: `"Every merge has Ed25519 signed AgentSession receipt (audit ledger)"` — No specification of WHERE to verify the signature or HOW to audit.

### T945 — Universal Semantic Graph
- **Untestable**: `"Studio graph view consumes this unified graph"` — No performance metric, no data-completeness assertion, no screen/API contract.
- **Suggested rewrite**: `"GET /api/v1/graph returns nodes with type in [task, decision, observation, symbol, conduit_message]; verified by integration test with seed data"`

### T1493 — T-FU12 document SDK consumer dep boundary brain agents cant
- **Untestable**: `"cleo-os and Studio package.json comments cite policy"` — Code comments are not enforced by any gate.

### T1532 — Iterate on dialectic evaluator
- **Untestable**: `"evaluateDialectic integration test covers low-confidence edge cases"` — No assertion on what "low-confidence" means numerically or what the test asserts.
- **Suggested rewrite**: `"evaluateDialectic integration test passes for input with confidence < 0.3 and asserts fallback returns null (not throws)"`

### T927 — G3: Fix double-JSON envelope in cleo CLI output
- **Borderline untestable**: `"docs updated if behavior changed intentionally"` — Conditional AC cannot be verified programmatically.

---

## Q4: Missing Files Scope

Tasks with `type=task` and `files=[]` in the high/critical sample. The atomicity gate requires files for workers (ENG-MIG precedent). Workers without files context must guess scope.

**21 tasks missing files scope (all high priority):**

| Task | Title |
|------|-------|
| T1009 | Tier 3 infra — agent-in-container sandbox harness + network-none patch generation |
| T1010 | Tier 3 — Externally-anchored baseline + signed llmtxt/events audit |
| T1011 | Tier 3 — FF-only merge with abort-on-fail + per-step kill-switch re-check |
| T1012 | Tier 3 — cleo revert --from kill-switch + audit chain walker |
| T897 | Seed-agent auto-install — populate install/upgrade |
| T898 | Registry-backed persona resolution — classify(task) |
| T899 | Global→project→packaged tier precedence in persona resolution |
| T900 | cleo agent install/attach → spawn integration |
| T902 | Dynamic skills composition |
| T903 | CANT DSL v3 — formal types + requires/ensures contracts |
| T904 | Playbook DSL (.cantbook) — state-machine runbooks |
| T905 | Refactor: unify seed-agents source |
| T906 | agent_skills table → spawn integration |
| T907 | Thin-agent runtime enforcement |
| T908 | Resume tokens + HITL gates |
| T923 | E1c: cleo-sandbox harness — codex cli |
| T925 | E1e: cleo-sandbox harness — cursor |
| T927 | G3: Fix double-JSON envelope in cleo CLI output |
| T945 | Universal Semantic Graph — promote brain_page_nodes |
| T946 | Autonomous Self-Improving Loop — Tier1/2/3 |
| T1600 | T-FOUND-7B: Expand cleo briefing to full handoff replacement |

**Note**: Many of these are high-scope architectural tasks (e.g., T902-T908) where multiple new files are expected to be created, not modified. The absence of files is understandable for "new module" tasks but still blocks the atomicity gate — the AC should state the expected output file paths.

---

## Q5: Missing Description

Tasks with empty (`""`) description field:

### High/Critical — 17 tasks (all "EP-series" Nexus epic workers)

These 17 tasks (T1057-T1073) are children of the EP1/EP2/EP3 Nexus epic. They all have strong, specific AC but no description at all. The title and AC together provide enough context for a worker, but description provides essential narrative context (why this exists, design constraints, prior art).

| Task | Title |
|------|-------|
| T1057 | EP1-T1: SQLite Recursive CTE Query DSL |
| T1058 | EP1-T2: Semantic Code Symbol Search |
| T1059 | EP1-T3: Source Content Retrieval |
| T1060 | EP1-T4: Wiki Generator |
| T1061 | EP1-T5: Hook Augmenter (PreToolUse) |
| T1062 | EP2-T1: External Module Nodes (IMPORTS persistence) |
| T1063 | EP2-T2: Leiden Community Detection + member_of edges |
| T1064 | EP2-T3: Route-Map and Shape-Check Commands |
| T1065 | EP2-T4: Contract Registry |
| T1066 | EP3-T1: Complete BRAIN→NEXUS Edge Writers |
| T1067 | EP3-T2: TASKS→NEXUS Bridge (task_touches_symbol) |
| T1068 | EP3-T3: Living Brain SDK Traversal Primitives |
| T1069 | EP3-T4: Extended Code Reasoning (why + impact-full) |
| T1070 | EP3-T5: Sentient Nexus Ingester Extensions |
| T1071 | EP3-T6: Conduit→Symbol Ingestion Pipeline |
| T1072 | EP3-T7: Hebbian BUG-2 Fix + STDP Wire-Up |
| T1073 | EP3-T8: IVTR Breaking-Change Gate |

### Medium Priority — 9 additional tasks with empty descriptions

T1531, T1532, T1533, T1534, T1540, T1544, T1545, T1546, T1547 — all in implementation or contribution stage. These have AC but no description. Given their stage (implementation), they were likely created quickly during a decomposition wave. AC is sufficient for most of them (T1540, T1544, T1546, T1547 have specific AC), but T1531-T1533 have vague AC AND no description — doubly problematic.

### Test/Import Artifacts (should be archived or ignored)

T036-T047, T800, T1335, T1364, T1367 — placeholder/dummy/imported tasks with no type, no AC, empty or single-word descriptions. These are noise in the task graph.

---

## Q6: AC/Description Mismatch

### T1215 — MIG-LINT-03: D — Implement chosen approach
- **Description says**: "Land the chosen solution. Likely small config change..."
- **AC says**: `"Code change implements the MIG-LINT-02 decision"`, includes commit evidence requirements, CI gates
- **Stage**: `research` — but AC is clearly implementation-level. The mismatch is between stage=research and implementation-level AC + description. **The task content is implementation but the pipeline stage is wrong** (see Q7).

### T1232 — PRE-WAVE: CLEO Agents Architecture Remediation
- **Description says**: "OWNER-MANDATED 2026-04-22: Fix agents architecture NOW before any v2026.4.110 work."
- **Stage**: `release` — but task is still pending. AC includes `"v2026.4.110 tagged + published + globally installed"`. The task appears to describe pre-wave setup work but the stage claims it is in release. Either the task was not completed when the release happened, or the stage advanced incorrectly.

### T919 — G1: Fix GH issue #94
- **Description says**: decide between two policies (auto-complete on final gate, OR warning when gates-green). 
- **AC says**: `"gh issue #94 closed"` — The issue resolution is framed as the acceptance criterion, but closing a GitHub issue does not verify the policy was implemented correctly. No AC entry checks behavior of the implementation directly.

---

## Q7: Stale Pipeline Stage

Tasks still `status=pending` but in late pipeline stages (implementation, contribution, testing, release):

### Critical/High priority:

| Task | Stage | Title | Issue |
|------|-------|-------|-------|
| T1619 | contribution | T-FOUND-V3-1: commit-msg 50-char cap rejects orchestrator merge messages | In contribution stage but pending — was work partially done and not completed? |
| T1622 | implementation | T-FOUND-1C: Doctrine cleanup — purge legacy cherry-pick references | AC involves code changes + tests; stage advanced to implementation but task is still pending |
| T990 | contribution | EPIC: Studio UI/UX Design System redesign | Critical epic in contribution stage with 14 AC entries — was partially shipped? |
| T1232 | release | PRE-WAVE: CLEO Agents Architecture Remediation | In release stage but pending — this is the most concerning case (release = almost done?) |
| T1461 | testing | Disk-space hygiene: orchestrate worktree leak | Reached testing stage but still pending |
| T1563 | implementation | Audit-driven execution master epic | Master coordination epic in implementation — children may be progressing but epic not closed |
| T1586 | implementation | T-FOUNDATION-LOCKDOWN | In implementation stage, still pending |

### Medium priority:

10 additional medium tasks (T1531, T1532, T1533, T1534, T1540, T1544, T1545, T1546, T1547, T1491) are in implementation or contribution stage but pending. Many have empty descriptions (double defect).

**Most concerning**: T1232 at stage=release is the clearest staleness signal. A task at release stage should either be completing or already done. If it was abandoned mid-release, it creates a dangling state that confuses pipeline metrics.

---

## Epic AC Review

Sample of 5 active epics reviewed for AC roll-up quality:

### T1407 — Epic: Self-enforcing release-completion invariant (stage=decomposition)
**Verdict: GOOD.** Epic AC precisely rolls up its 6 children (T1408-T1413): migration (T1408), enum promotion (T1409), lint rule (T1410), reconcile hook (T1411), ADR (T1412), tests (T1413). AC is specific and matches child scope.

### T1054 — Nexus P0: Core Query Power (stage=null)
**Verdict: ADEQUATE but thin.** 5 AC entries roll up T1057-T1061 (5 children). Each AC entry is one line summarizing a child. Testability is implied but not explicit — the epic AC itself does not define an integration-level test that verifies all 5 children work together.

### T1135 — CLEO-OBSERVABILITY: vendor-agnostic agent event bus (stage=research)
**Verdict: PREMATURE AC.** Epic AC contains implementation-level assertions (`cleo event append` SDK op, heartbeat protocol, Conduit-backed transport) but the stage is research. The AC reads like an implementation spec, not a research output. If the epic is still in research, the AC should define what the research phase produces (e.g., "Architecture decision document with tradeoff analysis and chosen transport mechanism").

### T889 — EPIC: Orchestration Coherence v3 (stage=null)
**Verdict: KITCHEN SINK.** 18 AC entries cover everything from registry SSoT to AGENTS.md dedup to database topology. This epic is a parent meta-epic covering T897-T908. The AC is comprehensive but too monolithic for verification — no single verifiable signal captures the full epic state. The last AC (`"T882 spawn-prompt.ts is either the single spawn path OR deprecated+replaced — research phase decides"`) is explicitly conditional, which means it cannot be verified deterministically.

### T942 — Sentient CLEO Architecture Redesign (stage=null, critical)
**Verdict: ADEQUATE as meta-epic.** 7 AC entries roll up 6 child epics. Each line references a concrete deliverable. However, 3 entries are themselves epics (`"All 6 child epics shipped with evidence gates"`) — the epic AC is implicitly delegated to children, which is correct for a meta-epic but means T942 itself cannot be directly verified until all children complete.

---

## Top-10 Priority Remediation List

Ranked by: blocking impact + highest priority + most worker-disrupting defects.

| Rank | Task | Priority | Issue | Action |
|------|------|----------|-------|--------|
| 1 | **T1232** | critical | Stage=release but pending — dangling release state confuses pipeline | Determine if this was shipped (verify v2026.4.110 release tags) and archive or reset stage |
| 2 | **T946** | high | Untestable AC, no files scope, epic-level scope as type=task | Decompose into child tasks OR rewrite AC with specific integration test assertions + add expected output files |
| 3 | **T945** | high | Untestable AC ("Studio graph view consumes this unified graph"), no files scope | Operationalize AC with API contract assertions + add expected modified file paths |
| 4 | **T1563** | critical | Epic in implementation stage, pending — master epic for the audit-driven work | Verify child task completion state; if children are done, close this epic |
| 5 | **T1586** | critical | Epic in implementation stage, pending — foundation lockdown layer | Same: check child tasks, advance or close |
| 6 | **T919** | high | Circular AC ("gh issue #94 closed"), untestable AC ("uniform behavior") | Rewrite AC with observable behavior assertions for auto-complete policy |
| 7 | **T923 + T925** | high | Vague AC ("sandbox-install wires codex", "decision recorded"), no files scope | Add specific commands, expected output, file paths to AC |
| 8 | **T1057-T1073** | high | 17 tasks with empty descriptions (EP-series nexus workers) | Add 2-3 sentence description per task explaining design rationale and cross-system context |
| 9 | **T1215** | medium | Stage=research but AC is implementation-level (code change, commit evidence) | Advance stage to implementation OR separate the research and implementation phases |
| 10 | **T897-T908** | high | All 12 orchestration coherence tasks missing files scope | Add expected output file paths to each task AC (new modules at packages/agents/, packages/cant/, packages/playbooks/, etc.) |

---

## Notes and Limitations

1. **EP-series (T1057-T1073)** are systematically missing descriptions but have strong AC — this is a creation-time omission, not a quality failure. They are ready to ship to workers as-is but would benefit from description additions.

2. **Q4 (missing files)** is less critical for tasks that are creating NEW modules (vs. modifying existing ones). Tasks like T902-T908 are greenfield implementations where the AC itself specifies the output files (e.g., `packages/core/src/orchestration/skill-composer.ts`). The AC serves as the files specification in these cases.

3. **Test/import artifact tasks** (T036-T047, T800, T1335, T1364, T1367, W3T2, W3T3) are clearly not real work items. They add noise but are low risk since they have no AC or files to confuse workers.

4. **Stage=null** on many pending tasks is expected — these are tasks that have not yet been added to an active epic pipeline. It is NOT a defect unless the task was manually advanced and then abandoned.
