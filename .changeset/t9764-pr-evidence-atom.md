---
id: t9764-pr-evidence-atom
tasks: [T9764]
kind: feat
prs: [365]
summary: "New `pr:<num>` evidence atom — retroactively verify shipped tasks against their PR's CI rollup."
---

Closes the release-verb dogfood gap. Previously, after a PR shipped via admin-merge, there was no zero-friction way to record `testsPassed` and `qaPassed` evidence — `tool:test` ran the full repo suite (overkill for one-line tasks) and `note:` was rejected for hard gates.

The new atom is resolved via `gh pr view <num> --json statusCheckRollup`. If the PR is merged and every required check is SUCCESS, the atom satisfies both `testsPassed` and `qaPassed` gates. Cached under `.cleo/cache/evidence/pr-<num>.json` keyed on `(prNumber, mergedAt)` so re-verifies are zero-cost.

Closes the gap that previously forced the orchestrator into manual `sed`-based release ships (per Saga T9758 / Epic T9762 dogfood directive). The atom shape ships in `@cleocode/contracts` to keep types centralized; the resolver lives in `@cleocode/core/release/pr-evidence.ts`.

```bash
cleo verify T#### --gate testsPassed --evidence "pr:357"
cleo verify T#### --gate qaPassed   --evidence "pr:357"
```
