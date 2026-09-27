---
id: t12488-is-main-space-paths
tasks: [T12488]
kind: fix
summary: gate scripts now run their checks when the checkout path contains a space instead of silently exiting 0
---

`import.meta.url` percent-encodes spaces, so the `file://${argv[1]}` and
`URL.pathname` entry-point checks were false under `~/Library/Application
Support/`, where every macOS CLEO worktree lives. Gates 14, 15 and 23 plus six
other scripts skipped `main()` and reported green. One shared
`scripts/lib/is-main.mjs` now compares realpath'd filesystem paths.
