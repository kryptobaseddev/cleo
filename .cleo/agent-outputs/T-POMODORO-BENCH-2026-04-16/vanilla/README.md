# Focus — Todo + Pomodoro

A client-side todo list with a built-in Pomodoro timer. Vanilla HTML/CSS/JS,
zero build step, zero runtime dependencies.

## Run the app

```bash
# from this folder
python3 -m http.server 8000
# then open http://localhost:8000
```

Any static file server works (`npx serve`, `caddy file-server`, etc.).

## Run the tests

```bash
npm test
# or directly:
node --test tests/*.test.mjs
```

Tests use Node's built-in `node:test` runner — no install step required
(Node 18+).

## Features

- Todos: add, inline edit (double-click or Enter on selected), delete, complete
- Pomodoro timer attached to the selected todo
  - 25 / 5 / 15 defaults (Work / Short break / Long break)
  - Long break every 4th work phase
  - All durations + chime configurable via the Settings dialog
  - Visual circular progress ring
  - Gentle WebAudio chime on phase end
- Per-todo session counter + daily total (resets on new calendar day)
- Theme toggle: auto (OS) → light → dark (persists)
- `localStorage` persistence for todos, settings, counters, and theme
- Keyboard shortcuts:
  - `Space` — start/pause timer
  - `N` — new todo
  - `Enter` — edit selected todo (double-click also works)
  - `Delete` — delete selected todo
- Responsive: single column on mobile (360px), two columns on tablet+
- Accessible: ARIA labels on all interactive elements, visible focus ring,
  `aria-live` announcements on phase changes, keyboard-only full navigation

## Architecture

```
index.html     — shell markup
styles.css     — CSS tokens for light/dark/auto themes, responsive grid
src/
  store.js     — pure todo CRUD + localStorage serialization (immutable)
  timer.js     — pure Pomodoro state machine with injected clock + scheduler
  theme.js     — theme cycle + persistence
  chime.js     — lazy WebAudio two-tone chime
  app.js       — DOM wiring, keyboard shortcuts, integration
tests/
  store.test.mjs       — CRUD, selection, daily rollover, serialize round-trip
  timer.test.mjs       — phase math, 4-cycle long break, pause/resume, skip, reset
  integration.test.mjs — end-to-end work completion → session counter → persist
```

### Design choices

- **Pure domain logic**: `store.js` and `timer.js` are pure ES modules with
  zero DOM references. All side effects (localStorage, setTimeout) are
  injected so they can be swapped for fakes in Node tests.
- **Deadline-based timer**: the timer stores an absolute deadline timestamp
  and schedules a single timeout at a time. This avoids drift vs. a 1Hz
  setInterval and stays accurate even if the tab is briefly throttled.
- **Immutable-style state**: every store mutation returns a new object, which
  makes diffing and testing trivial.
- **Auto-pause between phases**: the timer stops at each phase boundary so
  the user can acknowledge the transition. Start with Space to resume.
- **Progressive enhancement**: the app is a static HTML/CSS page that
  works with JavaScript disabled (the markup is all present; the controls
  just won't do anything).
