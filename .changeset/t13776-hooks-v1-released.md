---
id: t13776-hooks-v1-released
tasks: [T13776]
kind: feat
summary: project hooks (hooks-v1) are released in source, so every build runs them without a release stamp
---

hooks-v1 was promoted to stable in v2026.10.17 through a release stamp on
`@cleocode/core`. It now leaves `UNRELEASED_HOOK_FEATURES`, so stable builds
activate and run project hooks with no stamp, and later releases no longer
need `--hooks-v1-promotion`. The installed-artifact soak asks the installed
build's own release gate whether hooks are released, instead of re-deriving
it from the manifest stamp.
