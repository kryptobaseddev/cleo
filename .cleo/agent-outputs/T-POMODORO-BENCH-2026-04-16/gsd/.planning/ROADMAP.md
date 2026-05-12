# ROADMAP — Todo + Pomodoro Timer

Granularity: **Coarse** — single phase (benchmark scope + 30-min budget).

## Phases

| # | Phase | Goal | Requirements | Success Criteria |
|---|---|---|---|---|
| 1 | **Ship v1** | Static web app that meets all v1 requirements and passes ≥3 automated tests | ALL v1 REQs | 5 |

## Phase Details

### Phase 1: Ship v1

**Goal**: Deliver a working static web app covering every v1 requirement with tests and README in one coherent build wave.

**Requirements**: TODO-01..05, TIMER-01..06, SET-01..02, CNT-01..02, THEME-01..03, PERSIST-01..02, A11Y-01..04, RESP-01, TEST-01..04, DOC-01

**Success Criteria**:
1. Opening `index.html` loads the app; user can add a todo, select it, start a 25-min work timer that ticks and animates.
2. `node --test tests/` reports ≥3 passing tests covering timer math, todo CRUD, and localStorage round-trip.
3. Reload of the app restores todos, settings, counters, selected todo, and theme exactly.
4. Mobile (360px) layout has no horizontal scroll; focus ring is visible on every interactive element; all interactives have aria-labels.
5. `README.md` documents run + test + architecture.

**Build waves** (for `/gsd:execute-phase`):
- **Wave 1 (sonnet, 1 sub-agent)**: Write `index.html`, `styles.css`, `lib/timer.js`, `lib/todos.js`, `lib/storage.js`, `app.js`, `tests/*.test.js`, `README.md`. These are tightly coupled — one sub-agent owns the coherent build to avoid divergence in 30 min.

## State

- Phase 1: **pending** → in progress → complete
