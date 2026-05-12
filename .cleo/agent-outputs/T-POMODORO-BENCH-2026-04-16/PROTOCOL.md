# Pomodoro Head-to-Head Benchmark Protocol

**Benchmark**: Vanilla Claude Code vs Claude Code + GSD vs Claude Code + CLEO
**Date**: 2026-04-16
**Operator**: cleo-prime (main orchestrator)
**Judge**: SUPREME analysis agent (independent)

---

## 1. Hypothesis

CLEO's agent-first task/session/memory tooling produces better outcomes per unit of time/tokens than (a) unstructured vanilla Claude Code, and (b) the human-centric spec-driven GSD workflow, when executing a mid-complexity web-app build.

## 2. The Task (IDENTICAL for all three)

Build a production-ready **Todo + Pomodoro Timer web app**, client-side only, deployable as static files. Requirements (verbatim in all three prompts):

- Add / edit / delete / complete todos with inline editing
- Attach a Pomodoro timer to any todo (25 min work / 5 min break / 15 min long break — configurable in settings)
- Visual circular progress timer; audible chime at phase transition
- Session counter per todo; daily session total
- Dark / light mode with OS auto-detect + manual toggle
- Persist todos + settings + session counts in localStorage
- Keyboard shortcuts: `Space` start/pause, `N` new todo, `Enter` edit, `Delete` delete
- Mobile-first responsive layout
- Accessibility: ARIA labels, keyboard navigation, visible focus states
- Vanilla HTML/CSS/JS OR a lightweight framework of the agent's choice
- `README.md` with run instructions and architecture notes
- **At least 3 automated tests** verifying core logic (timer math, todo CRUD, localStorage round-trip)
- Sensible file tree; no node_modules or build artifacts committed
- Must run under `python3 -m http.server` or equivalent static server

**Hard budget**: 30 minutes wall-clock per agent.
**Deliverable**: All files under the agent's assigned folder.
**Self-report at end**: elapsed time, files created, lines of code, test results, rough token count, tool inventory used.

## 3. Three Conditions

| # | Name    | Folder                         | Tool regime |
|---|---------|--------------------------------|-------------|
| A | Vanilla | `/tmp/pomodoro-bench/vanilla/` | Base tools only: Read/Write/Edit/Bash/Glob/Grep. NO cleo, NO GSD. |
| B | GSD     | `/tmp/pomodoro-bench/gsd/`     | Base tools + GSD slash commands (installed via `npx get-shit-done-cc --claude --local`). Must use `/gsd:*` workflow. NO cleo. |
| C | CLEO    | `/tmp/pomodoro-bench/cleo/`    | Base tools + `cleo` CLI (v2026.4.65). Must use cleo session/task/memory commands. NO GSD. |

## 4. Model Allocation (all three conditions)

- **Planning phase**: Opus 4.6 (deep reasoning, architecture, spec definition)
- **Build phase**: Sonnet 4.6 (fast codegen, refactors)
- **Atomic tasks**: Haiku 4.5 (one-shot edits, small files, chores)

Implemented by spawning each builder as `Opus 4.6`; each builder then delegates via the Agent tool with `model: "sonnet"` for build work and `model: "haiku"` for atomic tasks.

## 5. Measurement

- **Time**: orchestrator records unix-epoch `t_start` just before Agent-tool spawn and `t_end` when it returns. Elapsed = t_end - t_start.
- **Tokens**: each builder self-reports estimate at end; triangulated against lines-of-output proxy.
- **Artifacts**: full file listing + line counts captured post-run.
- **Outcome quality**: SUPREME judge scores against the rubric below using only the files in each folder — blind re-examination, not trusting agent self-reports.

## 6. Rubric (100 pts)

| Dimension | Pts | What's measured |
|-----------|----:|-----------------|
| Correctness | 25 | App runs. Timer math correct. Todo CRUD works. localStorage round-trips. |
| Feature completeness | 20 | All 10 requirements present and functional. |
| Code quality | 20 | Readable, DRY, no obvious anti-patterns, proper separation of concerns. |
| Architecture | 10 | File tree sensible; HTML/CSS/JS cleanly separated or modules used well. |
| Testing | 10 | ≥3 tests exist, test a meaningful thing, pass when run. |
| Accessibility | 5 | ARIA on interactive elements, keyboard nav, focus visible. |
| UX polish | 5 | Responsive, dark/light toggle works, visible progress indicator. |
| Documentation | 5 | README is clear, accurate, includes architecture notes. |

Per-axis score reported; weighted sum is the headline.

## 7. Controls & Known Confounds

- **CLAUDE.md contamination**: all three agents inherit parent session's CLAUDE.md (which contains CLEO context). Mitigation: builder prompts are explicit about which tool regime the agent must use, and SUPREME verifies tool usage from artifacts (not self-report).
- **Folder CWD**: each agent is instructed to `cd` to its assigned folder and never leave it.
- **Network**: GSD install via `npx` is allowed to use network. Otherwise agents should avoid network-dependent choices.
- **Parallelism**: all 3 builders run concurrently. Acceptable because work is strictly isolated by folder and no shared state. Wall-clock is measured per-agent, not per-batch.

## 8. Phases (orchestrator-level)

1. Provision folders, install GSD, `cleo init`.
2. Dispatch 3 builders in parallel via Agent tool.
3. On return: snapshot each folder (tree, LOC, test run).
4. Dispatch SUPREME judge with read-only access to all 3 folders + protocol.
5. Orchestrator synthesizes final report.
