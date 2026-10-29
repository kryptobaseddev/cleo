# Planning Loop: plan, execute, verify

How CLEO work flows (T13958). RCASD stage records and the IVTR loop are retired
from agent instructions (epic T13932). `pipeline_stage` is a label on tasks; it
gates work only where a project turns on the stage gate (below).

## 1. Plan

- One plan document per epic, in the CleoDocs store:
  `cleo docs add <epicId> ./<slug>-plan.md --type plan --slug <slug>-plan`.
  Sections: findings, decision, spec (acceptance criteria), decomposition.
- Decisions go to BRAIN:
  `cleo memory decision-store --decision "..." --rationale "..." --linked-task <epicId>`.
  Owner decisions go through the ask tool first.
- Tasks: `cleo add --type task --parent <epicId> --acceptance "A|B"`, with
  dependencies via `--depends`.
- **Stage gate** (`lifecycle.stageGate`, off by default, T13970): when a project sets it
  to `strict`, a child cannot complete (exit 80) while its parent epic sits in a planning
  stage (research to decomposition), and the epic cannot advance once children sit at its
  stage; `advisory` only warns. An epic inherits its saga's stage, or starts at research
  when it has no parent. With the gate on, run `cleo update <epicId> --pipeline-stage
  implementation` once the plan is written and BEFORE adding children; if children
  already sit at its stage, report the epic to the lead or owner. The setting is their
  choice: never change `lifecycle.stageGate` yourself. Evidence strictness stays on
  `lifecycle.mode` either way.

## 2. Execute

- `cleo orchestrate waves <epicId>` for wave numbers, `cleo orchestrate ready <epicId>`
  for what may run now, `cleo orchestrate spawn <taskId> --lead-mbx <you>` for each
  worker prompt.
- Agents coordinate over AgentMBX; task state and evidence stay in CLEO.
- Autonomous runs go through CLEO Goal (ADR-097).

## 3. Verify

- PR work: the PR body names each task and its ACs (`Closes: T#### AC1,AC2`, or
  `Refs:` for partial delivery). A non-author reviewer records a verdict per AC
  on the PR head (`cleo review verdict`). Merge on green `CI`; the merge sweep
  closes the task. Check the lines first with
  `cleo done --from-merge <pr> --dry-run`.
- No-PR work: `cleo done <id> --plan`, record each gate with
  `cleo verify <id> --gate <gate> --evidence "<atoms>"`, then `cleo complete <id>`.

## Spawn protocols are labels

Spawn protocols (research, consensus, specification, decomposition,
implementation, validation, testing, release, contribution) choose the spawn
prompt's stage guidance. They are not gates.

## When `cleo complete` refuses

- Exit 80 with unproven evidence gates (the common case in strict mode): run
  `cleo done <id> --plan`, record what it names, then complete.
- Exit 80 naming a planning-stage parent epic: the project turned on
  `lifecycle.stageGate`; advance the epic before children exist (above), otherwise
  report it to the lead or owner, who decide on the setting.
- Exit 83 (`E_IVTR_INCOMPLETE`): the task carries `ivtr_state` from the retired
  IVTR loop, which no command clears; report it to the lead or owner.
