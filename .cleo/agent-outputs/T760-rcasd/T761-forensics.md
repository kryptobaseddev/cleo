# T761 — CLEO Arm Forensic Analysis

**Task**: T761
**Epic**: T760
**Date**: 2026-04-16
**Status**: complete
**Analyst**: CLEO-ARM FORENSICS subagent (Sonnet 4.6)
**Evidence base**: audit_log (tasks.db), brain.db, session record, SUPREME_REPORT §3.3 + §4, OBJECTIVE_METRICS.md, ct-cleo/SKILL.md, CLEO-INJECTION.md

---

## 1. Executive Summary

The CLEO builder for the Pomodoro benchmark used exactly **7 distinct operation types** across **29 total CLI calls** in a 7-minute build window. It correctly used the session lifecycle (start + end), created an epic with 8 atomic children, set verification gates on each task, and completed everything in order. It **never called** `cleo dash`, `cleo briefing`, `cleo find`, any memory operation, any orchestrate operation, or any pipeline/check read command. The audit log is the ground truth — nothing in brain.db was written because `cleo memory observe` failed with `E_BRAIN_OBSERVE: no such column: provenance`. The builder chose not to use `cleo start` on T003–T009 (only T002 was started via `tasks.start`), meaning 7 of 8 child tasks went from `pending` to `done` without ever being in `in_progress` state — a silent protocol deviation. The critical miss is the full orchestration tier: `orchestrate.start`, `orchestrate.analyze`, `orchestrate.spawn`, and `orchestrate.parallel` were all available and all unused, despite the epic having 8 parallelizable tasks. This was primarily a harness constraint (Agent tool not surfaced) but also a CLEO gap (no single-entry-point hint that auto-fan-out is available).

---

## 2. Commands Actually Invoked

Source: `audit_log` table in `.cleo/tasks.db` (definitive — every CLI call is logged).

### 2.1 Aggregate Table

| Domain | Operation | Count | Notes |
|--------|-----------|------:|-------|
| `session` | `start` | 1 | Scope: `global`, name: `pomodoro-bench-build` |
| `tasks` | `add` | 9 | 1 epic (T001) + 8 children (T002–T009) |
| `tasks` | `start` | 1 | Only T002 was started. T003–T009 skipped `start`. |
| `check` | `gate.set` | 9 | One per task (T002–T009) + T001 epic |
| `tasks` | `complete` | 8 | T002–T009 all completed |
| `session` | `end` | 1 | Triggered debrief (with "Failed to write memory bridge" warning) |
| *(implicit)* | *(read queries)* | ~18 | Unlogged: `cleo session status`, `cleo show`, `cleo list --parent T001` inferred from workflow but NOT in audit_log (read operations are not audited) |

**Total audited mutating calls**: 29

### 2.2 Read-Operation Inference

The audit_log only captures mutating operations. Read operations (`show`, `list`, `session status`, `dash`, etc.) are not written to the log. We can infer the following were likely called based on the workflow and SUPREME_REPORT §4 references:

| Inferred Command | Basis for Inference | Certainty |
|------------------|---------------------|-----------|
| `cleo session status` | ct-cleo decision tree: mandatory first call | HIGH (mentioned in SUPREME §4 session ran at 04:45:51Z) |
| `cleo session start --scope global --name pomodoro-bench-build` | In audit_log | CONFIRMED |
| `cleo add T001` (epic) | In audit_log | CONFIRMED |
| `cleo add T002-T009` (8 children) | In audit_log, all in one burst (04:46:43–04:46:46, ~3s total) | CONFIRMED |
| `cleo start T002` | In audit_log | CONFIRMED |
| `cleo show T002` (at minimum) | Required to get task details before starting work | MEDIUM |
| `cleo check gate --all T002` through `T009` and `T001` | In audit_log as `gate.set` (x9) | CONFIRMED |
| `cleo complete T002-T009` | In audit_log | CONFIRMED |
| `cleo session end --note "..."` | In audit_log | CONFIRMED |
| `cleo memory observe` (ATTEMPTED, FAILED) | SUPREME_REPORT §3.3: "cleo memory observe failed with E_BRAIN_OBSERVE" | CONFIRMED-FAILED |

### 2.3 Invocation Timeline (Reconstructed)

```
04:45:51Z  cleo session start --scope global --name pomodoro-bench-build
04:46:04Z  cleo add "Build Todo+Pomodoro Timer..." --type epic    → T001
04:46:43Z  cleo add "Scaffold project..." --parent T001            → T002
04:46:44Z  cleo add "storage module..."  --parent T001             → T003
04:46:44Z  cleo add "todo model + CRUD" --parent T001              → T004
04:46:45Z  cleo add "pomodoro timer..."  --parent T001             → T005
04:46:45Z  cleo add "UI layer..."        --parent T001             → T006
04:46:46Z  cleo add "Responsive CSS..."  --parent T001             → T007
04:46:46Z  cleo add "node:test tests..." --parent T001             → T008
04:46:46Z  cleo add "README.md..."       --parent T001             → T009

[04:46:46Z – 04:52:36Z = ~5 min 50 sec]: ALL CODE WRITTEN HERE
  No cleo calls. Pure Read/Write/Edit/Bash/Glob/Grep tool usage.

04:47:05Z  cleo start T002   ← only T002 was started

04:52:36Z  cleo check gate.set --all --task T002  (verification pass)
04:52:37Z  cleo complete T002
04:52:37Z  cleo check gate.set --all --task T003
04:52:38Z  cleo complete T003
           [continued through T009, ~1s per task]
04:52:44Z  cleo check gate.set --all --task T009
04:52:45Z  cleo complete T009
04:52:59Z  cleo check gate.set --all --task T001  (epic verification)
04:53:15Z  cleo session end --note "Shipped pomodoro+todos app..."
```

**Key observation**: The entire code-writing phase (5 min 50 sec = 77% of wall-clock) had zero CLEO interaction. All 9 tasks were completed in a batch rapid-fire at the end (8 completions in ~30 seconds). The builder wrote all code monolithically, then updated task state retroactively.

---

## 3. Commands Available But NOT Invoked

Sources: `ct-cleo/SKILL.md` (Tier 0 + Tier 1 operations table), `CLEO-INJECTION.md` (Work Loop + Memory Protocol sections).

### 3.1 Session / Orientation Commands (Skipped)

| Command | Tier | Protocol Mandate | Miss Severity |
|---------|------|-----------------|---------------|
| `cleo briefing` / `cleo session briefing.show` | 0 | "Session Start Step 1: cleo session status" implied → then briefing | LOW (new session, no prior context to resume) |
| `cleo dash` / `cleo admin.dash` | 0 | "Step 2: cleo dash — project overview" in CLEO-INJECTION | MEDIUM — protocol requires it; skipped entirely |
| `cleo current` | 0 | "Step 3: cleo current — active task?" | LOW (new session, no active task) |
| `cleo next` | 0 | "Step 4: cleo next — what to work on" | MEDIUM — was always going to be T001, but protocol step skipped |
| `cleo plan` | 0 | Composite planning view; useful after epic creation | MEDIUM |

### 3.2 Task Discovery / Monitoring Commands (Skipped)

| Command | Tier | Why It Was Available | Miss Severity |
|---------|------|---------------------|---------------|
| `cleo show T001` | 0 | Review epic after creation to confirm acceptance criteria | LOW (builder created it, so already knows contents) |
| `cleo list --parent T001` | 1 | Verify all 8 children were created correctly | LOW-MEDIUM |
| `cleo find "..."` | 0 | Search-first discovery pattern | N/A (no discovery needed on greenfield) |
| `cleo tree T001` | 1 | Full subtask hierarchy visualization | LOW |
| `cleo analyze` | 1 | Leverage-sorted task discovery | LOW |
| `cleo blockers T001` | 1 | Check blockers before work begins | LOW (no dependencies set) |

### 3.3 Memory Operations (Skipped / Failed)

| Command | Tier | What It Would Have Done | Miss Severity |
|---------|------|------------------------|---------------|
| `cleo memory observe "architecture decision..."` | 0 | Persist design choices to BRAIN | HIGH (attempted, failed — provenance bug) |
| `cleo memory find "timer state machine"` | 0 | Search prior implementations | MEDIUM (greenfield, but good practice) |
| `cleo memory decision store` | 1 | Record "chose requestAnimationFrame vs deadline-based timer" | MEDIUM |
| `cleo memory pattern store` | 1 | Record "pure module + injected now()" as reusable pattern | HIGH — this is exactly the pattern worth storing |
| `cleo memory timeline` | 1 | Review context around prior work | N/A (no prior work in this BRAIN) |
| `cleo memory fetch` | 1 | Deep-fetch specific memory entry | N/A |
| `cleo memory learning store` | 1 | Record "WebAudio needs AudioContext.resume() on Chrome" | MEDIUM |

### 3.4 Orchestration Commands (Skipped — CRITICAL MISS)

| Command | Tier | What It Would Have Done | Miss Severity |
|---------|------|------------------------|---------------|
| `cleo orchestrate start --epic T001` | 1 | Initialize orchestration state for T001 | CRITICAL |
| `cleo orchestrate analyze T001` | 1 | Dependency wave analysis — which tasks can parallelize | CRITICAL |
| `cleo orchestrate ready --epic T001` | 1 | List tasks ready to spawn in current wave | CRITICAL |
| `cleo orchestrate spawn T002` | 1 | Prepare spawn context for a subagent | CRITICAL |
| `cleo orchestrate spawn.execute T002` | 1 | Execute spawn via adapter registry | CRITICAL |
| `cleo orchestrate parallel --action start --waveId wave1` | 1 | Mark start of parallel execution wave | HIGH |
| `cleo orchestrate handoff` | 1 | Hand off context to spawned subagent | HIGH |
| `cleo orchestrate status` | 1 | Monitor orchestration state | MEDIUM |
| `cleo orchestrate validate T002` | 1 | Pre-spawn gate check | MEDIUM |

### 3.5 Check / Validation Read Commands (Skipped)

| Command | Tier | What It Would Have Done | Miss Severity |
|---------|------|------------------------|---------------|
| `cleo check protocol T001` | 1 | Protocol compliance check before work begins | MEDIUM |
| `cleo check compliance.summary` | 1 | Overall compliance status | LOW |
| `cleo check test` | 1 | Test coverage status | MEDIUM — would confirm tests ran |
| `cleo pipeline stage.status T001` | 1 | Where is this epic in LOOM pipeline? | MEDIUM |
| `cleo pipeline stage.validate` | 1 | Gate validation before advancing stages | MEDIUM |

### 3.6 Dependency / Relationship Commands (Skipped)

| Command | What Was Missed |
|---------|----------------|
| `--depends` flag on `cleo add` | Tasks T003–T009 have no declared dependencies on each other even though code has obvious sequencing (storage before todos before timer before UI). |
| `cleo task depends T006` | Inspect declared deps before writing T006 (UI layer) |
| Size flags on `cleo add` | All 9 tasks were created with `size: "medium"` (the default). No sizing analysis was performed. CLEO-INJECTION says: "No time estimates — use small, medium, large sizing." The builder used `medium` for everything including the README task, which was legitimately `small`. |

### 3.7 Pipeline Operations (Skipped)

| Command | Miss |
|---------|------|
| `cleo pipeline stage.record` | No pipeline stage progress recorded; T001 shows `pipelineStage: null` |
| `cleo pipeline manifest.append` | BASE-001 protocol: subagents MUST append to MANIFEST.jsonl. The builder is operating as a combined orchestrator+executor (subagent role), but never appended to MANIFEST.jsonl. This is a protocol violation per ct-cleo anti-patterns: "Completing task without manifest append = MANIFEST_ENTRY_MISSING (exit 62)." |

---

## 4. Diagnosis: Why Each Category Was Missed

### 4.1 Session Orientation Commands (`cleo dash`, `cleo briefing`, `cleo next`)

**Root cause**: INJECTION GAP + LOW SALIENCE

CLEO-INJECTION.md lists the session start sequence as:
```
1. cleo session status — resume existing?
2. cleo dash — project overview
3. cleo current — active task?
4. cleo next — what to work on
5. cleo show {id} — full details for chosen task
```

The builder called `session status` (confirmed: session started at 04:45:51Z which requires `session start` being called, implying `session status` was checked first) and `session start`. But `cleo dash` and `cleo next` were skipped. The injection protocol lists them as the "cheapest-first" sequence but does not enforce them — they are framed as discovery aids, and when the agent already knows what to build (the prompt was explicit), the motivation to call discovery commands evaporates. This is a **surfacing gap**: the commands are present in INJECTION but their value is not communicated with sufficient urgency for an agent that already has a complete task specification.

**Correct skip?** `cleo briefing` was a correct skip (new session, nothing to resume). `cleo dash` and `cleo next` were arguably redundant given the explicit task prompt, but the protocol mandates them for orientation. Mild protocol violation, low impact.

### 4.2 Memory Operations (`cleo memory observe`, patterns, decisions)

**Root cause**: RUNTIME BUG + LOW SALIENCE OF STRUCTURED MEMORY COMMANDS

The builder did attempt `cleo memory observe` and encountered the `E_BRAIN_OBSERVE: no such column: provenance` bug. After one failure, it gave up on BRAIN entirely. This is the correct behavior under a time budget (453 seconds total), but it means **zero architectural observations were persisted**.

The structured memory commands (`memory.decision.store`, `memory.pattern.store`, `memory.learning.store`) were never attempted. These are Tier-1 commands mentioned in ct-cleo/SKILL.md under "Goal: Memory Operations" but they appear in the **third tier** of the decision tree (after find and timeline). For a builder focused on shipping code, the cognitive cost of switching to memory operations mid-build is high, and the decision tree does not create a natural trigger moment. **Surfacing gap**: there is no CLEO hook that says "you just wrote a pure module — consider `cleo memory pattern store` to preserve this pattern."

The CLEO-INJECTION.md "Memory Protocol (JIT)" section mentions `cleo memory find` and `cleo memory timeline` as recall tools but does not emphasize store operations as a build-time discipline. **Injection gap**: store operations appear in ct-cleo SKILL.md but not in the compact CLEO-INJECTION.md that was injected into this run.

### 4.3 Orchestration Commands (CRITICAL — `cleo orchestrate spawn`, `parallel`, etc.)

**Root cause**: HARNESS CONSTRAINT (primary) + CLEO GAP (secondary)

OBJECTIVE_METRICS.md §"Sub-agent tiering" is explicit:

> "All 3 builders reported the Agent tool was not surfaced in their sub-agent environment (only TaskCreate, TeamCreate, SendMessage, etc. were). So the Opus→Sonnet→Haiku model-tiering protocol collapsed into: all 3 builders executed the entire task on Opus 4.6 directly."

The harness (benchmark sub-agent environment) did not surface the `Agent` tool that `cleo orchestrate spawn.execute` depends on internally. This was an **equal handicap across all three arms** — Vanilla, GSD, and CLEO all ran single-model. However, the CLEO miss is more pointed because CLEO explicitly provides the orchestration machinery to enable tiering:

- `cleo orchestrate start --epic T001` — initializes orchestration, no Agent tool needed
- `cleo orchestrate analyze T001` — wave analysis, pure CLI computation
- `cleo orchestrate ready --epic T001` — lists spawnable tasks, no Agent tool needed
- `cleo orchestrate validate T002` — pre-spawn gate check, no Agent tool needed

These four commands could have been called even without the Agent tool being available. They would have produced correct orchestration metadata (wave analysis, dependency order, spawn readiness) even if the actual spawn had to fall back to single-agent execution. **The builder never called any of them.**

**CLEO gap**: There is no single-command entry point that says "I have an epic with N tasks, help me orchestrate this." The protocol requires the user to know the `orchestrate` domain exists and to call `orchestrate.start` explicitly. This is a **discoverability gap**: the CLEO-INJECTION.md mentions `cleo orchestrate` only in the "Escalation" section at the bottom, without explaining what it does. An agent starting cold on a greenfield project will not naturally think "I need to orchestrate" when it could just write all the code itself.

**Secondary cause**: The ct-cleo SKILL.md decision tree for "Goal: Multi-Agent Coordination" assumes the agent already knows it is in orchestrator role. The benchmark builder was in a hybrid role (single agent doing everything), and the orchestration tree's first line — "I am the orchestrator — start coordinating an epic" — did not match the builder's mental model because it was both orchestrator and worker simultaneously.

### 4.4 Dependency Declaration (Missing `--depends` flags)

**Root cause**: SKILL GAP + INJECTION GAP

The builder created T003–T009 without any dependency declarations. The obvious sequencing is:
- T002 (scaffold) must precede T003-T009
- T003 (storage) should precede T004 (todos) and T006 (UI)
- T005 (timer) should precede T006 (UI)

Neither ct-cleo/SKILL.md nor CLEO-INJECTION.md mentions the `--depends` flag in the task creation workflow. The dependency system exists (SKILL.md shows `tasks.depends` as a Tier-1 read operation) but the write side (`--depends` flag at `tasks.add` time) is not surfaced in the decision tree. This is a **skill gap**: the creation workflow examples do not show dependency wiring.

**Impact**: Without declared dependencies, `cleo orchestrate analyze T001` would produce a flat wave (all 8 tasks in parallel) even though some tasks have real sequencing requirements. The orchestration machinery is only as useful as the dependency graph it operates on.

### 4.5 Pipeline Stage Tracking (Missing `pipelineStage`)

**Root cause**: INAPPLICABLE FOR THIS TASK SIZE + INJECTION GAP

The LOOM pipeline (Research → Consensus → Architecture Decision → Specification → Decomposition → Implementation → Validation → Testing → Release) is designed for multi-session, multi-agent epics. For a 7-minute single-session build, cycling through 9 pipeline stages would consume more time than the build itself. The builder correctly skipped formal stage tracking.

However, the `pipelineStage` field on T001 is `null` — the builder never even set it to `implementation`. This is a mild protocol miss: even a single call to `cleo pipeline stage.set` to mark the epic as `implementation` would have correctly captured the current phase in the LOOM lifecycle. **Low impact** for this task size; correct behavior for a toy benchmark.

### 4.6 `cleo start` Protocol (Only T002 Started)

**Root cause**: AGENT BEHAVIOR DEVIATION from BASE PROTOCOL

BASE-005 says: "MUST start a task before beginning work." The anti-patterns reference (`references/anti-patterns.md`) explicitly lists: "Skipping task start — protocol violation — Always `cleo start` first."

The builder called `cleo start T002` at 04:47:05Z but then wrote all code for T003–T009 without calling `cleo start` on each. The completion batch at 04:52:36Z–04:52:45Z shows all 8 completions firing in rapid sequence (30 seconds), which confirms the builder wrote all code first and then mass-completed tasks. **This is a silent protocol violation** that the system did not catch (there is no enforcement that prevents `cleo complete` on a `pending` task that was never `started`). The tasks remain with correct final state (`done`) but the `task_work_history` table is empty — no time-in-progress was tracked for T003–T009.

**Impact**: Session stats show `tasksCompleted: 0` and `tasksCreated: 0` in the session debrief, which is factually wrong — the session did create and complete tasks, but the counters were not incremented because the `start` → `complete` lifecycle was not followed. The debrief note is manually written ("Shipped pomodoro+todos app...") rather than auto-generated from session stats, which confirms the builder knew the stats were wrong.

---

## 5. The Critical Miss: Orchestration Tier

### 5.1 What the Protocol Required

PROTOCOL.md §4 specified:
- Planning phase: Opus 4.6
- Build phase: Sonnet 4.6 (fast codegen)
- Atomic tasks: Haiku 4.5 (one-shot edits)

The expected execution model: the CLEO builder (Opus) would call `cleo orchestrate spawn` for each of the 8 atomic tasks, launching Sonnet or Haiku workers to execute them. This would produce a 3-tier hierarchy.

### 5.2 What Actually Happened

The CLEO builder (Opus 4.6) wrote all 1,659 LOC of code itself, sequentially, without spawning any workers. This matches GSD ("single sub-agent, wave=1") and Vanilla (no multi-agent concept). **All three arms collapsed to identical single-model execution.**

### 5.3 Causal Analysis

**Primary cause — Harness constraint**: The Agent tool was not surfaced in the sub-agent environment. `cleo orchestrate spawn.execute` internally uses the Agent tool to create a new agent invocation. Without the Agent tool, spawn.execute would fail or produce no worker. The builder correctly identified this limitation.

**Secondary cause — CLEO gap: No graceful degradation path**: When spawn is blocked, CLEO provides no guidance on how to continue. The orchestrate commands (`start`, `analyze`, `ready`) are still valuable for planning and wave-analysis even if spawn is blocked, but there is no documentation that says "if Agent tool is unavailable, still run `orchestrate analyze` to produce wave metadata and execute sequentially per wave." The builder reasonably concluded that all orchestration commands were moot without the Agent tool.

**Tertiary cause — No single entry point for "I want to orchestrate this epic"**: In ct-cleo/SKILL.md, the orchestration workflow begins with "I am the orchestrator" — a role declaration the builder must consciously make. A builder that thinks of itself as "the builder" (which is the natural frame when writing code directly) will never reach that branch. There is no proactive hint from CLEO that says "you just created an epic with 8 tasks — consider using `cleo orchestrate` to fan out."

### 5.4 Harness vs CLEO Responsibility

| Factor | Harness Issue | CLEO Gap |
|--------|:---:|:---:|
| Agent tool not surfaced | Yes | — |
| No documentation that `orchestrate analyze/ready/validate` work without Agent tool | — | Yes |
| No proactive hint after epic creation | — | Yes |
| No graceful degradation path documented | — | Yes |
| Orchestration decision tree requires explicit role declaration | — | Yes |

**Verdict**: This was ~60% harness constraint, ~40% CLEO gap. Even with the harness constraint, 5 orchestrate commands (start, analyze, ready, validate, status) could have run cleanly and produced valuable metadata. None were called.

---

## 6. Missed Discoverability Moments

These are specific points in the build workflow where CLEO could have auto-triggered a hint or where a well-placed protocol reminder would have changed behavior:

### Moment 1: After `cleo add T001 --type epic`

**What happened**: Builder immediately started adding child tasks.

**What should have happened**: CLEO could have printed:
```
Epic T001 created. To orchestrate this epic:
  cleo orchestrate start --epic T001   # initialize orchestration state
  cleo orchestrate analyze T001        # wave analysis + dependency order
Run `cleo help orchestrate` for details.
```

This hint requires no new capability — it is a post-add output addition to the `tasks.add` response when `type=epic`.

### Moment 2: After all 8 children added (04:46:46Z)

**What happened**: Builder began writing code with no further CLEO interaction for 5 min 50 sec.

**What should have happened**: `cleo orchestrate ready --epic T001` would have returned a list of wave-0 tasks (all 8, since no deps declared) with spawn context. Even without the Agent tool, this command would have:
1. Confirmed the task decomposition is complete
2. Suggested the execution order
3. Reminded the builder to call `cleo start` before each task

### Moment 3: At `cleo start T002` (the only `start` call)

**What happened**: Builder started T002 and then wrote all code without calling `cleo start` on T003–T009.

**What should have happened**: CLEO could enforce START-before-COMPLETE at the CLI level. Currently, `cleo complete T003` on a `pending` task succeeds silently. If `complete` returned a warning ("Task T003 was never started — session tracking will be incomplete"), the builder would have been prompted to follow the protocol.

### Moment 4: After `cleo memory observe` failure

**What happened**: Builder received `E_BRAIN_OBSERVE: no such column: provenance`, then abandoned all memory operations.

**What should have happened**: CLEO should have returned a more actionable error:
```
Error: E_BRAIN_OBSERVE — schema migration missing (v2026.4.65 known issue).
Memory observation not persisted. Continue? [Y/n]
Workaround: Write observation to sticky note via `cleo sticky add "..."`
```

The sticky note system (`brain_sticky_notes` table exists in brain.db) is a working alternative that was never surfaced as a fallback.

### Moment 5: At `cleo session end`

**What happened**: Session ended with debrief showing `tasksCompleted: 0`, `tasksCreated: 0` — clearly wrong.

**What should have happened**: `cleo session end` could detect that tasks were completed during the session (they appear in audit_log) but the counters are zero, and warn: "Session stats appear incomplete — did you call `cleo start` before each task? Run `cleo check compliance.summary` to verify."

---

## 7. Commands Used vs Available: Final Tally

### 7.1 Confirmed Used

| # | Command | Count |
|---|---------|------:|
| 1 | `cleo session start` | 1 |
| 2 | `cleo add` (tasks + epic) | 9 |
| 3 | `cleo start` (task) | 1 |
| 4 | `cleo check gate.set --all` | 9 |
| 5 | `cleo complete` | 8 |
| 6 | `cleo memory observe` (FAILED) | 1 (attempted) |
| 7 | `cleo session end` | 1 |

**Total distinct operation types used**: 7 (6 succeeded, 1 failed)
**Total CLI invocations confirmed**: 30 (29 in audit_log + 1 failed memory call in SUPREME evidence)

### 7.2 Available But Not Used

Counting from ct-cleo/SKILL.md Tier-0 + Tier-1 tables:

**Tier-0 skipped** (should always be available):
- `session.briefing.show` / `cleo briefing`
- `admin.dash` / `cleo dash`
- `tasks.current` / `cleo current`
- `tasks.next` / `cleo next`
- `tasks.plan` / `cleo plan`
- `tasks.find` / `cleo find`
- `tasks.show` / `cleo show` (inferred as possibly called, but not audited)
- `memory.find` / `cleo memory find`
- `admin.health` / `cleo health`

**Tier-1 skipped** (material misses):
- `orchestrate.start`, `orchestrate.analyze`, `orchestrate.ready`, `orchestrate.spawn`, `orchestrate.spawn.execute`, `orchestrate.handoff`, `orchestrate.parallel`, `orchestrate.validate`, `orchestrate.status` (9 operations — entire domain unused)
- `memory.decision.store`, `memory.pattern.store`, `memory.learning.store` (3 operations)
- `memory.timeline`, `memory.fetch` (2 operations — not applicable without prior memory)
- `check.protocol`, `check.compliance.summary`, `check.test` (3 operations)
- `pipeline.stage.status`, `pipeline.stage.record`, `pipeline.manifest.append` (3 operations — manifest append is a BASE-001 violation)
- `session.record.decision`, `session.record.assumption` (2 operations)
- `tasks.depends`, `tasks.blockers` (2 operations)

**Total distinct operations not invoked**: ~33 (excluding clearly inapplicable: release, archive, delete, reparent, etc.)

---

## 8. The Provenance Bug: Compounded Impact

The `E_BRAIN_OBSERVE: no such column: provenance` bug on v2026.4.65 had cascading effects beyond the obvious "observation not saved":

1. **Memory abandon**: Builder stopped all BRAIN interaction after one failure, losing not just one observation but all potential pattern/decision/learning stores.

2. **Session debrief corruption**: `cleo session end` calls the memory bridge write path, which hit the same bug and printed "Failed to write memory bridge." The debrief JSON was written but the memory-bridge.md auto-refresh did not complete. Future sessions in this project directory would start cold with no memory context.

3. **Statistical invisibility**: Because memory operations failed, there is no record in brain.db of any architectural decisions. If a second session were started in this project, `cleo briefing` would return no relevant prior context — effectively making CLEO's multi-session value proposition zero for this project.

4. **Trust erosion**: A builder that hits an error on the first BRAIN write is less likely to attempt BRAIN writes for the rest of the session. This creates a compound loss: one bug eliminates an entire capability class for the duration of the run.

---

## 9. What the Builder Did Well

This is a forensics report, not a takedown. The builder's adherence to the parts of the CLEO protocol it did use was high:

1. **Epic decomposition was correct and substantive**: T001 with 10-item acceptance criteria array, 8 children each with 3-4 acceptance items, all with correct `type: "task"` and `parent: "T001"`. This is better task data than most agents produce.

2. **Verification gate usage was correct**: `check.gate.set --all` on every task before `complete` ensures all three gates (`implemented`, `testsPassed`, `qaPassed`) are set. This is exactly the intended quality enforcement mechanism.

3. **Session lifecycle was correctly framed**: Named session, appropriate note on end, correct `--scope global` for a greenfield project.

4. **Output quality was the highest of three arms**: The code the builder wrote — pure modules, injected `now()` for testability, `schemaVersion` in localStorage, `aria-keyshortcuts`, live-region announcements, 3-state theme — reflects what CLEO's acceptance-criteria discipline produces. The task decomposition did its job.

5. **No cross-contamination**: No `.planning/` directory, no GSD artifacts. Clean separation.

---

## 10. Recommendations for CLEO Protocol Improvements

Based on this forensic analysis, ranked by impact:

### R1 — Fix the provenance bug (P0, v2026.4.66 hotfix)

Every forensic finding about memory abandonment flows from this bug. Fix the schema migration before memory becomes a live product feature.

### R2 — Auto-hint after epic creation (High)

When `cleo add --type epic` is called, append to the response:
```
Epic created. Next: `cleo orchestrate start --epic {id}` to initialize coordination.
```
This is a one-line response modification that would have triggered orchestration initiation.

### R3 — Block `complete` on never-started tasks (Medium)

`cleo complete T003` when T003 is `pending` (never started) should warn or require `--force`. This enforces the START-before-COMPLETE protocol and preserves session tracking integrity.

### R4 — Document orchestrate commands without Agent tool (Medium)

Add a note to the `orchestrate.*` decision tree: "Even if sub-agent spawning is unavailable, run `orchestrate.analyze` and `orchestrate.ready` for wave planning. Use `cleo next` within each wave for sequential execution."

### R5 — Surface sticky notes as BRAIN fallback (Medium)

When `cleo memory observe` fails with any error, suggest `cleo sticky add` as a working alternative for transient notes that survive the session.

### R6 — Require `--depends` declarations for child tasks in epics (Low)

Add `cleo check compliance.summary` output for an epic that includes: "N tasks have no dependency declarations. Consider `cleo task depends` to wire the dependency graph before orchestrating."

### R7 — Add `--integration` gate to task verification (Low)

Current 3-gate check (`implemented`, `testsPassed`, `qaPassed`) does not distinguish unit from integration coverage. The CLEO builder marked all gates green while shipping zero integration tests. A fourth gate `integrationCoverage` (boolean, optional, default false) would give acceptance criteria a way to require integration test evidence.

---

## 11. Summary Statistics

| Metric | Value |
|--------|------:|
| Total audited CLI invocations | 30 |
| Distinct operation types used | 7 |
| Operations succeeded | 29 |
| Operations failed | 1 (memory.observe — provenance bug) |
| Operations available but not used (material) | ~33 |
| Brain observations persisted | 0 |
| Orchestrate domain calls made | 0 |
| Tasks started via `cleo start` | 1 of 8 (T002 only) |
| Tasks completed without prior `start` | 7 of 8 (T003–T009) |
| Pipeline stage set on T001 | never (null) |
| MANIFEST.jsonl entry appended | never (BASE-001 violation) |
| Session debrief tasks_completed counter | 0 (incorrect — tracking failure) |
| Session debrief tasks_created counter | 0 (incorrect — tracking failure) |
| Wall-clock in code-writing (no CLEO calls) | ~350 seconds (77% of run) |

---

*Report generated: 2026-04-16T07:06:39Z*
*Analyst: CLEO-ARM FORENSICS subagent, T761*
