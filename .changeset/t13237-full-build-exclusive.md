---
id: t13237-full-build-exclusive
tasks: [T13237]
kind: fix
summary: only one full build runs at a time machine-wide again, whatever its size; a second one is deferred (exit 75) and told which build holds the slot
---

Since heavy runs began to be charged half the machine budget (T13132), two whole-workspace
builds fit the budget by size and ran at once. That covers `cleo run --class full-build`
(turbo or nx across every package) and an evidence `tool:build` (the project's
`pnpm run build`). That is the saturation pattern behind the P0 crash. A
full build now takes an exclusive machine-wide slot in the admission ledger:

- Only one full build is admitted at a time, however small its footprint. This counts
  both `cleo run --class full-build` and evidence `tool:build` runs. A second one is
  deferred (exit 75); the reason names the build that holds the slot.
- Tests, typechecks and other builds still share the budget alongside it.
- Once a waiting full build has held its reservation, light runs may still start around
  it, but heavy runs may not.

The admission ledger (#1829) first ships in this release, so no released CLEO writes it
without knowing about this slot. Older releases admit heavy work through the previous
governor, which is a separate mechanism.
