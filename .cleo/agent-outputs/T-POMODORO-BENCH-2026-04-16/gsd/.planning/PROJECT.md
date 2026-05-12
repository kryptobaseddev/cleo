# PROJECT: Todo + Pomodoro Timer

## What This Is

A **production-ready, client-side-only Todo + Pomodoro Timer web app**. Users manage a todo list and run a Pomodoro timer attached to any selected todo, with cycle-aware long breaks, session counters, themes, and full keyboard/accessibility support. Deployable as static files — no server, no build step required.

## Core Value

**The ONE thing that must work**: A user can create a todo, start a Pomodoro timer on it, and see the timer count down smoothly with audible/visual phase transitions and session-count accrual that survives a reload.

## Target Users

Solo knowledge workers and students who want a focused, distraction-free Pomodoro tool with persistent todos on any device (mobile 360px → desktop).

## Context

- Benchmark project. 30 minute wall-clock budget. Static web app only.
- No server, no backend, no user accounts. Everything lives in `localStorage`.
- Tech preference: **Vanilla HTML + CSS + JS (ES modules)**. Keeps build friction at zero, maximizes portability, deployable with `python3 -m http.server`.
- Tests: `node:test` (built into Node 20+, zero install).
- No node_modules committed. No bundler.

## Requirements

### Validated

(None yet — ship to validate)

### Active

- [ ] Todos: add / inline-edit / delete / toggle complete
- [ ] Pomodoro timer attached to selected todo (25/5/15 default; long break every 4th cycle)
- [ ] Settings panel — configurable work/short/long durations
- [ ] Circular progress ring (SVG stroke-dashoffset animation)
- [ ] Audible chime at phase transitions (WebAudio oscillator)
- [ ] Per-todo session counter + daily total
- [ ] Dark/light theme with OS auto-detect and manual toggle, persisted
- [ ] localStorage persistence for todos, settings, counters
- [ ] Keyboard shortcuts: Space (start/pause), N (new todo), Enter (edit selected), Delete (delete selected)
- [ ] Responsive 360px → desktop
- [ ] ARIA labels on every interactive element, visible focus ring, full keyboard nav
- [ ] >=3 automated tests (timer math, todo CRUD, localStorage round-trip)
- [ ] README with run/test/architecture sections

### Out of Scope

- Accounts, sync, cloud — client-only by spec
- Notifications API — chime only
- Task categories / projects / tags — simple flat list
- Drag-reorder — ship basic list first
- PWA / offline manifest — static-file deploy is enough

## Key Decisions

| Decision | Rationale | Outcome |
|---|---|---|
| Vanilla ESM, no framework | Zero build friction, fastest ship, matches spec's "keep build friction minimal" | — Pending |
| `node:test` for tests | Built-in, no install, runs headless logic tests for pure-function modules | — Pending |
| Split JS into pure-logic `lib/` modules + DOM `app.js` | Makes logic testable in Node without jsdom | — Pending |
| SVG circular ring via stroke-dashoffset | Scales, crisp on retina, tiny DOM | — Pending |
| WebAudio oscillator chime (no audio file) | Zero binary assets, instant load | — Pending |
| CSS custom properties for theming | Theme = swap `:root` vars; persist one key | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries. For this benchmark, single-phase execution.

---
*Last updated: 2026-04-15 after initialization*
