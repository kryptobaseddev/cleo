---
id: t13126-gate39-local-skip
tasks: [T13126]
kind: fix
summary: cleo check arch no longer demands a full build; gate 39 skips locally without a current build and CI enforces it
---

Gate 39 (`scripts/check-cli-startup-graph.mjs`) measures the built CLI. Locally it failed
`cleo check arch` whenever the build was missing, older than the source, or overwritten by
`tsc -b`'s per-file output. That forced a full `pnpm run build` before every pre-push check.

- Without a current build, gate 39 now exits 78. `cleo check arch` records that as
  **skipped**, not failed. A `tsc -b` overwrite counts as no current build, because the gate
  looks for the bundle's banner marker.
- In CI (`CI` set) or with `--require-build`, an unusable build still fails (exit 2).
- `cleo check arch` treats exit 78 from any gate as "precondition absent locally, nothing
  checked".

Notes from the review of the startup PR (#1812):

- **Decide budgets.** The duplicate-detection and contradiction decide budgets now start
  after their modules load. A cold `cleo add` therefore takes module load time plus the
  full budget, instead of the load eating into the budget.
- **Long-running processes.** The CLI ships as hashed chunks. A long-running process
  started from `dist/cli`, such as a `cleo run --wait` queued for hours or a foreground
  server, can fail to load a chunk after an in-place `npm i -g` replaces them. Restart it
  after upgrading. The GC daemon runs CORE's dist and is unaffected.
