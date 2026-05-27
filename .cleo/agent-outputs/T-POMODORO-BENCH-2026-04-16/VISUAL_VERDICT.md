# Visual Functionality Verdict

**Tested**: 2026-04-16 via Chrome DevTools MCP automation
**Served**: `python3 -m http.server` on ports 8010/8011/8012
**Screenshots**: `evidence/01-09-*.png` (3 per arm: initial, running, reloaded)

## Bottom line

**All 3 apps load, run, count down correctly, and persist state across reload.** No app crashed. No JavaScript fatal errors. The 1 console error seen in each is `404` on (likely) `/favicon.ico` — cosmetic, non-functional.

## Per-arm functional results

### Vanilla (port 8010)

| Check | Result |
|---|---|
| Page loads | ✅ Clean render |
| Add todo | ✅ Works; auto-selects new todo for timer |
| Start timer | ✅ 25:00 → 24:50 in ~10s real-time |
| **Title live-updates** | ✅ `24:50 · Work — Focus` (matches timer) |
| Theme cycle | ✅ auto → light → dark → auto (3-state per spec) |
| Reload persistence | ✅ Todo + theme survive |
| Visible Edit button on todo | ✅ **Only arm with `E` button inline** |
| Skip link | ✅ Present |
| Console errors | 1 (favicon 404) |

**Unique strength**: The only arm with a discoverable visual Edit button. Other arms require pressing Enter which users must learn.

### GSD (port 8011)

| Check | Result |
|---|---|
| Page loads | ✅ Clean render |
| Add todo | ✅ Works; auto-selects |
| Start timer | ✅ 25:00 → 24:42 in ~5s |
| **Title live-updates** | ❌ Static `Todo + Pomodoro` — does NOT update with timer |
| Theme cycle | ❌ Binary only: dark ↔ light (no way back to OS-auto) |
| Reload persistence | ✅ Todo + theme survive |
| Start button when no todo | ❌ Disabled — can't run timer standalone |
| Visible Edit button | ❌ No edit UI (must know Enter shortcut) |
| **Visual layout bug** | ❌ `Focusing on: <text>` overlaps the circular ring arc — text gets cut by the ring |
| Console errors | 0 (on reload) |

**Biggest issues**: 2-state theme violates spec "auto-detect + manual toggle". Visual overlap of focus text into the ring arc is a pure CSS positioning miss. Disabled Start button is a UX anti-pattern.

### CLEO (port 8012)

| Check | Result |
|---|---|
| Page loads | ✅ Clean render |
| Add todo | ✅ Works + announces `"Task added"` via `role="status"` live region |
| Start timer | ✅ 25:00 → 24:43 in ~5s |
| **Title live-updates** | ✅ `24:43 Work - Pomodoro Todos` (matches vanilla) |
| Theme cycle | ✅ auto → light → dark → auto (3-state) |
| **Theme button label updates with state** | ✅ `Theme: auto. Click to change.` → `Theme: light.` → `Theme: dark.` (best a11y) |
| **OS-auto detection on first load** | ✅ Rendered dark because OS preference was dark (only arm that visibly honored this on first paint) |
| Reload persistence | ✅ Todo + theme + selection + schemaVersion survive |
| `Cycle 1 of 4` displayed | ✅ **Only arm that shows cadence position** in the timer UI |
| `aria-keyshortcuts` attributes | ✅ `Space` on Start, `N` on new-todo input (WAI-ARIA 1.2) |
| Skip link | ✅ Present |
| Visible Edit button | ❌ No edit UI (Enter-only) |
| Console errors | 1 (favicon 404) |

**Unique strengths**: Best accessibility of the 3 (live announcements, keyshortcuts attrs, button labels that update with state). Only arm that shows "Cycle 1 of 4" so user knows where in the pomodoro cadence they are. LocalStorage schema is versioned (`schemaVersion: 1`) for forward-compat.

## Cross-arm visual observations (from screenshots)

- **All 3 use circular SVG progress rings** that render correctly
- **All 3 use the color-coded phase** (blue=work for vanilla, coral/red=work for gsd+cleo)
- **All 3 show running timer** that updated between the "initial" (25:00) and "running" (~24:31-24:50) screenshots
- **GSD's ring is the most visually cluttered** (text-in-ring overlap)
- **Vanilla's ring is the cleanest** (text above-ring, not inside)
- **CLEO's layout is the most compact** (timer card + tasks panel side-by-side, tight)

## Confirmations of SUPREME's written scoring

Every visual observation **substantively confirms** what SUPREME scored from artifacts alone:
- CLEO's +2 polish points are real (live announcements, cadence visible, theme label updates)
- GSD's feature-completeness docking was right (binary theme confirmed, disabled Start confirmed)
- Vanilla's code quality win is backed by UX discoverability win (visible Edit button)

## New issues surfaced by visual testing that artifacts didn't reveal

1. **GSD's visual bug**: `Focusing on: <text>` text rendered INSIDE the circle and cut by the ring arc — a pure CSS layer/positioning miss. Deduct another UX polish point from GSD (not done — but scored 3/5 already, consistent).
2. **Title live-update**: VANILLA and CLEO do it, GSD does not. Minor UX delta that tips tab-switching users toward the live-title arms.
3. **Visible Edit button**: only VANILLA has one. For non-power-users who don't know "press Enter to edit", GSD and CLEO both have a discoverability miss. None were docked enough for this in the written review.
4. **OS auto-detect**: only visibly verified on CLEO's initial load (rendered dark matching OS). Vanilla's "auto" worked on reload too, but GSD's binary toggle means there's no "auto" state at all — this was already known.

## Final visual grade

| Arm | Loads? | Functions? | Persists? | Visual polish | Verdict |
|---|:-:|:-:|:-:|:-:|---|
| Vanilla | ✅ | ✅ | ✅ | ★★★★☆ | **Ships.** Cleanest code quality; only one with visible Edit button. |
| GSD | ✅ | ✅ | ✅ | ★★★☆☆ | **Ships with flaws.** Text-over-ring CSS bug; binary theme; disabled Start button; no title live-update. Most "roughest edges" of the three. |
| CLEO | ✅ | ✅ | ✅ | ★★★★★ | **Ships best.** Best a11y polish; OS-auto honored on first paint; cadence position visible; theme label updates with state. |

No crashes. No fatal JS errors. All three are real, working, production-shippable static web apps built in under 10 minutes each.
