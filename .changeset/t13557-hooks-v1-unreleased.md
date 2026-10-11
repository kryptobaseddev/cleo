---
id: t13557-hooks-v1-unreleased
tasks: [T13557]
kind: fix
summary: "Project hooks stay inert on stable builds until the hooks-v1 promotion"
---

`cleo hook sync --activate` now refuses with `E_HOOKS_V1_UNRELEASED` on a
stable build, and an activation receipt made earlier is reported as
`unreleased` and never runs: agent and Git invocations skip, a required
`cleo hook check --ci` fails, and no handler is spawned. `--disable` still
works.

The gate opens from release metadata, not source, so the pilot's source digest
stays valid: a `-canary.N` build runs hooks, and the stable release planned
with `--hooks-v1-promotion` stamps `cleo.releasedFeatures: ["hooks-v1"]` into
`@cleocode/core`. Stable release candidates now prove the runtime inert
instead of exercising it.
