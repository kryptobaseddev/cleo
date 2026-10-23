# Planning Loop: plan, execute, verify

How CLEO work flows (T13958). RCASD stage records, lifecycle gates and the IVTR
loop are retired from agent instructions (epic T13932). `pipeline_stage` stays a
label on tasks; never drive it to unblock work.

## 1. Plan

- One plan document per epic, in the CleoDocs store:
  `cleo docs add <epicId> ./<slug>-plan.md --type plan --slug <slug>-plan`.
  Sections: findings, decision, spec (acceptance criteria), decomposition.
- Decisions go to BRAIN:
  `cleo memory decision-store --decision "..." --rationale "..." --linked-task <epicId>`.
  Owner decisions go through the ask tool first.
- Tasks: `cleo add --type task --parent <epicId> --acceptance "A|B"`, with
  dependencies via `--depends`.

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

## Legacy records

Older epics may carry lifecycle rows, an early `pipeline_stage`, or tasks with
`ivtr_state`. `cleo complete` can then exit 80 (early-stage parent epic) or 83
(`E_IVTR_INCOMPLETE`); neither has a self-service fix, so report the task to
the lead or owner.
