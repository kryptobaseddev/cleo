---
id: t13187-macos-main-completes
tasks: [T13187]
kind: fix
summary: The main-push macOS run is no longer cancelled by the next push, so main gets a macOS verdict; release open names the newest main commit with a green macOS run
---

`macos-main.yml` used `cancel-in-progress: true`, so every main push cancelled
the macOS run still going. In a merge burst no macOS verdict ever landed: the last
four completed runs were all cancelled, eight shards each, about three minutes
before they would have finished. That left the release preflight with nothing to
skip on.

The run now finishes (`cancel-in-progress: false`). GitHub keeps the running run
and at most one pending run per group, and each new push replaces the pending
one, so a burst coalesces to the newest push instead of queuing every push behind
the free plan's five macOS jobs. ci.yml's nightly schedule already runs the macOS
shards on main every night, so this workflow adds no schedule of its own.

When `cleo release open` cannot skip the macOS shards, its reason now names the
newest main commit with a green macOS run and how many commits it is behind
HEAD (from local git history; omitted when unknown). It asks `macos-main.yml` and
ci.yml's nightly `schedule` runs for their newest success separately, so other
workflows' runs cannot push it off the page; a Linux-only ci.yml push run never
counts. Without one, it says no recent green macOS run was found.
