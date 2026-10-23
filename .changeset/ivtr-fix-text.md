---
id: ivtr-fix-text
tasks: [T13945]
kind: fix
summary: "E_IVTR_INCOMPLETE fixes from cleo complete and the release IVTR gate no longer point at cleo go or cleo playbook run ivtr"
---
Both fixes told agents to drive IVTR with `cleo go` or `cleo playbook run
ivtr`, and neither command drives IVTR any more (T11896). The error codes and
exit numbers are unchanged. The fixes now say what works: inspect the legacy
state with `cleo show <id> --ivtr-history` and report the task to the lead or
owner, or bypass the release gate with force.
