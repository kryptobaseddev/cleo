---
id: cleo-ask-park-and-continue
tasks: [T14302]
kind: feat
summary: "cleo ask parks a task on an owner question so the agent continues with other work; cleo ask answer records the owner's choice and resumes it"
---

A harness with no ask tool used to end at the first owner decision: rule 7
said emit a `hitl.request` envelope and stop. Now the question is parked and
work goes on (D11233).

- `cleo ask <taskId> --request '{question, options[{label, description}], recommended}'`
  stores the question as a proposed decision record linked to the task and
  blocks the task with the `owner-decision` label. `cleo next` skips it.
- `cleo ask answer <decisionId> --option <label>` stores the owner's choice as
  an accepted decision record that supersedes the question, then returns the
  task to pending. An owner-marked session answers directly. An agent relaying
  the owner's choice adds `--via ask-tool`, or `--via mbx-owner --source <id>`
  for a signed mbx message; the relaying session and agent are recorded. The
  session that asked may not relay when its harness has no ask tool (D11232).
  A task whose label was removed by hand is refused, not silently resumed.
- `cleo briefing` lists open questions and the answers recorded since the last
  session ended.
- The readiness grill flags an owner decision from the label only. The
  `blockedBy` substring rule ("owner" or "decision" anywhere in the text) is
  deleted.
- Rule 7 on the injection, `ct-cleo`, `ct-orchestrator`, the spawn prompt and
  the ask-enforce hook now says park with `cleo ask` and continue. Gate 27
  requires that text and fails if the `hitl.request`-and-stop fallback returns.
