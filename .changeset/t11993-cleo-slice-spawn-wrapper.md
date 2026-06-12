---
id: t11993-cleo-slice-spawn-wrapper
tasks: [T11993]
kind: feat
summary: "cleo.slice unit + spawn-wrapper SSoT — staged P1 budget, LimitCORE=0, selective oomd-avoid"
---

Installs a user-level `cleo.slice` cgroup slice and routes every cleo child
spawn through a single `packages/core/src/resources/spawn-wrapper.ts` SSoT,
eliminating the 94 coredumps/14d (44 node/biome) that were firing abrt-applet
desktop toasts from V8 heap-abort + cgroup hard-cap kill coredumps.

## What changed

### New: `packages/core/src/resources/spawn-wrapper.ts`

Single SSoT for `systemd-run` argv construction.  Key properties:

- Places children under `cleo.slice` via `--slice=cleo.slice`
- Emits `LimitCORE=0` on every scope (zero coredumps / zero toasts)
- Emits `MemorySwapMax=0` (no swap blowup)
- Selective `ManagedOOMPreference=avoid`: only `daemon` and `db` scope classes
  (write-txn holders).  `agent`, `test`, `tool` classes do NOT get `avoid`
  (Fedora oomd monitors user@1000.service at 80%/20s — blanket avoid redirects
  kills onto innocent user apps)
- Graceful pgid fallback with log-once demotion when systemd-run is absent
- Returns `{ child, pid, mode, unitName }` — ownership handle for T11998/T11995

### Staged P1 budget (Amendment 1)

**P1 installed values (safe):**
- `MemoryHigh` = disabled (no throttle)
- `MemoryMax`  = 32G (hard cap, benign kill, no coredump)

A reclaim-stalled scope holding the SQLite WAL write-txn >30s (busy_timeout)
cascades SQLITE_BUSY across every slice member.  MemoryHigh within 5% of
MemoryMax causes exactly this stall.  P2 target (60/85 shape) is gated on the
T11994 stall-escalator.

### New: `cleo.slice` unit in `install-daemon-service.mjs`

`installSliceUnit()` writes `~/.config/systemd/user/cleo.slice` idempotently
(SHA-256 delta check + daemon-reload).  Called from `installSystemd()` before
the daemon service unit write.

Forbidden: `Delegate=` directive (per systemd spec, only valid on services/scopes).
Does NOT touch or restart `cleo-daemon.service` — the operator's enabled/disabled
state (T11984 decision table) is sacred.

### Updated consumers

All route through `buildSpawnArgs` / `spawnWrapped`:

- `packages/cleo/src/cli/lib/gateway-auto-start.ts` — gateway detached spawn
  (scopeClass: `daemon`)
- `packages/core/src/sentient/daemon.ts` (StudioSupervisor) — Studio child
  spawn (scopeClass: `daemon`)
- `packages/core/src/check/pr-gate.ts` (`buildGateArgv`) — heavy gate wrapping
  (scopeClass: `test`)
- `packages/core/src/verification/verify-tools.ts` (`runStep`) — evidence tool
  execution (scopeClass: `tool`)

### Retired constant

`MEMORY_MAX_LAUNCH_WRAPPER` in `budget.ts` is deprecated with a `@deprecated`
TSDoc tag pointing to `buildSpawnArgs`.  The string value is preserved for
backward compatibility until doc references are updated.

## Test coverage

`packages/core/src/resources/__tests__/spawn-wrapper.test.ts` — 16 hermetic
unit tests that run in CI without a systemd user bus:
- Exact `systemd-run` argv assertions (slice, unit name, properties)
- Selective `ManagedOOMPreference=avoid` per scope class
- `MemoryHigh` absent in P1 / present when explicitly set
- `LimitCORE=0` present by default / absent when `noCoreFile: false`
- pgid fallback path (forced unavailable)
- Resource override + fractional MemoryMax resolution
