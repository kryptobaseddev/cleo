---
id: t12312-nexus-analyze-fixed-budgets
tasks: [T12312]
kind: fix
summary: Rebuilding the code index no longer fails on a slow machine, and says what happened when it does
---

Rebuilding the symbol index allowed each batch of ignore checks a flat two seconds and each file a flat five, then reported an overrun as the raw `spawnSync git ETIMEDOUT` — naming no invocation, no budget and no remedy. Neither figure scaled with the work or the machine, and the first was rolled once per two hundred and fifty-six files, so a repository of nine thousand files rolled it thirty-six times per run. Measured on a mount roughly thirty times slower than local disk, warm cache and idle: a single batch already consumed eighty-five per cent of its budget, and varied twofold between runs. The failure was therefore intermittent by construction, which is why it reproduced for one agent and not the next.

Both budgets now scale with the work asked for, are overridable by an operator, and a transient overrun of the ignore assessment is retried once before the scan is abandoned. Where a budget is genuinely exhausted the report names the invocation, both budgets, the batch and the override, and states that the scan is abandoned deliberately — a batch the version-control tool could not classify must not be indexed as though nothing in it were ignored.

The per-worker memory ceiling was written out twice, in the worker pool and in the execution port that launches it. Raising one left the other rejecting the value the first had just accepted, and the rejection quoted the old ceiling. The bound is now published once and both sites derive their limit and their message from it, so neither can drift from the other again.

A worker that dies is no longer reported as a broken pipe. The write failure was surfaced verbatim, which named the symptom and settled the result before the exit handler could supply the cause. The report now names the file in flight, distinguishes a worker that was killed from one that threw, and says which remedies apply to which — raising a memory ceiling cannot help a worker that exited of its own accord. That distinction immediately localised a further defect that had been invisible behind the old message, now tracked separately.

Code placed in packages/nexus/ for the pipeline, packages/core/ for the execution port and packages/contracts/ for the shared bound per Package-Boundary Check — verified against AGENTS.md.
