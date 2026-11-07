---
id: runnable-remedies
tasks: [T14300]
kind: fix
summary: "refusal remedies run as written: review no-author, the strict stage gate, cancel children and worktree errors"
---

Five refusals named a way out that could not work:

- A review verdict on a task with no recorded author told the author to run
  `cleo start`, which refuses a task blocked on a dependency. It now names
  `cleo claim <id>`, run by the session that delivers the task (never the
  reviewer), which records the author even while the task is blocked.
- The strict stage gate (`E_LIFECYCLE_GATE_FAILED`) named
  `cleo update <epic> --pipeline-stage implementation` even when the epic's own
  children refuse that advance. It now names the advance only when no
  unfinished child sits at the epic's stage, and otherwise names those
  children and escalates (`cleo show <epic>` to the lead or owner).
- `E_HAS_CHILDREN` and `E_CASCADE_THRESHOLD_EXCEEDED` on cancel used
  dispatch-parameter syntax (`children='cascade'`, `force=true`). They now name
  `cleo cancel <id> --children cascade`, `--children reparent --to <epicId>`
  and `--force`, and the error carries `fix` and `alternatives`. The
  delete-preview hint that offered flags `cleo delete` lacks now names the
  same `cleo cancel` commands.
- `E_WT_LOCATION_FORBIDDEN` names the computed worktree root on this machine
  in its message and `fix`, and `E_WT_IDENTITY_MISMATCH` names
  `cleo doctor project-identity --resolve`.
