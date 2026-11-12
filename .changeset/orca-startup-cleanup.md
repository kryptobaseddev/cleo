---
id: orca-startup-cleanup
tasks: [T14522]
kind: fix
summary: "Orca lead refusals close their terminal before retrying startup-directory cleanup"
---

Close a known Orca lead terminal before removing its guarded startup directory.
Retry `ENOTEMPTY` up to three removal attempts when an unowned shell publishes its
PID during cleanup. Cleanup failures retain the original launch-refusal code and
report both terminal and directory cleanup failures without releasing a model turn.
