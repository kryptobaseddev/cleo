---
id: t13122-effective-heap-cap
tasks: [T13122]
kind: fix
summary: An inherited NODE_OPTIONS heap, worker count or package concurrency no longer multiplies an evidence run's memory; the plan is reported
---

`cleo verify --evidence tool:test|build` and `cleo run` spawn heavy tools with a heap ceiling, a worker
count and a workspace-concurrency bound. Each inherited value always won, and the worker count was sized for
CLEO's 4 GiB default whatever heap was in effect: on 2026-10-03 a profile-wide
`NODE_OPTIONS=--max-old-space-size=8192` made one evidence run 6 workers × 8 GiB, all of a 48 GiB Mac.

**Silent bypass closed: the workspace bound did nothing on pnpm 11+.** pnpm 10 reads only
`npm_config_workspace_concurrency`; pnpm 11 and later read only `pnpm_config_workspace_concurrency`
(measured on 10.30.0 and 12.6.0). CLEO set only the npm spelling, so on current pnpm every `pnpm -r` evidence
run fanned out across packages unbounded while CLEO believed it was serialised. Both spellings are now set,
for every launcher (an `npm test` script that runs `pnpm -r` reads them too), and an uppercase spelling,
which outranks the lowercase one, is bounded as well.

The overlay is now planned against the run's heap budget (default workers × default heap: 24 GiB on
36 GiB and up, 8 GiB on 16 GiB, 4 GiB on 8 GiB):

- an inherited heap that fits is kept and the worker count shrinks so `workers × heap` still fits
  (8 GiB → 3 workers); one above the budget is clamped. The percentage form is read and replaced too;
- an inherited `--max-semi-space-size` above Node's default (64 MiB) is clamped: V8's limit is old space plus
  three semi-spaces;
- inherited worker counts (`VITEST_MAX_WORKERS`, `GOMAXPROCS`, …), workspace concurrency and a bare
  `MAKEFLAGS=-jN` above the plan are clamped (a `MAKEFLAGS` carrying a make jobserver is kept);
- only explicit overrides ask for more: `CLEO_HEAVY_HEAP_MB`, `CLEO_HEAVY_WORKERS`,
  `CLEO_HEAVY_WORKSPACE_CONCURRENCY`;
- a machine under 8 GiB gets a default heap of half its RAM instead of 4 GiB. The default plan on 8 GiB and
  up is unchanged.

Behaviour change for small machines: on 8 GiB and below, an inherited 6–8 GiB heap that a large
single-process build used to finish with (under swap) is now clamped to the budget and can run out of heap;
the kill message names `CLEO_HEAVY_HEAP_MB` to raise it.

The plan, and every value it clamped, is reported: on the `tool` evidence atom (`resources`), in a
resource-kill message (which now names `CLEO_HEAVY_HEAP_MB` instead of `NODE_OPTIONS`), and by `cleo run`
(a `resources` field in the envelope, and a "planned resources" stderr line that is a warning when something
was clamped, so it shows under `--passthrough`). The tool cache keys the limits the run actually gets.
npm's per-run "Unknown env config" warning about the pnpm spellings is dropped from the captured stderr, so
it no longer pushes the real error out of the quoted failure tail. Heap flags are cut out of `NODE_OPTIONS`
without touching anything else in it.

The CLI's own `UV_THREADPOOL_SIZE=64` (T12348) no longer leaks into the processes it spawns: the CLI
keeps its 64 pool threads (now started at launch rather than on first use), and a test runner and each of
its workers start Node's default 4. An operator's own `UV_THREADPOOL_SIZE` is still inherited.
