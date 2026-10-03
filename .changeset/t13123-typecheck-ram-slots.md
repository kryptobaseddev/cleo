---
id: t13123-typecheck-ram-slots
tasks: [T13123]
kind: fix
summary: typecheck and lint admission is RAM-derived, pressure-sensitive, governed, and gets a heap ceiling
---

`tool:typecheck` and `tool:lint` evidence runs got `max(2, cpus/2)` machine-wide slots (9 on an 18-core
box), never shrank under memory pressure, took no ResourceGovernor slot and ran with no heap ceiling, on the
assumption that they were cheap. One TypeScript program on a large monorepo holds 2–5 GB (a live
`tsc --noEmit` held 4.7 GB on 2026-10-03): nine of them is most of a 48 GB machine.

- Slots are RAM-derived: as many runs as fit in half of RAM at the run's heap plus 2 GiB each, at most half
  the cores, at most 2 on macOS, never fewer than one (18 cores / 48 GiB: 4 on Linux, 2 on macOS; 4 cores /
  8 GiB: 1). A run planned with a larger inherited heap counts against more of the budget.
- They shrink under memory pressure like test and build.
- They take a slot of a new `typecheck` ResourceGovernor class (one process per run, ~6 GiB estimate, half
  the cores), which `cleo run` now also infers for `tsc`, `vue-tsc`, `svelte-check`, `eslint`, `biome` and
  non-recursive `typecheck`/`lint`/`check` scripts (`--class typecheck` or `--class lint`), so evidence runs
  and agent-run type checks share one machine-wide budget. A recursive script (`pnpm -r typecheck`) stays
  a build.
- Evidence typecheck and lint runs get the same heap ceiling and workspace concurrency as test and build
  (T13122's plan, as one process, no worker variables). The cache key for these tools now includes those
  limits, so their cached results re-run once after upgrading.
