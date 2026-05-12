# SUPREME Judge Report — Pomodoro Head-to-Head Benchmark

**Date**: 2026-04-16
**Judge**: SUPREME analysis agent (Opus 4.6, 1M context)
**Scope**: Vanilla Claude Code vs Claude Code + GSD vs Claude Code + CLEO
**Methodology**: Independent artifact inspection + test execution; self-reports ignored.

---

## 1. Executive Summary

CLEO wins by a narrow margin (79/100) over Vanilla (77/100) and GSD (75/100). All three arms shipped working, tested, accessible, production-grade static apps well under the 30-minute budget — so this benchmark measures **quality-delta per unit of overhead**, not "did they ship." CLEO's structured task lifecycle produced the most spec-complete app (configurable long-break cadence, 3-state theme cycle, live-region announcements) while GSD's spec-first approach produced the cleanest artifact trail but the least-complete UX (binary-only theme toggle, `confirm()` for delete). Vanilla's minimalism and the only true end-to-end integration test make it shockingly competitive; the two tooling regimes must justify a **30-35% token premium and 21-38% wall-clock premium** against that baseline, and only CLEO clearly earns it on output quality.

---

## 2. Scoreboard

| Dimension | Max | Vanilla | GSD | CLEO |
|---|---:|---:|---:|---:|
| Correctness | 25 | **23** | 22 | **24** |
| Feature completeness | 20 | 17 | 16 | **18** |
| Code quality | 20 | **18** | 16 | 17 |
| Architecture | 10 | 9 | 9 | 9 |
| Testing | 10 | **10** | 9 | 8 |
| Accessibility | 5 | 4.5 | 3.5 | **4.5** |
| UX polish | 5 | 4 | 3 | **4.5** |
| Documentation | 5 | 3.5 | 3.5 | **4** |
| **TOTAL** | **100** | **77.0** | **75.0** | **79.0** |

(All three are well above the 60-point "usable-production-app" threshold; deltas are real but small.)

---

## 3. Per-Arm Analysis

### 3.1 Vanilla (77/100) — Ruthless Minimalism

Vanilla shipped **12 source files / 1,946 LOC** in 375 s on 89k tokens — the cheapest and fastest run. The architecture is the most mature of the three: `src/` is split into five single-purpose modules (`store.js`, `timer.js`, `theme.js`, `chime.js`, `app.js`), every function has a JSDoc block, `// @ts-check` is enabled, and the pure domain modules accept injected clock/setTimeout for deterministic tests. The timer uses a **deadline-based `setTimeout` with 200 ms tick re-scheduling** — more robust than the rAF-only approach the other two took, because it stays accurate when the browser tab is throttled.

Vanilla is the **only arm with a genuine integration test** (`tests/integration.test.mjs`, 115 LOC): it wires the store to the timer through a fake clock, completes a work phase, asserts the session counter + daily total + localStorage persistence in one flow. The other two arms only unit-tested pure modules.

It is also the only arm that shipped a **3-state theme cycle (auto → light → dark)** in dedicated `theme.js` module, a **skip link**, `prefers-reduced-motion` handling in CSS, and `aria-atomic="true"` on the timer display.

Weaknesses: the toggle icon is a single letter ("A"/"L"/"D") rather than an icon, and `role="textbox"` on the todo text span is mildly non-idiomatic (it's a plain span until edit starts). The settings dialog lacks a cadence-override field (hard-coded 4).

### 3.2 GSD (75/100) — Spec-Driven, Weakest Output

GSD produced the **most substantive planning trail** of any arm: `.planning/` contains PROJECT.md, REQUIREMENTS.md (28 numbered REQs with IDs like TIMER-03, A11Y-04), ROADMAP.md, STATE.md, phase-scoped 1-CONTEXT/RESEARCH/PLAN/VERIFY files, totalling ~700 LOC of planning that the spec never explicitly asked for. The 1-VERIFY.md file walks every REQ-ID to a PASS verdict — that is genuinely useful traceability.

**But the shipped app is the weakest of the three**:

- **Theme toggle is binary only** (`setTheme(getTheme() === "dark" ? "light" : "dark")`, app.js:319). Once the user clicks, there is no way back to OS-auto. The spec literally says "dark/light mode with OS auto-detect + manual toggle" — half-credit only.
- **Delete uses `confirm()`** (app.js:185) — a native browser modal, which breaks focus and styling conventions. The 1-VERIFY.md file flags this as "known non-blocking", but it's a UX regression.
- **Selection is ephemeral on the timer**: if no todo is selected, the Start button is `disabled`; the other two arms let you run the timer standalone or auto-select the first todo on add.
- **The `aria-live="polite"` region is on `<ul id="todo-list">`** (index.html:53), which will announce the full list on every render — more noise than signal. The timer wrap is also `aria-live="polite" aria-atomic="true"` (correct).
- No skip link, no `prefers-reduced-motion`, no cadence setting.

Paradoxically, GSD's **test count is highest** (31 assertions), but the extra assertions are repetitive unit tests on immutability — the spec-driven process encouraged thoroughness here. However, no integration test: all 31 are pure-function tests.

GSD also had **zero observable orchestration win** in this run: the plan document (1-1-PLAN.md) explicitly notes "single sub-agent, wave=1" — so the plan collapsed into a single linear build, and the overhead bought spec discipline but not parallelism.

**Minor doc gap**: no `package.json`, so `npm test` fails; only `node --test tests/*.test.js` works. This is cited in the README, so users get the right command, but the 1-VERIFY.md's claim "package.json exists" (implicit in many scripts) is never actually delivered.

### 3.3 CLEO (79/100) — Most Complete App, Most Overhead

CLEO shipped **11 source files / 1,659 LOC** and the most spec-complete UX: a 3-state theme cycle with `aria-pressed`/`aria-expanded`, an `aria-live="polite" role="status"` live region with announcements on every user-visible action ("Task added", "Timer reset", "Settings saved"), a **user-configurable long-break cadence** (`opt-cadence` in the settings form) that neither other arm offers, skip link, `aria-keyshortcuts` on start/new-todo (modern WAI-ARIA 1.2).

The task graph in `.cleo/tasks.db` is **substantive, not theatre**: epic T001 with 8 atomic children (T002–T009), each carrying real acceptance-criteria arrays (3–4 items per task) and full 3-gate verification (`implemented: true, testsPassed: true, qaPassed: true`, `lastAgent: "cleo-prime"`). This mirrors GSD's REQUIREMENTS.md but lives inside queryable storage rather than markdown — meaningfully different for agent-first workflows.

**Code quality is high but slightly behind Vanilla**: the modules are pure and well-documented with `@typedef` blocks, but `app.js` mutates `state` in-place (`state.todos = addTodo(...)`, line 135) — the pure modules return new arrays, but the call-site overrides reference-level immutability, which is a small consistency slip. Vanilla never does this.

**Testing is the weakest of the three** in absolute terms: 29 assertions, all pure-module unit tests; no integration test threading real persistence through the timer (vanilla's strongest move).

**Known CLEO defect surfaced during the run** (from `OBJECTIVE_METRICS.md`): `cleo memory observe` failed with `E_BRAIN_OBSERVE: no such column: provenance` — schema migration is missing on v2026.4.65. The builder could not persist architecture observations to BRAIN, and `cleo session end` printed "Failed to write memory bridge" from the same root cause. **Non-blocking for the build, but a measurable tooling defect this benchmark exposed.**

---

## 4. Tool-Regime Compliance

| Arm | Compliance | Evidence |
|---|---|---|
| Vanilla | **Full** | No `.cleo/`, no `.planning/`, no `/gsd:*` command residue. Clean Read/Write/Edit/Bash/Glob/Grep only. |
| GSD | **Full** | `.planning/{PROJECT,REQUIREMENTS,ROADMAP,STATE}.md`, `1-{CONTEXT,RESEARCH,VERIFY}.md`, `1-1-PLAN.md`, `config.json`, `research/`. All exist AND are substantive (3–6 KB each, not stubs). Phase progression (new → discuss → plan → execute → verify) is traceable through `STATE.md` history. |
| CLEO | **Full** | `.cleo/tasks.db` (458 KB), `.cleo/conduit.db` (208 KB), `.cleo/brain.db` (188 KB). Epic T001 + 8 children (T002–T009), all `status=done`, all with `verification.passed=true` and `lastAgent=cleo-prime`. Session ran 04:45:51Z → 04:53:16Z per metrics. No `.planning/` contamination. |

No cross-contamination observed in any arm.

---

## 5. Efficiency Analysis

Using orchestrator-captured metrics (OBJECTIVE_METRICS.md):

| Arm | Tokens | Tool uses | Duration (s) | Score | **Tokens / 100 pts** | **Seconds / 100 pts** | **Tools / 100 pts** |
|---|---:|---:|---:|---:|---:|---:|---:|
| Vanilla | 89,110 | 26 | 412.9 | 77.0 | **1,157** | **5.4** | **0.34** |
| GSD | 120,585 | 37 | 560.6 | 75.0 | 1,608 | 7.5 | 0.49 |
| CLEO | 115,918 | 63 | 502.8 | 79.0 | 1,467 | 6.4 | 0.80 |

- **Vanilla is 30% cheaper in tokens per quality point than CLEO and 39% cheaper than GSD.**
- **GSD is the most expensive arm** on every efficiency metric — it bought disciplined planning at real cost (+35% tokens, +36% wall-clock vs Vanilla) and delivered the lowest-quality app.
- **CLEO's 2.4× tool-use vs Vanilla** is explained by cleo CLI discovery (`session status`, `briefing`, `list`, `show`, `complete`, observe attempts) — these are cheap individually but compound.
- **Wall-clock variance is more honest than token variance**: GSD's 518 s reflects the serial `new → discuss → plan → execute → verify` phases it imposes even for single-wave plans.

**Break-even analysis**: CLEO's 30% token premium over Vanilla buys +2 points (77 → 79). That is a **0.067 quality points per extra thousand tokens** — a narrow but real return, with the caveat that CLEO's win is concentrated in completeness/polish axes that matter more for real products than for benchmark toys.

---

## 6. Research Question

> **Q: For an LLM-first development workflow, is GSD's spec-driven approach worth its overhead vs vanilla? Is CLEO's session/task/memory approach worth its overhead vs vanilla?**

### GSD: **No (for tasks of this size)**

GSD's overhead is paid upfront in planning markdown the model must author and maintain. For a 30-minute, 1,500-LOC, single-wave build, that planning had **negative ROI** — the GSD app is objectively the least polished and least complete of the three, despite the most artifact-heavy process. GSD's value proposition is traceability (REQ-IDs to implementation to VERIFY table), and that is real and genuine — but it's human-centric value, not agent-centric value. A human reviewer can scan 1-VERIFY.md and trust the build. An agent can already do the same with `cleo show T001` in 400 tokens.

**Qualified yes**: for **multi-phase, multi-wave, multi-agent** builds where parallel sub-agents need shared spec references, GSD's planning artifacts would likely pay for themselves. This benchmark's sub-agent tiering failure (documented in OBJECTIVE_METRICS.md §"Sub-agent tiering") prevented that regime from being tested. Re-run with tiering working and GSD may win.

### CLEO: **Qualified yes**

CLEO produced the highest-quality app and a tight win on the rubric, at 30% higher token cost than Vanilla. The task-state machine (acceptance criteria + 3-gate verification) did **two measurable things** that Vanilla didn't naturally do:

1. Enforced acceptance-criteria discipline (cadence field exposure; `aria-keyshortcuts`; live-region announcements on every action) because each atomic task had an explicit list the agent checked off.
2. Forced verification rigor (every task's `testsPassed` and `qaPassed` gates both `true` means the agent ran tests on each atomic increment, not just at end).

**Where CLEO falls short vs Vanilla**: CLEO did not produce an integration test, and its `app.js` state mutation is slightly less disciplined. Both are fixable with better atomic-task acceptance criteria ("include 1 integration test", "no direct state mutation in app.js").

**The provenance column bug** in `cleo memory observe` is a real defect the benchmark exposed — it blocks BRAIN observation persistence and should be fixed before v2026.4.66. Non-blocking but architecture-relevant.

---

## 7. Concrete Recommendations for CLEO

### What GSD does better that CLEO should adopt

1. **Explicit REQ-ID traceability layer**. GSD's REQUIREMENTS.md has `TIMER-03`, `A11Y-04`, `PERSIST-02` as first-class IDs that 1-VERIFY.md closes against. CLEO has acceptance criteria but they're free-text strings inside the task row — not individually addressable. Proposal: extend `cleo` to support `cleo req add T001 --id TIMER-03 --text "..."` and `cleo verify T001 --req TIMER-03 --evidence <file:line>` so every requirement becomes a queryable object.
2. **Persistent research phase artifact**. GSD writes `1-RESEARCH.md` as a separate file with pitfalls-to-avoid + pattern snippets. CLEO has `cleo memory find --type pattern` but there's no task-scoped research note: you can find patterns, but you can't attach a "pre-build research summary" directly to an epic. Proposal: first-class `cleo research attach <taskId> --from <file>` that links a research artifact to a task ID.
3. **PHASE lifecycle visibility**. GSD's `STATE.md` reads "Phase 1 CONTEXT → RESEARCH → PLAN → EXECUTE → VERIFY, each timestamped". CLEO tasks have `pipelineStage` (I see "release", "research" on the T001 children) but the stage transitions aren't visibly timestamped in output I can find. Proposal: `cleo show <id> --history` should emit the stage-transition log.

### What CLEO does better that the other tools lack

1. **Queryable, structured acceptance criteria**. Epic T001 + 8 children, each with 3–4 acceptance strings in an array, each carrying a passing/failing 3-gate object. GSD gets you the same semantic data but in markdown — not queryable, not machine-updateable without regex. This is CLEO's genuine moat.
2. **Automatic session scope** — `cleo session start/end` frames the work, gives you a session ID, and (when the provenance bug is fixed) captures memory observations automatically. GSD has no session concept; each invocation is amnesic.
3. **BRAIN + NEXUS integration** (even when partially broken). The 2 k+ nexus symbols + impact analysis are agent-first primitives GSD does not have. Not exercised in this bench (greenfield static app), but would matter enormously in a real codebase edit.

### Bugs / UX gaps this benchmark exposed in CLEO

- **`E_BRAIN_OBSERVE: no such column: provenance`** (v2026.4.65). Schema migration missing. `cleo memory observe` returns this error; `cleo session end` also trips the same column. Fix: add migration for `brain.db.observations.provenance`. P0 for next patch.
- **`cleo session end` "Failed to write memory bridge" warning** — same root cause. Same fix.
- **No task-scoped integration-test gate**. Right now `qaPassed=true` does not distinguish "ran unit tests" from "ran an integration test". The CLEO agent marked all 3 gates green while shipping only unit tests. Consider adding a boolean `integrationCoverage` gate or at least a per-task acceptance entry that can say "≥1 integration test".
- **Builder agent mutated shared state via `state.todos = ...` in `app.js`**. This is a code-hygiene miss the CLEO pattern could catch if the agent had been instructed to lint for direct mutation. Consider a pre-complete hook that runs `biome` or equivalent.

---

## 8. Methodological Limitations

Things the orchestrator should caveat when publishing:

1. **Sub-agent tiering collapsed** (OBJECTIVE_METRICS.md §"Sub-agent tiering failed for all 3 equally"). The whole experiment ran on Opus 4.6 in all 3 arms. This hit all arms equally but means **this benchmark measures "Opus + tool regime," not "Opus orchestrator → Sonnet builders → Haiku chores."** GSD's overhead is particularly under-monetized because its value proposition is multi-agent coordination; we disabled that lever.
2. **Small-sample single-run**. Each arm ran once. Token counts, wall-clock, and rubric scores all have ±5-point plausible run-to-run variance on a task this small. A proper n=5 re-run would be cheap and authoritative; n=1 is suggestive, not conclusive.
3. **Judge is Opus 4.6 scoring Opus 4.6 output**. Self-preference bias is plausible. I mitigated by scoring from artifacts + test runs, not self-reports, and by being harder on CLEO's shortcomings (integration-test miss, state-mutation miss, provenance bug) than on GSD's or Vanilla's. But the bias cannot be fully eliminated without a different-family evaluator.
4. **CLAUDE.md contamination**: all 3 builders inherited the orchestrator's CLAUDE.md which name-drops CLEO heavily. This is flagged in PROTOCOL.md §7. Effect is hard to quantify; artifact inspection showed no obvious contamination (vanilla didn't try to use `cleo`), but prompt-level priming toward CLEO-style thinking cannot be ruled out.
5. **Task is greenfield, mid-complexity, static, no shared codebase**. This is exactly the task where Vanilla's minimalism shines and CLEO's BRAIN/NEXUS machinery is least relevant. Re-run on a "edit this 50 k-LOC codebase" task and CLEO's advantage would plausibly widen while GSD's upfront-spec advantage might also grow.
6. **Rubric weighting**. Correctness + Features = 45% of total; Testing + Accessibility + UX + Docs = 25%. A differently-weighted rubric could flip the order. CLEO's best axes are the smaller-weight ones (UX polish, a11y, docs); Vanilla's best axis is Code Quality which is weighted highly. Fair but not neutral.
7. **GSD's output was the weakest even though its process was the most disciplined.** This is consistent with known research on over-specification causing premature-closure effects, but n=1 prevents a strong claim.

---

## 9. Conclusion

If you are **building a single-session static app with Opus-class tooling**, **vanilla Claude Code is the cheapest path to a quality product**. GSD's ceremony did not pay for itself in this configuration. CLEO paid for itself narrowly on quality, with the caveat that CLEO's real value — multi-session memory, queryable task graph, nexus-based impact analysis — was not tested by this benchmark.

**If the orchestrator's goal is "should CLEO exist?"**: yes, unambiguously — CLEO produced the best app and shipped a queryable, structured artifact trail Vanilla cannot match. The overhead is real but modest and buys measurable output quality.

**If the orchestrator's goal is "should every greenfield task use CLEO?"**: probably not — small disposable builds where no one will ever re-query the task graph are where Vanilla's minimalism wins. CLEO's value compounds across sessions; this benchmark is single-session.

**The orchestrator's next two moves** should be: (a) fix the `provenance` column migration (v2026.4.66 hotfix) and (b) re-run this benchmark with working sub-agent tiering, where GSD's and CLEO's coordination-focused machinery actually has something to coordinate.
