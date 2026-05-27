---
id: t10341-severity-pipeline-stage-validation
tasks: [T10341]
kind: fix
summary: "cleo add/update: typed validation for --severity + --pipeline-stage at CLI dispatch"
---

Validates `--severity` and `--pipeline-stage` at the CLI dispatch
boundary BEFORE the request reaches the database. Replaces the
late-stage SQLite failure modes (`CHECK constraint failed: severity`,
`CHECK constraint failed: pipeline_stage`) with typed contract errors
naming the valid enum values:

- `--severity X` validates against `TASK_SEVERITIES` (`P0|P1|P2|P3`).
  Failure → `E_INVALID_SEVERITY_VALUE` (exit 6) with message
  `severity must be one of: P0, P1, P2, P3 — got '<X>'`.
- `--pipeline-stage X` (on `cleo update`) validates against
  `TASK_PIPELINE_STAGES` and rejects backward transitions
  (forward-only invariant). Failure → `E_INVALID_PIPELINE_STAGE`
  (exit 6) with the valid forward stages listed in the `fix` hint.

Adds two new error-code constants to `@cleocode/contracts`:
`E_INVALID_SEVERITY_VALUE` and `E_INVALID_PIPELINE_STAGE`. Re-exports
the pipeline-stage helpers (`TASK_PIPELINE_STAGES`,
`isValidPipelineStage`, `isPipelineTransitionForward`,
`validatePipelineStage`, `validatePipelineTransition`,
`isTerminalPipelineStage`, `getPipelineStageOrder`,
`TERMINAL_PIPELINE_STAGES`, `TaskPipelineStage`) from the public
`@cleocode/core` barrel so CLI commands can consume them without
violating the lint-core-first RULE-3 ban on `@cleocode/core/internal`.

R7 of Saga T10326 / Epic T10327 — LLM ergonomics. DB CHECK constraints
remain in place as defense-in-depth.
