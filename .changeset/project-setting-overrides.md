---
id: project-setting-overrides
tasks: [T14038]
kind: fix
summary: "cleo run names each project setting its heavy-run overlay overrides (vitest maxWorkers, pnpm workspace-concurrency) on stderr and in the run envelope"
---

When CLEO's heavy-run overlay changed a value the project set in its own files,
the run said nothing, so a failure it caused looked like a real test failure.
`cleo run` now prints one warning per overridden setting, for example
`overrides the project's vitest maxWorkers 8 (apps/api/vitest.config.ts) with VITEST_MAX_WORKERS=3`.
The run envelope's `resources.projectOverrides` lists the same overrides.

Detected: a literal vitest `maxWorkers` (or `fileParallelism: false`) in any
vitest config up to two levels below the run's directory, and pnpm
`workspace-concurrency` in `.npmrc` or `workspaceConcurrency` in
`pnpm-workspace.yaml`. A heap the project sets (a vitest `execArgv`, an inline
`NODE_OPTIONS` in a script, `.npmrc` `node-options`) is applied after the
inherited `NODE_OPTIONS`, so the overlay never overrides it and it is not
listed.
