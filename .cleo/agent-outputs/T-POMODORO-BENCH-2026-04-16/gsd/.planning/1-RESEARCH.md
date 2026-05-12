# Phase 1 — RESEARCH

Brief research notes informing the plan. Since domain is well-known, research is shallow by design (YOLO + coarse + budget-constrained).

## Known Patterns

### Pomodoro state machine
Standard Pomodoro:
- 25 min work → 5 min short break → 25 min work → 5 min short break → 25 min work → 5 min short break → 25 min work → **15 min long break** → loop
- Long break every 4 completed work sessions.
- Cycle counter only increments on **work** phase completion.

### Circular progress ring in SVG
- Two overlapping `<circle>` elements; background is `stroke` alone with full circumference, foreground uses `stroke-dasharray: C; stroke-dashoffset: C * (1 - fraction)` where `C = 2πr`.
- Rotate the ring -90deg so progress starts at 12 o'clock.
- Update `stroke-dashoffset` inside `requestAnimationFrame`.

### WebAudio chime pattern
```
const ctx = new (window.AudioContext || window.webkitAudioContext)();
function chime(freq = 880, ms = 150) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms/1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + ms/1000);
}
```
`AudioContext` must be constructed (or resumed) on a user gesture — create lazily on first Space press.

### Timer accuracy
Never trust `setInterval` for Pomodoro-duration accuracy. Use:
```
state.startedAt = performance.now() - state.accumulatedMs;
// on tick:
const elapsed = performance.now() - state.startedAt;
const remaining = phaseDurationMs - elapsed;
```
On pause, capture `accumulatedMs = performance.now() - startedAt` and freeze.

### localStorage safety
```
try { localStorage.setItem(k, v); } catch (e) { console.warn("storage unavailable"); }
```
Parse with try/catch; fall back to defaults. Validate schema keys exist.

### Theme
Use `matchMedia('(prefers-color-scheme: dark)')` for default. Set `document.documentElement.dataset.theme = theme` to swap CSS vars. Apply **before** first paint to avoid flash (inline script in `<head>`).

### Keyboard shortcuts with inputs
```
function isTyping() {
  const t = document.activeElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
window.addEventListener('keydown', (e) => {
  if (isTyping() && e.key !== 'Escape') return;
  // shortcuts here
});
```

## Pitfalls to Avoid
1. **Timer drift**: using `setInterval(1000)` causes drift over 25 min. Use rAF + wall-clock diff.
2. **Lost timer on pause**: store `accumulatedMs` at pause, resume by shifting `startedAt`.
3. **AudioContext autoplay**: build it on first user gesture.
4. **Theme flash (FOUC)**: apply theme attribute before CSS loads / in `<head>` inline script.
5. **Space scrolling page**: `e.preventDefault()` on Space when consuming it.
6. **Enter re-submitting**: inline edit must handle Enter→commit, Escape→cancel; also stop propagation so the global shortcut doesn't fire.
7. **Delete-key on Mac**: only `Delete` (not `Backspace`) per spec; listen for `key === 'Delete'`.
8. **localStorage quota / private mode**: wrap in try/catch.
9. **Long-break math off-by-one**: long break fires when `(cyclesCompleted % 4 === 0 && cyclesCompleted > 0)` after incrementing on work-phase end.
10. **Daily total rollover**: store date alongside total; check on load + on each increment.

## Test Coverage Plan
`node --test` supports `.test.js` files out of the box:
```
node --test tests/
```
No imports of node-specific polyfills needed — pure logic only.
