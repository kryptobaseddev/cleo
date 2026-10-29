---
id: artifact-retention-d11216
tasks: [T14156]
kind: chore
summary: "CI artifacts keep 1 to 3 days instead of 7 to 90, and the packed-artifact upload runs only on failure or on main and tags, to free the shared artifact quota"
---

Owner decision D11216: the shared GitHub artifact quota was full and blocking
other repositories. `packed-artifact-<sha>`, `manual-write-sweep` and
`flaky-report-*` now keep 1 day. `packed-artifact-<sha>` uploads only when a
packed check failed, or on `main` and tags, so passing PR runs no longer
upload it. The cant-napi and cleo-supervisor bundles keep 3 days. Release
artifacts are unchanged. Every reader of these artifacts downloads them in
the same run, so nothing needs them longer.
