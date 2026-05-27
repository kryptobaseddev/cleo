# T765 — LOOM System Invocation Audit

**Date**: 2026-04-16
**Task**: T765 (child of epic T760)
**Author**: LOOM gap-analysis subagent
**Output**: LOOM gap analysis — definition, bench evidence, wiring gaps, integration sketch

---

## 1. What Is LOOM, Concretely?

LOOM (Logical Order of Operations Methodology) is CLEO's lifecycle pipeline engine. It provides a strict, gate-enforced progression model that governs how ANY work item moves from raw idea to shipped artifact. The canonical acronym expansion is **RCASD-IVTR+C**: five planning stages (Research, Consensus, Architecture Decision, Specification, Decomposition) followed by four execution stages (Implementation, Validation, Testing, Release) with Contribution as a cross-cutting dimension that applies to all stages simultaneously.

LOOM is not a separate process or daemon — it is a state machine maintained per-epic inside `tasks.db`, driven by the `cleo lifecycle` command family and the `packages/core/src/lifecycle/` module. It is the *sequencing and gate-enforcement layer* that sits above individual tasks: LOOM answers "what phase is this epic in and is the next stage allowed to start?"

### 1.1 API Surface

**Primary CLI entry point** is `cleo lifecycle`:

| Subcommand | Purpose |
|---|---|
| `lifecycle show <epicId>` | Current stage, all stage statuses, blocked-on list |
| `lifecycle start <epicId> <stage>` | Advance epic into a stage (fails if prerequisites unmet) |
| `lifecycle complete <epicId> <stage>` | Mark stage complete; records provenance, outputFile |
| `lifecycle skip <epicId> <stage>` | Skip an optional stage (consensus, architecture_decision, release) |
| `lifecycle gate <epicId> <stage>` | Check whether gate conditions are satisfied |
| `lifecycle gate-record <epicId> <stage>` | Record a gate pass or fail |
| `lifecycle guidance [--stage <s>]` | Emit stage-aware LLM prompt guidance for Pi hooks |
| `lifecycle history <epicId>` | Full stage transition log with timestamps |
| `lifecycle reset <epicId> <stage>` | Roll back a stage for rework |

**Secondary surface** via `cleo orchestrate` (wave/fan-out planning):

| Subcommand | LOOM relationship |
|---|---|
| `orchestrate waves <epicId>` | Compute dependency waves from epic's task graph |
| `orchestrate analyze <epicId> --mode parallel-safety` | Identify parallel-safe task groups |
| `orchestrate spawn <taskId>` | Prepare skill-injected prompt for a task |
| `orchestrate fanout <epicId>` | Fan-out tasks via parallel spawn |
| `orchestrate next --epic <epicId>` | Get next dependency-safe task |
| `orchestrate start <epicId>` | Initialize orchestrator session for the epic |

**Programmatic layer**:
- `packages/core/src/lifecycle/stages.ts` — canonical `PIPELINE_STAGES`, `STAGE_PREREQUISITES`, `STAGE_DEFINITIONS`, `checkTransition()`
- `packages/core/src/lifecycle/pipeline.ts` — state machine logic
- `packages/core/src/lifecycle/stage-guidance.ts` — Pi hook guidance generation
- `packages/core/src/lifecycle/cant/lifecycle-rcasd.cant` — CANT protocol file for the lifecycle domain

**Data model** (per epic, stored in `tasks.db`):
- `lifecycle_stages` table: `(epicId, stage_name, status, started_at, completed_at, output_file, related[])`
- Gate enforcement mode: `lifecycleEnforcement.mode` in `.cleo/config.json` (`strict` | `advisory` | `off`)
- Exit code `80` (`E_LIFECYCLE_GATE_FAILED`) blocks completion when gates unmet

### 1.2 RCASD-IVTR Lifecycle Role

LOOM is the *conductor* of the entire RCASD-IVTR+C model. Without LOOM, an agent knows individual tasks but has no view of which *phase* the epic is in, whether prerequisite stages are complete, or what the expected artifacts of each stage are. LOOM provides:

1. **Forward-only enforcement** — strict mode blocks stage entry until prerequisites are met
2. **Stage-bound artifact expectations** — each stage has `expectedArtifacts[]` declared in `STAGE_DEFINITIONS`
3. **Gate recording** — passes/fails recorded at stage level, not just task level
4. **Provenance chain** — each stage completion records `outputFile` and `related` refs linking back to prior stages
5. **Pi hook integration** — `lifecycle guidance` feeds into `before_agent_start` hooks so the harness can inject stage-aware prompts automatically

---

## 2. Was LOOM Invoked During the CLEO Arm Benchmark?

**Verdict: NO.**

### Evidence

**From `OBJECTIVE_METRICS.md` and `SUPREME_REPORT.md` §3.3:**

The CLEO builder arm created epic T001 + 8 atomic children (T002–T009) and drove all 9 tasks to `status=done` with `verification.passed=true`. The `tasks.db` evidence confirms full task-graph usage.

However:
- `cleo lifecycle show T001` (run post-benchmark in this analysis) returns `initialized: false`, `currentStage: null`, and all 9 stages as `not_started`. This is conclusive: the lifecycle pipeline was **never initialized for T001**.
- `cleo orchestrate waves T001` returns `{ totalWaves: 0, totalTasks: 0 }` — the orchestrator wave-planning layer was also never invoked.
- The bench log (`cleo/bench.log`) contains only `START_` and `END_` timestamps, no command trace.
- The SUPREME_REPORT §3.3 describes the builder as using `session/task/verify lifecycle` — meaning the *task verification gates* (implemented/testsPassed/qaPassed), NOT the *pipeline lifecycle stages* (research→...→release).

**Was that correct or wrong?**

For a 30-minute greenfield static app benchmark this is **defensibly correct but architecturally incomplete**:

- **Correct**: the task was small enough that the full RCASD planning phase (Research → Consensus → Architecture Decision → Specification → Decomposition) would have been pure overhead with no parallelism to unlock. The SUPREME_REPORT explicitly notes "single sub-agent, wave=1" and observes all three arms ran serially because Agent-tool tiering was blocked by the harness.
- **Wrong (at the design level)**: the builder invoked task-level verification gates but never LOOM's stage-level pipeline. This means there is no record of *what phase the epic was in* at any point, no provenance chain linking the research (what the builder read about the spec) to the decomposition (the 8 tasks), and no mechanism to catch if the builder skipped required planning stages. LOOM's gate enforcement in `strict` mode would have blocked `cleo complete` on T001 children if implementation stage gates were not set — but the builder apparently completed tasks without LOOM initialization, meaning enforcement was silent.

---

## 3. Where SHOULD LOOM Have Been Used?

### 3.1 Planning phase initialization

Even in a single-wave build, the orchestrator SHOULD have called:

```bash
cleo lifecycle start T001 research
# ... builder reads spec, writes T760-rcasd/pomodoro-research.md
cleo lifecycle complete T001 research --outputFile ".cleo/rcasd/T001/research/T001-research.md"

cleo lifecycle skip T001 consensus        # single agent, no vote needed
cleo lifecycle skip T001 architecture_decision  # no ADR needed for greenfield static app

cleo lifecycle start T001 specification
# ... builder writes acceptance criteria into task rows
cleo lifecycle complete T001 specification

cleo lifecycle start T001 decomposition
# ... cleo add T002..T009
cleo lifecycle complete T001 decomposition
```

This would have taken ~3 extra CLI calls and produced a provenance chain. Cost: negligible. Benefit: traceability from spec requirements to each subtask.

### 3.2 Wave computation

```bash
cleo orchestrate start T001
cleo orchestrate waves T001
```

In this benchmark, waves would have returned a single wave of 8 parallel tasks — confirming the serial execution was correct because parallelism was blocked by the harness. But the orchestrator would have had *explicit knowledge* of the dependency structure rather than assuming it.

### 3.3 Spawn preparation

Instead of manually building each atomic task, the orchestrator could have used:

```bash
cleo orchestrate spawn T002 --protocol implementation
```

This injects the base protocol + conditional implementation protocol + task context into a fully-resolved prompt — the exact prompt body this benchmarked subagent would receive. The CLEO builder instead wrote its own task prompts, which is why the SUPREME_REPORT noted "builder mutated shared state in `app.js`" (no lint-gate prompt was injected).

### 3.4 Verdict on applicability

LOOM's **planning phase** (RCASD) was applicable and skipped. LOOM's **wave orchestration** was applicable but irrelevant due to harness tiering failure. LOOM's **spawn injection** was the most directly missed value — it would have automatically embedded `pnpm biome check` and linting guidance into the implementation prompt, potentially preventing the `app.js` state mutation miss.

---

## 4. Wiring Gaps

### Gap 1: LOOM is not bootstrapped by default for epics

When `cleo add --type epic` creates an epic, `cleo lifecycle show <epicId>` returns `initialized: false`. There is no automatic initialization. An orchestrator must explicitly call `cleo orchestrate start <epicId>` or `cleo lifecycle start <epicId> research` to begin the pipeline.

**Problem**: agents are not prompted to initialize LOOM at epic creation time. The `cleo add` response does not mention lifecycle. The `ct-orchestrator` skill's spawn workflow (per `orchestrator-spawning.md`) mentions `orchestrate next`/`spawn` but does not include a `lifecycle start` step in its "Automated Workflow" example.

**Proposal**: `cleo orchestrate start <epicId>` should auto-initialize the lifecycle pipeline AND emit a warning if it was already initialized. Alternatively, `cleo add --type epic` should accept `--lifecycle-init` to bootstrap `research` stage immediately.

### Gap 2: No CLI-visible link between `cleo lifecycle` and `cleo orchestrate`

The two command trees are siblings. `cleo lifecycle` manages stages for an epic. `cleo orchestrate waves`/`spawn`/`fanout` manages task dispatch. Neither references the other in its help output. An agent who reads `cleo orchestrate --help` has no signal that it should also be calling `cleo lifecycle start`.

**Proposal**: `cleo orchestrate start <epicId>` response body should include a `lifecycleState` field showing current stage, and should refuse to spawn from an epic if LOOM is in an incompatible stage (e.g., do not spawn implementation tasks while lifecycle is at `research`).

### Gap 3: `cleo lifecycle guidance` requires a stage argument, breaking Pi hook use

`cleo lifecycle guidance` (without a stage) returns `E_INVALID_INPUT`. The Pi hook (`before_agent_start`) would need to know the current stage to call this correctly. If the lifecycle is not initialized (`currentStage: null`), this call fails silently.

**Proposal**: `cleo lifecycle guidance` with no arguments should return guidance for the *next* stage when called in the context of an initialized epic, or return a "not initialized — call `lifecycle start <epicId> research`" advisory.

### Gap 4: No "greenfield bootstrap" template

There is no `cleo orchestrate bootstrap --greenfield` command that walks an agent through the minimal LOOM initialization for a new project. An agent starting a greenfield build must know to: (a) create session, (b) create epic, (c) initialize lifecycle, (d) run planning stages, (e) run waves, (f) spawn workers. This is documented in `orchestrator-spawning.md` but not enforced or prompted.

**Proposal**: `cleo orchestrate bootstrap --epic T001` should emit a step-by-step checklist: "1. Initialize lifecycle: `cleo lifecycle start T001 research`; 2. Run research stage; 3. Decompose into tasks; 4. Compute waves: `cleo orchestrate waves T001`; 5. Spawn first wave."

### Gap 5: LOOM stage completion does not block `cleo complete` on child tasks

The bench builder completed 8 tasks with `verification.passed=true` but the parent epic T001 was never advanced through LOOM stages. The system allowed this without error. If `lifecycleEnforcement.mode=strict` should mean anything at the epic level, it should prevent child-task completion when the parent epic's lifecycle stage is `not_started`.

**Proposal**: When `lifecycleEnforcement.mode=strict`, `cleo complete <childTask>` should check the parent epic's LOOM stage and warn (advisory) or block (strict) if the parent's lifecycle pipeline has never been initialized.

---

## 5. Integration with Programmatic Gates (T763 sketch)

T763's output (typed verification gates) and LOOM's stage-level gates operate at different granularities:

```
LOOM stage gates (per epic stage)          Task verification gates (per task)
  lifecycle_stages.status = "completed"       verification.gates.implemented = true
  lifecycle_stages.output_file = "..."        verification.gates.testsPassed = true
  stage_gate_records (pass/fail log)          verification.gates.qaPassed = true
```

A coherent workflow would compose them as follows:

```
ORCHESTRATOR (top-level)
  cleo orchestrate start T001
  cleo lifecycle start T001 research
    --> spawn research subagent --> writes T001-research.md
    --> subagent: cleo lifecycle gate-record T001 research --pass --evidence T001-research.md
  cleo lifecycle complete T001 research
  cleo lifecycle skip T001 consensus  (single agent)
  cleo lifecycle skip T001 architecture_decision  (no ADR needed)
  cleo lifecycle start T001 specification
    --> acceptance criteria written into task rows (typed gate: spec-complete)
  cleo lifecycle complete T001 specification
  cleo lifecycle start T001 decomposition
    --> cleo add T002..T009 (typed gates from T763: each task has implementation/testsPassed/qaPassed)
  cleo lifecycle complete T001 decomposition
  cleo orchestrate waves T001  --> { wave1: [T002..T009], totalWaves: 1 }
  cleo lifecycle start T001 implementation
    --> spawn T002..T009 workers (serial due to harness limitation)
    --> each worker: cleo verify <id> --gate implemented --value true
    --> each worker: cleo verify <id> --gate testsPassed --value true
    --> each worker: cleo verify <id> --gate qaPassed --value true
    --> each worker: cleo complete <id>
  cleo lifecycle gate-record T001 implementation --pass --evidence "all child tasks done"
  cleo lifecycle complete T001 implementation
  cleo lifecycle start T001 validation
    --> pnpm biome check; pnpm build (typed gate: static-analysis-pass)
  cleo lifecycle complete T001 validation
  cleo lifecycle start T001 testing
    --> pnpm run test (typed gate: tests-pass, coverage-met)
  cleo lifecycle complete T001 testing
  cleo lifecycle skip T001 release  (benchmark, no publish)
```

The IVTR loop becomes: each LOOM stage checks its typed gates before `lifecycle complete` is allowed. T763's typed gates are the *implementation detail*; LOOM's stage gates are the *orchestration checkpoint*. Neither replaces the other.

---

## 6. Summary and Verdict

| Question | Finding |
|---|---|
| Was LOOM invoked in CLEO bench? | **No** — T001 lifecycle `initialized: false`, all stages `not_started` |
| Was that correct? | Partially — planning overhead was justified to skip; spawn injection miss was not |
| Most concrete missed value | `orchestrate spawn` prompt injection (would have caught state mutation miss + lint gate) |
| Is `cleo orchestrate` the LOOM entry point? | Partially — it handles wave/spawn dispatch but does not initialize lifecycle stages |
| Is there a greenfield template? | **No** — biggest documentation gap identified |
| Stage gates vs task gates | Two independent systems; neither enforces the other; integration sketch provided above |

**Overall verdict: LOOM needs wiring.**

The core pipeline engine is functionally complete and attested (T573 PASS). The gaps are all in discoverability and default invocation:
1. Epics are not lifecycle-initialized at creation
2. `cleo orchestrate` and `cleo lifecycle` do not cross-reference each other
3. No greenfield bootstrap template exists
4. Stage completion does not gate child-task completion
5. `lifecycle guidance` is broken without an explicit stage argument

---

## Appendix: Key Evidence Sources

| Source | Finding |
|---|---|
| `cleo lifecycle show T001` (post-bench) | `initialized: false`, all stages `not_started` — LOOM never touched |
| `cleo orchestrate waves T001` (post-bench) | `{ totalWaves: 0, totalTasks: 0 }` — wave layer never invoked |
| `SUPREME_REPORT.md §3.3` | Builder used task-level session/task/verify, not pipeline lifecycle |
| `OBJECTIVE_METRICS.md §Sub-agent tiering` | Agent tool blocked; all work was single-thread Opus — parallel waves moot |
| `T573-loom-attestation.md` | LOOM pipeline engine functionally PASS (9 stages, gate enforcement) |
| `loom-lifecycle.md` (ct-cleo skill) | Full LOOM/orchestrate API reference |
| `orchestrator-spawning.md` | Spawn workflow does NOT include `lifecycle start` in its automated workflow |
| `agentic-layer-cleo-native.md` | `orchestrate.fanout` + CANT classification = biggest unlock still unshipped |
| `stages.ts` | Canonical `STAGE_PREREQUISITES`, `STAGE_DEFINITIONS`, gate metadata |
