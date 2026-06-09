---
id: t11932-pi-tui-cockpit-foundation
tasks: [T11932, T11933, T11934]
kind: feat
summary: cleo tui — Pi-powered terminal cockpit foundation (optional-dep pi-tui loader + keyboard-first shell over the gateway SDK + Kanban home view, with graceful degrade)
---

Introduces the mission's second human surface: a keyboard-first terminal cockpit (`cleo tui`) that boots over the M5 generated gateway SDK and renders the agent-lifecycle Kanban home view.

- **T11932 — `@earendil-works/pi-tui` optional-dep loader.** `loadPiTui()` / `isPiTuiAvailable()` lazily import the renderer via a specifier held in a variable, shape-check the consumed surface against locally-declared interfaces (no `import type` from the optional package), and return `null` + an install hint when absent. Mirrors `gondolin-loader.ts` exactly — import-time side-effect-free, cached availability probe, NOT declared in `dependencies`. `@cleocode/cleo` builds and non-TUI tests pass with pi-tui uninstalled.
- **T11933 — `cleo tui` command shell.** Registered via the canonical `defineCommand` factory (no raw `citty` import — Gate-1 count drops 139→138). All data access goes through `createCleoClient({ baseUrl: 'http://127.0.0.1:7777' })` (the `cleo daemon serve` `/v1` listener) — NO direct `@cleocode/core` domain import. Graceful degrade: pi-tui absent → plain-text board + install hint, exit 0; daemon unreachable → "start `cleo daemon serve`" message, exit 0; neither path crashes. The unreachable daemon is detected via the SDK result carrying no `response` object (hey-api does not throw on connection refused).
- **T11934 — Kanban home view.** Buckets the live task graph into the seven dispatcher lanes (Backlog → Ready → Running → Review → Blocked → Done → Cancelled) and renders the board with counts + cards + a keyboard-navigation skeleton.

**Shared lane model (relate T11934 ↔ T11926).** The agent-lifecycle lane resolver — the precedence ladder `cancelled > done > blocked > review > running > ready > backlog` — is lifted from Studio (`packages/studio/.../agent-lifecycle-lane.ts`) into `@cleocode/core/tasks` as the single source of truth. The Studio module becomes a thin re-export of the core SSoT, so the Studio board and the TUI board resolve lanes with identical semantics (the Studio parity test asserts same-function identity). The resolver is runtime logic, so it lives in core (the SDK), not contracts — keeping the contracts-purity gate green.

A `@cleocode/core/gateway-client` vitest source-tree alias is added (the `exports` map points at `dist/`) so the cockpit's SDK import resolves under vitest, matching the existing `@cleocode/core/tasks` alias pattern.

Read-only home view; interactive dispatch/stream is a later task (a `// TODO(T11935): dispatch via orchestrate.spawn` seam is left in the board component).
