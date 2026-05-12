# Pomodoro Todos

A production-ready, client-side Todo + Pomodoro timer web app. No framework,
no build step, no node_modules — just vanilla HTML/CSS/ES modules.

## Run it

From this folder:

```bash
# Python (stdlib)
python3 -m http.server 8080
# or: npx serve -l 8080
```

Open <http://localhost:8080>.

It's a fully static app — you can also upload the folder to any static host
(GitHub Pages, Netlify, S3).

## Run the tests

Tests use the Node 18+ built-in `node:test` runner. **No install step**:

```bash
node --test tests/
```

Expected: all suites pass (timer math, todo CRUD, localStorage round-trip).

## Features

- **Todos** — add, inline-edit (double-click or `Enter`), delete, complete
- **Pomodoro** — 25/5/15 default; every 4th work cycle earns a long break
- **Configurable** — all phase durations + long-break cadence in the settings panel
- **Visual ring** — SVG circular progress updates smoothly each animation frame
- **Chime** — WebAudio two-tone cue at each phase end
- **Counters** — per-todo session count + running daily total (rolls at midnight)
- **Theme** — auto (OS) / light / dark, cycled via the header button; persists
- **Persistence** — todos, settings, counters, theme, selection survive reloads
- **Keyboard** — `Space` start/pause, `N` new todo, `Enter` edit selected, `Delete` delete selected
- **Responsive** — mobile-first, works at 360px width and up
- **Accessible** — ARIA labels on all controls, visible focus rings, full keyboard nav, live-region announcements, skip link

## Architecture

```
index.html         app shell: landmarks, timer UI, todo form, settings drawer
styles.css         CSS custom properties for theming, mobile-first layout
app.js             wires pure modules to the DOM; tick loop; keyboard; chime
src/
  storage.js       pure localStorage load/save with schema version + memory store
  todos.js         pure CRUD (immutable); no DOM coupling
  timer.js         pure phase state machine; deterministic via injected `now`
tests/
  timer.test.js    phase durations, cadence, pause/resume, tick, settings
  todos.test.js    CRUD transitions + edge cases
  storage.test.js  defaults, round-trip, merge-with-defaults, malformed input
```

### Design choices

1. **Pure modules are unit-testable without a browser.** `timer.js` takes
   `now` as a parameter rather than reading `Date.now()` internally; this
   lets tests simulate elapsed time deterministically. `storage.js` accepts
   any object with `{getItem, setItem}` so tests use a memory store instead
   of spinning up jsdom.

2. **No framework, no build.** ES modules natively supported by every modern
   browser. `python3 -m http.server` is enough to run it locally. Shipping
   is copy-the-folder.

3. **State is plain JSON.** `defaultState()` is the schema. A `schemaVersion`
   field gives us a forward-migration seam. `mergeWithDefaults` tolerates
   older payloads by filling in new fields.

4. **Progress ring is a single SVG `<circle>`** with `stroke-dasharray` +
   `stroke-dashoffset`. The tick loop runs inside `requestAnimationFrame`
   for smooth updates without timer drift.

5. **Chime uses WebAudio directly** — no audio files to ship.

## Limitations / known non-goals

- No cross-tab sync (each tab has its own copy of state).
- No real-time drift correction across page-visibility changes; the timer
  is driven by wall-clock diffs so it's still accurate when the tab
  regains focus.
- No server — this is intentionally a static app.
