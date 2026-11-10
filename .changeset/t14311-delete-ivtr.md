---
id: t14311-delete-ivtr
tasks: [T14311]
kind: breaking
summary: "the retired IVTR loop is deleted: no E_IVTR_INCOMPLETE gate, no cleo orchestrate ivtr, no ivtr_state column, no ct-ivt-looper skill"
breaking: "Removed: cleo orchestrate ivtr (now prints E_COMMAND_REMOVED), cleo show --ivtr-history, the orchestrate.ivtr.*, release.gate and release.ivtr-suggest operations and their SDK client functions, the E_IVTR_INCOMPLETE error code, the tasks_tasks.ivtr_state column and the ct-ivt-looper skill. Prove completion with evidence gates (cleo done <id> --plan, cleo verify, cleo complete); archived IVTR state is in tasks_audit_log rows with action task_ivtr_state_retired."
---

The IVTR loop was replaced by CLEO Goal (ADR-097) and nothing has written its
state since T11896; this release removes what was left (owner decision D11174).

- `cleo complete` no longer refuses with `E_IVTR_INCOMPLETE`; exit code 83
  stays reserved and the code is never reused.
- `cleo orchestrate ivtr` prints a removal notice (`E_COMMAND_REMOVED`). The
  `orchestrate.ivtr.*`, `release.gate` and `release.ivtr-suggest` operations
  and their generated SDK functions are gone, and so is `cleo show
  --ivtr-history`.
- Migration `t14311-retire-ivtr-state` writes one `tasks_audit_log` row
  (`task_ivtr_state_retired`) per task that still carried IVTR state, keeping
  the raw JSON in `before_json.ivtrState`, then drops `tasks_tasks.ivtr_state`.
- The `ct-ivt-looper` skill is removed and listed in `retiredSkills`; the
  `testing` stage routes to `ct-validator`. The readiness grill drops its
  `IVTR_MAX_RETRIES` trigger.
- `validateSpawnRequest` moved to `lifecycle/lead-authorship.ts`.
