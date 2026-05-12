# Phase 1 — CONTEXT (Implementation Decisions)

These are the locked decisions downstream planner + executor agents must follow.

## Stack & Tooling
- **Language**: Vanilla JavaScript (ES modules, no TypeScript, no bundler).
- **Markup**: Semantic HTML5 in a single `index.html`.
- **Styles**: One `styles.css` using CSS custom properties for theming and container queries only where helpful.
- **Tests**: `node --test` from Node 20+ on plain `.test.js` files (no vitest, no jest, no jsdom).
- **Serve**: `python3 -m http.server 8080` or `npx serve`.

## File Layout (locked)
```
/tmp/pomodoro-bench/gsd/
├── index.html
├── styles.css
├── app.js                 # DOM wiring / event handlers — imports from lib/
├── lib/
│   ├── timer.js           # Pure timer state machine (no DOM)
│   ├── todos.js           # Pure todo CRUD (no DOM)
│   └── storage.js         # localStorage round-trip + schema defaults
├── tests/
│   ├── timer.test.js
│   ├── todos.test.js
│   └── storage.test.js
└── README.md
```
Rationale: pure-logic modules in `lib/` are importable by Node tests without any browser shim. `app.js` touches DOM and is not tested — DOM coverage is out of scope for 30 min.

## Timer Model
- **Phase machine**: `idle → work → (short | long) → work → …`
  - Long break selected when completed work cycles % 4 === 0
- **Representation**: `{ phase, remainingMs, running, cyclesCompleted, durations: {work, short, long}, selectedTodoId }`
- **Tick**: `requestAnimationFrame` loop in `app.js`, computes `elapsed = performance.now() - startedAt` and derives `remainingMs = phaseMs - elapsed + pausedAccum`
- **Pure functions** (in `lib/timer.js`, all testable):
  - `createTimer(durations)` → initial state
  - `nextPhase(state)` → returns new state after current phase ends (handles long-break-on-4)
  - `phaseDuration(state)` → ms for current phase
  - `tick(state, nowMs)` → returns `{ state, fired: "phaseEnd"|null }`
  - `start(state, nowMs)`, `pause(state, nowMs)`, `reset(state)`

## Todos Model
- `{ id, text, completed, sessionCount, createdAt }`
- Pure CRUD in `lib/todos.js`: `addTodo`, `editTodo`, `deleteTodo`, `toggleTodo`, `incrementSession`

## Storage
- Single key: `pomodoro.v1` → JSON blob `{ todos, settings, counters, selectedId, theme, dailyTotal, dailyTotalDate }`
- `storage.load()` returns defaults on missing/corrupt data; `storage.save(state)` serializes
- Daily total roll-over: if `dailyTotalDate !== todayISO`, zero `dailyTotal` and update date

## UI
- **Layout**: Single column on mobile (<720px), two-column (todo list + timer) on desktop
- **Timer ring**: SVG 200x200 with two concentric circles; outer uses `stroke-dasharray=circumference` and animated `stroke-dashoffset` based on `remainingMs/phaseMs`
- **Colors**: CSS vars `--bg`, `--fg`, `--accent`, `--muted`, `--ring-track`, `--ring-progress`. Light + dark sets under `:root` and `[data-theme="dark"]`
- **Chime**: Short oscillator burst (sine 880 Hz 150ms) via a singleton `AudioContext`, created on first user gesture
- **Focus ring**: `*:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`

## Keyboard Shortcuts
Attached at `window` level but short-circuited when `document.activeElement` is an `<input>` or `[contenteditable]`, except `Escape` (always cancels edit) and `Space` inside buttons which is native.
- `Space` → start/pause timer (requires a selected todo)
- `N` → focus the new-todo input
- `Enter` (when a todo row is selected and not editing) → enter inline edit mode
- `Delete` (when a todo row is selected and not editing) → delete todo after confirm

## Accessibility
- Every button has `aria-label`
- Timer display is wrapped in `<div role="timer" aria-live="polite">`
- List is `<ul role="list">`; each row is `<li>` with a checkbox, a text button for select/edit, and a delete button
- Focus ring visible; focus moves to new todo input after add

## Persistence Strategy
- `storage.save` called on every mutation (debounced 200ms via `setTimeout` micro-pattern for safety, though direct save is fine for small blobs)
- On load: restore theme BEFORE first paint to avoid flash; then hydrate state
- Theme: `localStorage["pomodoro.theme"]` ("light" | "dark" | absent). Absent → match OS.

## Tests (must cover)
1. `timer.test.js`:
   - Default phase durations
   - `nextPhase` cycles work→short 3x then work→long on 4th cycle
   - `pause` then `start` preserves remaining time (no drift)
   - Phase duration configurable
2. `todos.test.js`:
   - Add creates a todo with unique id, incomplete, sessionCount=0
   - Edit changes text but preserves id/sessionCount
   - Delete removes by id
   - Toggle flips completed
   - IncrementSession adds 1
3. `storage.test.js`:
   - Round-trip serialize/deserialize equals original
   - Corrupt JSON falls back to defaults
   - Missing key returns defaults
4. Additional assertions as natural, targeting ≥10 total passes.

## Out of Scope (locked)
- TypeScript, bundlers, frameworks
- Drag reorder, categories, tags
- Notifications API
- PWA manifest
- Sound file assets
- Any network calls

## Open Risks
- `localStorage` unavailable (private mode) — fall back to in-memory state; log a warning
- AudioContext auto-play blocked — first chime silent, subsequent ones work because context is created on first user click/keydown

## Downstream Instructions
- Planner: produce atomic tasks that fit into a single build wave owned by one sonnet sub-agent.
- Executor: one sub-agent writes every file in one batch for coherence.
- Verifier: run `node --test tests/` and open `index.html` via `file://` (or just confirm markup/JS loads) to exercise the UAT checklist.
