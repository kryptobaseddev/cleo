---
id: goal-install-dry-run
tasks: [T13869, T13870]
kind: feat
summary: cleo goal install --harness opencode --dry-run previews the change through cleo-goal; criterion by/detail may be null
---

- **`cleo goal install --dry-run` (T13869).** With `--harness opencode` the flag
  passes through as `cleo-goal install --project --json --dry-run`. The bin
  reports the planned action (`action: "dry-run"`) and writes nothing. For the
  claude and codex harnesses, `--dry-run` is refused with `E_VALIDATION`
  rather than writing the Stop dispatcher.
- **Nullable criterion fields (T13870).** `GoalRuntimeCriterion.by` and
  `.detail` are `string | null`. That matches `cleo-goal status --json`
  0.9.0, which emits `null` for an unjudged criterion.
