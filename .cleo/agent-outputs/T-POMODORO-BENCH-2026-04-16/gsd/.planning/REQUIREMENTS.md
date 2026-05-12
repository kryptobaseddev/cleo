# REQUIREMENTS — Todo + Pomodoro Timer (v1)

All requirements are hypotheses until shipped.

## v1 Requirements

### Todos (TODO)
- [ ] **TODO-01**: User can add a new todo from an input field (keyboard-activated with `N`)
- [ ] **TODO-02**: User can edit an existing todo inline (trigger with `Enter` on selected todo, commit on Enter/blur, cancel on Escape)
- [ ] **TODO-03**: User can mark a todo complete/incomplete via a checkbox (strike-through when complete)
- [ ] **TODO-04**: User can delete a todo (button + `Delete` key on selected todo)
- [ ] **TODO-05**: User can select a todo; selected state is visually distinct and feeds the timer

### Timer (TIMER)
- [ ] **TIMER-01**: Start/pause timer with Space key or Start/Pause button — only when a todo is selected
- [ ] **TIMER-02**: Default durations 25 min work / 5 min short break / 15 min long break
- [ ] **TIMER-03**: Long break triggers every 4th work cycle (work 1→short→work 2→short→work 3→short→work 4→long)
- [ ] **TIMER-04**: Circular SVG progress ring updates smoothly (requestAnimationFrame driven)
- [ ] **TIMER-05**: Audible chime (WebAudio oscillator, user-gesture gated) plays at each phase transition
- [ ] **TIMER-06**: Auto-advance into the next phase after chime; user can reset current phase

### Settings (SET)
- [ ] **SET-01**: Settings panel exposes work/short/long duration number inputs (minutes)
- [ ] **SET-02**: Changing settings takes effect at next phase start; values persist to localStorage

### Counters (CNT)
- [ ] **CNT-01**: Per-todo session counter increments on every completed work phase for the selected todo
- [ ] **CNT-02**: Daily total counter aggregates all completed work phases for today; rolls over at local midnight

### Theme (THEME)
- [ ] **THEME-01**: Theme toggle switches between dark and light explicitly
- [ ] **THEME-02**: On first load, theme follows `prefers-color-scheme`; after manual toggle, persisted choice wins
- [ ] **THEME-03**: Choice persists across reloads

### Persistence (PERSIST)
- [ ] **PERSIST-01**: Todos, settings, counters, selected todo id, and theme all survive reload via localStorage
- [ ] **PERSIST-02**: Graceful read of missing or corrupt storage (fall back to defaults, never crash)

### Keyboard & A11y (A11Y)
- [ ] **A11Y-01**: `Space` toggles timer, `N` focuses new-todo input, `Enter` edits selected, `Delete` deletes selected (shortcuts ignored while typing in inputs)
- [ ] **A11Y-02**: All interactive elements have `aria-label` or accessible text
- [ ] **A11Y-03**: Visible focus ring on every focusable element
- [ ] **A11Y-04**: Timer phase & remaining announced via `aria-live="polite"` region

### Responsive (RESP)
- [ ] **RESP-01**: Layout works at 360px (mobile first) and scales up to desktop with no horizontal scroll

### Testing (TEST)
- [ ] **TEST-01**: ≥3 automated tests via `node --test`
- [ ] **TEST-02**: Coverage — timer phase math + long-break-on-4 + pause/resume correctness
- [ ] **TEST-03**: Coverage — todo CRUD state transitions
- [ ] **TEST-04**: Coverage — localStorage round-trip (serialize → deserialize → deep-equal)

### Docs (DOC)
- [ ] **DOC-01**: README with: run, test, architecture sections

## v2 (Deferred)
- Drag reorder, notifications API, PWA manifest, categories/tags

## Out of Scope
- Cloud sync / accounts — client-only by spec
- Remote analytics — privacy + no server

## Traceability
| REQ-IDs | Phase |
|---|---|
| TODO-01..05, TIMER-01..06, SET-01..02, CNT-01..02, THEME-01..03, PERSIST-01..02, A11Y-01..04, RESP-01, TEST-01..04, DOC-01 | Phase 1 (single-phase coarse build) |
