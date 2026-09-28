---
id: t12517-vitest-alias-space-paths
tasks: [T12517]
kind: test
summary: vitest configs resolve alias paths with fileURLToPath so tests run from a checkout path containing a space
---

`new URL(..., import.meta.url).pathname` keeps `%20`, so inside a macOS CLEO
worktree (`~/Library/Application Support/...`) every alias pointed at a
non-existent path. Measured: contracts suite 3 failures before, 596/596 after,
run from such a path.
