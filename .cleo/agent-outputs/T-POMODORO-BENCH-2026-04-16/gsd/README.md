# Todo + Pomodoro

A client-side-only **Todo + Pomodoro timer** with persistent state, dark/light theming, keyboard shortcuts, and a smooth circular progress ring. No build step, no server, no dependencies.

## Quick start

```bash
# Any static-file server works. Pick one:
python3 -m http.server 8080
# or
npx serve
```

Open `http://localhost:8080/` (or whatever your server prints). Your browser needs to support ES modules (any modern browser).

## Tests

```bash
node --test 'tests/*.test.js'
```

(31 assertions pass on Node 20+.)

This runs three test files covering:

- **`tests/timer.test.js`** — phase durations, `nextPhase` cycling, long-break-on-4 rule, pause/resume no-drift, reset, `setDurations`, `formatTime`
- **`tests/todos.test.js`** — add / edit / delete / toggle / incrementSession state transitions and immutability
- **`tests/storage.test.js`** — localStorage round-trip, corrupt-JSON fallback, throwing-storage resilience, daily-total rollover

No install needed — uses Node 20+'s built-in `node:test` runner.

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Start / pause timer |
| `N` | Focus the new-todo input |
| `Enter` | Edit the selected todo |
| `Delete` | Delete the selected todo |
| `Escape` | Cancel inline edit |

Shortcuts auto-disable while typing in inputs.

## Architecture

```
index.html     ← markup, inline theme-pre-paint script, dialog
styles.css     ← CSS custom properties for dark/light, mobile-first grid
app.js         ← DOM wiring: render, events, rAF timer loop, AudioContext chime
lib/
  timer.js     ← Pure state machine (phases, start/pause/tick/reset)
  todos.js     ← Pure immutable CRUD
  storage.js   ← Safe localStorage I/O with defaults + rollover
tests/
  timer.test.js
  todos.test.js
  storage.test.js
```

### Design choices

- **Vanilla ES modules** — zero build friction. Static files deploy anywhere.
- **Pure logic in `lib/`** — every state transition is a pure function, trivially testable in Node without jsdom.
- **`requestAnimationFrame` + wall-clock diff** — avoids the classic `setInterval` drift. Pausing captures `accumulatedMs`; resuming re-anchors `startedAt` so no time is lost.
- **SVG ring via `stroke-dashoffset`** — scales crisply, tiny DOM footprint, GPU-friendly transitions.
- **WebAudio oscillator chime** — no audio asset to fetch. `AudioContext` is created lazily on the first user gesture so it's never autoplay-blocked.
- **CSS custom properties + `data-theme`** — theme toggling is a single attribute change. An inline script in `<head>` applies the saved theme before the first paint to avoid FOUC.
- **`node:test`** — ships with Node 20+. Zero install, zero config.

### Data model (stored under `localStorage["pomodoro.v1"]`)

```jsonc
{
  "todos": [{ "id": "...", "text": "...", "completed": false, "sessionCount": 0, "createdAt": 0 }],
  "settings": { "work": 25, "short": 5, "long": 15 },
  "counters": { "<todoId>": 2 },
  "dailyTotal": 3,
  "dailyTotalDate": "2026-04-15",
  "selectedId": "...",
  "theme": "dark"
}
```

Theme is additionally cached under `localStorage["pomodoro.theme"]` so the pre-paint script can apply it before `app.js` loads.

### Accessibility

- Every interactive element has an `aria-label`.
- Timer area is `role="timer"` with `aria-live="polite"` so screen readers announce phase transitions.
- Focus ring visible on every focusable element (`:focus-visible`).
- Full keyboard navigation; shortcuts gracefully disable inside inputs.
- Respects `prefers-reduced-motion` (ring transition disabled).

## License

MIT — benchmark artifact.
