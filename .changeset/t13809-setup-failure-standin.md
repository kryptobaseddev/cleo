---
id: t13809-setup-failure-standin
tasks: [T13809]
kind: fix
summary: ci evidence looks past a later main run whose jobs failed in a setup action before any test ran
---

The stand-in search for a green main run after a PR's merge stopped at the first red later run unless it was red only on the flaky-quarantine budget or cancelled. A run whose unit-test shards all failed in `actions/download-artifact` (the build artifact was missing) ran no test, yet it ended the search, so `ci:<pr>` refused T12730 (#1989). A later run now also decides nothing when every failing job's first error sits in a remote action step (`Run owner/action@ref`) and its log has no vitest output. A failure in any `run:` step, an unreadable log, or any test output still refuses.
