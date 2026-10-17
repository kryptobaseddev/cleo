---
id: cleo-goal-doctor-install
tasks: [T13819, T13820]
kind: feat
summary: cleo doctor reports the CLEO Goal runtime locally (opt-in npm update check); cleo goal install --harness registers it per project
---

- **`cleo doctor` (T13819).** A new `goal_runtime` check finds the `cleo-goal`
  bin (or an `ocg` that belongs to the `@cleocode/goal` package) and reports
  whether it is installed, its version (`--version`, bounded to 2 s), and
  whether its `status --json` speaks a schema this CLEO knows. A bare
  `cleo doctor` makes no network call. `cleo doctor goal-runtime
  --check-updates` also asks npm for the latest `@cleocode/goal`. An
  unpublished or unreachable package is informational. An `ocg` from another
  tool is never run, and doctor reports it as not CLEO Goal.
- **Contracts.** `@cleocode/contracts/goal-runtime.js` declares the bin's
  `status --json` and `install --project --json` reply shapes
  (`schemaVersion: 1`). `@cleocode/core/goal/runtime.js` exports the shared
  `resolveGoalBin` (spawn-free), `goalTickCommand` and `readGoalStatus`.
- **`cleo goal install --harness <h>` (T13820).** `opencode` runs
  `cleo-goal install --project --json` in the project and accepts only a
  `schemaVersion: 1` reply. Any other version, non-JSON output, or the bin's
  exit-1 error fails with `E_GOAL_INSTALL_FAILED` naming the cause. `claude`
  and `codex` install only the project Stop dispatcher (`cleo hook stop`),
  whatever the heavy-command mode, and no `PreToolUse` hook. `hermes` and
  `kimi` return `E_NOT_IMPLEMENTED` until their pilots (T13822). A missing bin
  fails with `E_GOAL_RUNTIME_MISSING` and the install command. Only
  project-level config is written, never `~/.claude`, `~/.codex` or
  `~/.config`.

Not changed: `@cleocode/cleo` does not list `@cleocode/goal` as an
optionalDependency yet. That line (`>=0.8.0 <1.0.0`) lands once the package
is published.
