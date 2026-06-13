---
id: t11980-batteries-included-surface
tasks: [T11980]
kind: feat
summary: Batteries-included surface — bare `cleo` launches TUI, `cleo web` opens Studio, gateway auto-starts on demand
---

Implements the batteries-included command surface (checklist §11.3 / T11980):

- **bare `cleo` (no args) on a TTY** — launches the Pi-powered TUI cockpit directly instead of printing help. Non-TTY (pipes, CI, scripts) and any-args invocations fall through to the existing behavior exactly; the automation contract is unchanged.
- **gateway auto-start on demand** — when `cleo tui` or `cleo web` finds the gateway unreachable on port 7777, spawns `cleo daemon serve` as a detached background child (`stdio → log file`, `unref()`d), polls the port with exponential backoff (100 ms → 1 s, 10 s budget), then proceeds. Respects `daemon.autoStart: false` in the project config. **NEVER activates the systemd service unit.**
- **`cleo web`** (root, no subcommand) — ensures the gateway is up via the same auto-start mechanism, opens the Studio URL in the default browser (`xdg-open` / `open` / `start`), prints the URL and a one-liner note about T11979 Studio assets (parallel lane). The existing `cleo web start|stop|status|restart|open` subcommands are unchanged.
- **`@earendil-works/pi-tui` promoted to a real `dependency`** — was intentionally un-declared (optional, dynamic-import). Promoted to `"@earendil-works/pi-tui": "^0.79.1"` in `packages/cleo/package.json` so the npm-published `@cleocode/cleo` package always ships with the TUI renderer. License: MIT (same as this repo). Size impact: ~120 KB unpacked.

New module: `packages/cleo/src/cli/lib/gateway-auto-start.ts` — pure spawn-on-demand helper; no `systemctl`, no service-manager calls.
