# Phase 1, Plan 1 — Atomic Task List

Plan ID: **1-1-ship-v1**
Owning wave: **Wave 1** (single sub-agent, model = sonnet)
Rationale: All files are tightly coupled (one UI, one app.js, shared storage schema). Splitting across sub-agents risks incoherent diff in 30-min budget.

## Tasks (XML)

```xml
<plan id="1-1-ship-v1" wave="1" model="sonnet">
  <task id="T01" file="lib/storage.js" size="S">
    Pure module. Export: `DEFAULTS`, `load()`, `save(state)`, `clear()`.
    - STORAGE_KEY = "pomodoro.v1"
    - DEFAULTS covers: todos[], settings{work:25,short:5,long:15}, counters{}, dailyTotal:0, dailyTotalDate:null, selectedId:null, theme:null
    - load: JSON.parse wrapped in try/catch, merge with DEFAULTS to tolerate schema drift
    - save: try/catch; swallow QuotaExceeded / SecurityError
    - exports must run in Node (no window) → guard localStorage with `typeof globalThis.localStorage`
  </task>

  <task id="T02" file="lib/timer.js" size="M">
    Pure state machine. Export:
    - `createTimer(durations)` → {phase:'idle', remainingMs:null, running:false, cyclesCompleted:0, durations, startedAt:null, accumulatedMs:0}
    - `phaseDuration(state, phase?)` → ms (uses durations[phase] * 60_000)
    - `nextPhase(state)` → new state; if current phase is 'work', increment cyclesCompleted; next phase is 'long' when newCycles%4===0, else 'short'; if current is a break, next is 'work'
    - `start(state, nowMs)` → running=true, startedAt=nowMs - accumulatedMs, if phase=='idle' advance to 'work', set remainingMs = phaseDuration
    - `pause(state, nowMs)` → running=false, accumulatedMs = nowMs - startedAt
    - `reset(state)` → same phase, remainingMs = phaseDuration, accumulatedMs=0, running=false, startedAt=null
    - `tick(state, nowMs)` → returns {state, fired} where fired = 'phaseEnd' when remainingMs <= 0, else null. On phaseEnd, returns next-phase state auto-started.
  </task>

  <task id="T03" file="lib/todos.js" size="S">
    Pure CRUD. Export:
    - `createTodo(text)` → {id, text, completed:false, sessionCount:0, createdAt:Date.now()}  (id = crypto.randomUUID() if available, else Math.random)
    - `addTodo(list, text)`, `editTodo(list, id, text)`, `deleteTodo(list, id)`, `toggleTodo(list, id)`, `incrementSession(list, id)`
    - All return new arrays (immutable)
  </task>

  <task id="T04" file="index.html" size="M">
    - `<!doctype html>`, lang=en, meta viewport
    - Inline `<script>` in `<head>` that applies persisted theme BEFORE body paints (reads `localStorage.getItem('pomodoro.theme')`, falls back to matchMedia)
    - `<link rel="stylesheet" href="styles.css">`
    - Body: header (app title + theme toggle + settings button), main = two sections (todos + timer), footer (daily total, author note)
    - Todo list: `<form id="new-todo-form">` with `<input id="new-todo-input">`, `<ul id="todo-list" role="list">`
    - Timer section: SVG ring (viewBox 0 0 200 200, two circles r=90), `<div id="timer-display" role="timer" aria-live="polite">`, start/pause/reset buttons, phase label
    - Settings: `<dialog id="settings">` with 3 number inputs, save/cancel buttons
    - All buttons have aria-label
    - Script at end: `<script type="module" src="app.js"></script>`
  </task>

  <task id="T05" file="styles.css" size="M">
    - CSS reset (box-sizing, body margin 0, system font stack)
    - CSS vars for both themes under `:root` and `:root[data-theme="dark"]`
    - Mobile-first: single column; @media (min-width: 720px) two-column grid
    - Ring styling: transform rotate(-90deg), transition stroke-dashoffset 0.2s linear
    - `:focus-visible` outline: 2px solid accent
    - Strike-through completed todos; selected todo has a left-border accent
    - Button base style (padding, radius, hover, disabled)
    - Dialog backdrop dim
  </task>

  <task id="T06" file="app.js" size="L">
    - ES module importing from lib/
    - State object: {todos, settings, selectedId, counters, dailyTotal, dailyTotalDate, timer}
    - load() on boot; save() on every mutation
    - Render functions: renderTodos(), renderTimer(), renderDailyTotal()
    - Event listeners:
      - new-todo-form submit
      - click on ul (event delegation for select / toggle / delete / edit)
      - start/pause/reset buttons
      - settings dialog: open, submit (validate 1..120)
      - theme toggle
      - global keydown (Space, N, Enter, Delete) with isTyping() guard
    - rAF loop advances timer when running; calls chime() + incrementSession() on phaseEnd
    - AudioContext lazy-init on first Space
    - Daily total rollover check on load + on every increment
  </task>

  <task id="T07" file="tests/timer.test.js" size="M">
    Cover:
    - default durations (25/5/15 min in ms)
    - nextPhase: after work → short (cycle 1); after 4th work → long; after break → work
    - start → pause → start preserves accumulatedMs (no drift)
    - reset zeros accumulator
    - phaseDuration computed from settings
  </task>

  <task id="T08" file="tests/todos.test.js" size="S">
    Cover: addTodo, editTodo, toggleTodo, deleteTodo, incrementSession — each asserts correct state transition and immutability.
  </task>

  <task id="T09" file="tests/storage.test.js" size="S">
    Provide a `fakeStorage` polyfill on globalThis.localStorage for the test process.
    Cover: save→load round-trip equals; corrupt JSON returns DEFAULTS; missing key returns DEFAULTS.
  </task>

  <task id="T10" file="README.md" size="S">
    Sections: Quick Start (python3 -m http.server 8080), Tests (node --test tests/), Architecture (one-paragraph rundown of lib/ split, rAF timer, CSS-var theming).
  </task>
</plan>
```

## Success criteria (executor must satisfy)
- All 10 files exist with the content above.
- `node --test tests/` from project root exits 0.
- `index.html` loads in a browser with no console errors.
- Mobile viewport at 360px shows no horizontal scroll.
