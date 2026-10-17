---
id: cleo-goal-doctor-install
tasks: [T13819, T13820]
kind: feat
summary: cleo doctor reports the CLEO Goal runtime (installed, version, npm latest, status schema); cleo goal install --harness registers it per project
---

- **`cleo doctor` (T13819).** A new `goal_runtime` check resolves the
  `cleo-goal` bin (then `ocg`) and reports whether it is installed, its version,
  and whether npm has a newer `@cleocode/goal`. When the package is not
  published or npm is unreachable, the check is informational and never a
  failure. A missing bin with a published package, or an available update,
  is a warning with the remedy `npm i -g @cleocode/goal@latest`. When it is
  installed, the check also reads `cleo-goal status --json` and warns when the
  bin replies with a `schemaVersion` this CLEO does not know.
- **Contracts.** `@cleocode/contracts/goal-runtime.js` declares the bin's
  `status --json` and `install --project --json` reply shapes
  (`schemaVersion: 1`). `readGoalStatus` and `resolveGoalBin` in
  `@cleocode/core/goal/runtime.js` are the shared reader and the bin lookup
  (`cleo-goal` first, then `ocg`).
- **`cleo goal install --harness <h>` (T13820).** `opencode` runs
  `cleo-goal install --project --json` in the project and returns its reply.
  The bin's exit 1 error and exit 2 usage error are passed through.
  `claude` and `codex` install the project Stop dispatcher (`cleo hook stop`)
  through the existing hook delivery. `hermes` and `kimi` return
  `E_NOT_IMPLEMENTED` until their pilots (T13822). A missing bin fails with
  `E_GOAL_RUNTIME_MISSING` and the install command. Only project-level config
  is written, never `~/.claude`, `~/.codex` or `~/.config`.

Not changed: `@cleocode/cleo` does not list `@cleocode/goal` as an
optionalDependency yet. That line (`>=0.8.0 <1.0.0`) lands once the package
is published.
