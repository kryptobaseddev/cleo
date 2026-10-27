---
id: light-lane-small-checks
tasks: [T14079, T13967]
kind: fix
summary: "Small checks get the light lane: plain Python or shell scripts are charged light, and tiny runs start past a full capacity"
---

A tiny `python3` YAML/metadata check under `cleo run --class build` was
charged the whole scoped-build plan and waited behind the full budget,
because only file utilities and `node x.mjs` scripts were known to be light
(Kodo). A plain `python3`/`sh`/`bash`/`zsh` script with no interpreter flags
is now judged like a node script (T14050). It is charged the light 1 GiB
footprint when its path names no heavy job and its content runs no compiler,
test runner or build (`pytest`, `tsc`, `cargo`, `make`, `pnpm test`, …). If it
runs one, or cannot be read, it keeps the class plan and is charged its
measured peak once recorded. The charge line names the reason
(`python3 scripts/check_meta.py runs no heavy tool`).

A two-file `biome check` timed out at position 6 because holders admitted
before memory pressure halved the light share filled the whole 48 GiB
capacity, and the tiny reserve also required room within the capacity
(T13967). Up to three tiny runs (1 GiB or less) now start from the reserve
even past a full capacity. The memory gate still refuses them under real
pressure. The wait text now says when the budget was narrowed after the
running jobs were admitted, so "48 GiB of 24 GiB" reads as intended.
