---
id: ivtr-fix-text
tasks: [T13945]
kind: fix
summary: "E_IVTR_INCOMPLETE fixes and the parent-epic E_LIFECYCLE_GATE_FAILED fix no longer point at cleo go, cleo playbook run ivtr or cleo lifecycle complete"
---
Both fixes told agents to drive IVTR with `cleo go` or `cleo playbook run
ivtr`, and neither command drives IVTR any more (T11896). The error codes and
exit numbers are unchanged. The fixes now say what works: inspect the legacy
state with `cleo show <id> --ivtr-history` and report the task to the lead or
owner.

The parent-epic stage gate in `cleo complete` (exit 80, strict mode) no
longer tells agents to run `cleo lifecycle complete`. It explains that `cleo
update <epic> --pipeline-stage implementation` is refused while children sit
at the epic's stage, and says to report the epic to the lead or owner (T13969).
