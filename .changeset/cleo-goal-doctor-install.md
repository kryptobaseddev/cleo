---
id: cleo-goal-doctor-install
tasks: [T13819, T13820]
kind: feat
summary: cleo doctor reports the CLEO Goal runtime (installed, version, npm latest); cleo goal install --harness registers it per project
---

- **`cleo doctor` (T13819).** A new `goal_runtime` check resolves the
  `cleo-goal` bin (then `ocg`) and reports whether it is installed, its version,
  and whether npm has a newer `@cleocode/goal`. When the package is not
  published or npm is unreachable, the check is informational and never a
  failure. A missing bin with a published package, or an available update,
  is a warning with the remedy `npm i -g @cleocode/goal@latest`.
- **`cleo goal install --harness <h>` (T13820).** `opencode` runs
  `cleo-goal install --project` in the project and passes its output through.
  `claude` and `codex` install the project Stop dispatcher (`cleo hook stop`)
  through the existing hook delivery. `hermes` and `kimi` return
  `E_NOT_IMPLEMENTED` until their pilots (T13822). A missing bin fails with
  `E_GOAL_RUNTIME_MISSING` and the install command. Only project-level config
  is written, never `~/.claude`, `~/.codex` or `~/.config`.

Not changed: `@cleocode/cleo` does not list `@cleocode/goal` as an
optionalDependency yet. That line lands once the package is published.
