# Shared Feature Spec (IDENTICAL for all 3 conditions)

Build a production-ready **Todo + Pomodoro Timer** web app, client-side only, deployable as static files.

## Functional requirements

1. **Todos**: add, edit (inline), delete, mark complete
2. **Pomodoro timer** attached to any selected todo
   - 25 min work / 5 min short break / 15 min long break (every 4th cycle)
   - All three durations configurable in a settings panel
   - Visual circular progress ring that updates smoothly
   - Audible chime when a phase ends
3. **Counters**: session count per todo + daily total
4. **Theme**: dark / light with OS auto-detect + manual toggle, persists
5. **Persistence**: todos, settings, counters survive reload (localStorage)
6. **Keyboard shortcuts**: `Space` start/pause timer, `N` new todo, `Enter` edit selected, `Delete` delete selected
7. **Responsive**: mobile-first layout, works on 360px width up to desktop
8. **Accessibility**: ARIA labels on all interactive elements, full keyboard nav, visible focus ring

## Technical constraints

- Vanilla HTML/CSS/JS OR a lightweight framework (Svelte, Preact, Alpine, etc.) of your choice — but keep build friction minimal
- No server component. Runs with `python3 -m http.server` or `npx serve`
- No node_modules committed; no build artifacts in source folder (dist/ OK if you compile, but build config must be minimal)

## Deliverables

- `index.html` plus supporting files
- `README.md` with (a) how to run it, (b) how to run tests, (c) a short architecture section
- **≥3 automated tests** (any runner: vitest, node:test, browser-runnable HTML, etc.) covering:
  - timer math (phase durations, long-break every 4 cycles, pause/resume correctness)
  - todo CRUD (add/edit/delete/complete state transitions)
  - localStorage round-trip (serialize → write → read → deserialize → equal)
- Sensible file tree (not 50 files, not 1 file with 2000 lines)

## Budget

- **30 minutes wall-clock** — do NOT exceed. If running over, stop adding features and ship what works + tests + README.

## Self-report (at the end of your work)

Report these values (the orchestrator + an independent judge will verify against your folder):

- Final file tree (output of `find . -type f -not -path './.git/*' -not -path './node_modules/*' -not -path './.cleo/*' -not -path './.claude/*' -not -path './.planning/*' | sort`)
- Total LOC across source files (`wc -l`)
- Test command + test result (pass/fail counts)
- Sub-agents you spawned (count by model)
- Primary commands you invoked
- Self-score on the rubric (see PROTOCOL.md)
