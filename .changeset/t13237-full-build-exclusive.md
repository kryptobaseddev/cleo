---
id: t13237-full-build-exclusive
tasks: [T13237]
kind: fix
summary: only one full build runs at a time machine-wide again, whatever its size; a second one is deferred (exit 75) and told which build holds the slot
---

Since heavy runs began to be charged half the machine budget (T13132), two whole-workspace
builds (`cleo run --class full-build`, which covers turbo or nx across every package) fit
the budget by size and ran at once. That is the saturation pattern behind the P0 crash. A
full build now takes an exclusive machine-wide slot in the admission ledger:

- Only one full build is admitted at a time, however small its footprint. A second one is
  deferred (exit 75); the reason names the build that holds the slot.
- Tests, typechecks and other builds still share the budget alongside it.
- Once a waiting full build has held its reservation, light runs may still start around
  it, but heavy runs may not.

A CLEO older than this release does not know the slot. While one of those runs on the
same machine, it can still start a second full build.
