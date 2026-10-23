# Planning Loop: plan, execute, verify

How CLEO work flows (T13958). RCASD stage records and the IVTR loop are retired
from agent instructions (epic T13932). `pipeline_stage` is a label on tasks; the
one place it still gates work is strict lifecycle mode (below).

## 1. Plan

- One plan document per epic, in the CleoDocs store:
  `cleo docs add <epicId> ./<slug>-plan.md --type plan --slug <slug>-plan`.
  Sections: findings, decision, spec (acceptance criteria), decomposition.
- Decisions go to BRAIN:
  `cleo memory decision-store --decision "..." --rationale "..." --linked-task <epicId>`.
  Owner decisions go through the ask tool first.
- Tasks: `cleo add --type task --parent <epicId> --acceptance "A|B"`, with
  dependencies via `--depends`.
- **Strict lifecycle mode** (the default when `lifecycle.mode` is unset; `advisory`
  only warns, `off` skips the check): a child cannot complete (exit 80) while its parent
  epic sits in a planning stage (research to decomposition). An epic inherits its saga's
  stage, or starts at research when it has no parent. Once the plan is written and
  BEFORE adding children, run `cleo update <epicId> --pipeline-stage implementation`.
  After children sit at the epic's stage, strict mode refuses that move (T13969):
  escalate to the lead or owner rather than driving the retired lifecycle verbs.

## 2. Execute

- `cleo orchestrate waves <epicId>` for wave numbers, `cleo orchestrate ready <epicId>`
  for what may run now, `cleo orchestrate spawn <taskId> --lead-mbx <you>` for each
  worker prompt.
- Agents coordinate over AgentMBX; task state and evidence stay in CLEO.
- Autonomous runs go through CLEO Goal (ADR-097).

## 3. Verify

- `cleo done <id> --plan`, record each gate with `cleo verify <id> --gate <gate>
  --evidence "<atoms>"`, then `cleo complete <id>`.
- Each PR head gets an independent review before merge.

## Spawn protocols are labels

Spawn protocols (research, consensus, specification, decomposition,
implementation, validation, testing, release, contribution) choose the spawn
prompt's stage guidance. They are not gates.

## When `cleo complete` refuses

- Exit 80 with unproven evidence gates (the common case in strict mode): run
  `cleo done <id> --plan`, record what it names, then complete.
- Exit 80 naming a planning-stage parent epic: advance the epic before children
  exist (above); if children already sit at its stage, report it to the lead.
- Exit 83 (`E_IVTR_INCOMPLETE`): the task carries `ivtr_state` from the retired
  IVTR loop, which no command clears; report it to the lead or owner.
