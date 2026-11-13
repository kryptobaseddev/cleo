---
id: orca-unlaunched-start-retired
tasks: [T14486]
kind: fix
summary: "an Orca start that failed before worker-start is retired instead of fencing every later spawn; corrupt worker metadata and a bad lead registry now refuse with a fix"
---

Three follow-ups from the T14455 review of the Orca execution adapter:

- A first start that failed before CLEO sent `worker-start` (for example the
  runtime check failing) was recorded as `outcome_unknown` and fenced every
  later spawn of the task. It is now recorded as `startRefusal: not_launched`
  with no resources, retired, and the spawn refuses with its cause and a fix.
  A retry's unsent start keeps its reserved key replayable.
- The guarded lead terminal now refuses a nonzero `agent-context` exit or a
  malformed command registry with a typed error and fix, instead of a raw
  `SyntaxError` or a misleading "does not declare".
- Corrupt execution metadata on a worker record refuses every reader with a
  typed error naming the record and how to restore it.
