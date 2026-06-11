---
id: t11994-resource-monitor
tasks: [T11994]
kind: feat
summary: "ResourceMonitor library — PSI + MemAvailable sensing, daemon-off capable"
---

Adds `packages/core/src/resources/` — a net-new sensor layer for host memory
state that CLEO had zero visibility into (confirmed grep: 0 hits on PSI/freemem
reads anywhere in packages/runtime/src or packages/core/src/sentient).

**New files:**

- `packages/core/src/resources/backend.ts` — `ResourceBackend` interface +
  raw sample/sweep types. Defines the pluggable platform backend surface for
  macOS parity. `sweepChildRss()` is structurally separated from `sample()` so
  ms-scale smaps_rollup reads can never enter the hot polling path (Amendment 2).

- `packages/core/src/resources/linux-backend.ts` — Linux implementation.
  Reads `/proc/pressure/memory` (global PSI), an optional cgroup v2 slice
  `memory.pressure` file, `/proc/meminfo` (MemAvailable), and N SQLite `-wal`
  sidecar stat calls for WAL growth signal (DHQ-050 starvation class, Amendment 3).
  Injectable `readFileFn` / `statFileFn` allow tests to assert bounded read-count
  without relying on wall-clock timing (Amendment 1 — CI-stable formulation).

- `packages/core/src/resources/monitor.ts` — `ResourceMonitor` with:
  - **Point-in-time mode** (`sample()`) — daemon-off governor acquire path
  - **Continuous mode** (`startContinuous()`) — daemon/supervisor polling at
    configurable `pollIntervalMs`, emitting `ok`/`hold`/`backoff` state
    transitions with hysteresis (hold threshold – 3 pp floor prevents thrash)
  - **Degraded mode** — when PSI interface absent (unprivileged/non-Linux),
    falls back to availability-only sampling using `memAvailableBytes`
  - Default thresholds: hold at some avg10 >10% / full avg10 >5%; backoff at
    some avg10 >20% / full avg10 >10%. All far below systemd-oomd's Fedora
    kill line of **80%/20s on user@1000.service** (not the 50%/20s figure in
    older research — Amendment 4).

- `packages/core/src/resources/__tests__/monitor.test.ts` — 50 tests covering:
  parsing helpers, bounded read-count assertion via injected reader,
  degraded mode, WAL observation, threshold crossing, hysteresis, continuous
  mode transitions, idempotent stop, error resilience.

**Contracts addition (additive-only, Amendment 5):**

- Added `ResourcesConfig` + `ResourcesPsiConfig` interfaces to
  `packages/contracts/src/config.ts` under the `resources.psi.*` and
  `resources.headroomMb` namespaces
- Added optional `resources?: ResourcesConfig` field to `CleoConfig`
- Exported both types from `packages/contracts/src/index.ts`

**Amendments resolved:**

1. CI-stable sampling budget — bounded read-count asserted via injected reader
2. smaps_rollup separation — structurally impossible to reach from `sample()`
3. WAL growth signal — `walPaths` config + `WalSizeObservation` in sample
4. oomd facts — corrected to Fedora default 80%/20s throughout

**Conflict-free with T11993:** no shared barrel/index.ts created for the
resources dir; spawn-wrapper files untouched.
