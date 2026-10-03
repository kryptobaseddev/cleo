---
id: t13122-effective-heap-cap
tasks: [T13122]
kind: fix
summary: An inherited NODE_OPTIONS heap no longer multiplies an evidence run's memory budget; the plan is reported
---

`cleo verify --evidence tool:test|build` and `cleo run` spawn heavy tools with a heap ceiling and a worker
count. An inherited `--max-old-space-size` (a shell profile's `NODE_OPTIONS`) always won, and the worker
count was sized for CLEO's 4 GiB default whatever heap was in effect: on 2026-10-03 a profile-wide 8 GiB
heap made one evidence run 6 workers × 8 GiB, all of a 48 GiB Mac.

The overlay is now planned against the run's heap budget (default workers × default heap: 24 GiB on
36 GiB and up, 8 GiB on 16 GiB, 4 GiB on 8 GiB). An inherited heap that fits is kept and the worker count
shrinks so `workers × heap` still fits (8 GiB → 3 workers); one above the budget is clamped to it. The
percentage form (`--max-old-space-size-percentage`) is read and replaced too, since it outranks the size
form. Inherited worker counts (`VITEST_MAX_WORKERS`, `GOMAXPROCS`, …) and `npm_config_workspace_concurrency`
above the plan are clamped as well. Only explicit overrides ask for more: `CLEO_HEAVY_HEAP_MB`,
`CLEO_HEAVY_WORKERS`, `CLEO_HEAVY_WORKSPACE_CONCURRENCY`. A machine under 8 GiB gets a default heap of
half its RAM instead of 4 GiB. The default plan on 8 GiB and up is unchanged.

The plan, and every value it clamped, is reported: on the `tool` evidence atom (`resources`), in a
resource-kill message (which now names `CLEO_HEAVY_HEAP_MB` instead of `NODE_OPTIONS`), and by `cleo run`
(a `resources` field in the envelope, and a stderr line that is a warning when something was clamped, so it
shows under `--passthrough`). The tool cache keys the limits the run actually gets, so a clamped value keys
like the budget it was clamped to.

The CLI's own `UV_THREADPOOL_SIZE=64` (T12348) no longer leaks into the processes it spawns: the CLI
keeps its 64 pool threads, and a test runner and each of its workers start Node's default 4. An
operator's own `UV_THREADPOOL_SIZE` is still inherited.
