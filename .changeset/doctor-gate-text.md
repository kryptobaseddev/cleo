---
id: doctor-gate-text
tasks: [T14635]
kind: fix
summary: "cleo doctor gate-text lists and converts text acceptance stored as typed gate JSON"
---

Tasks whose text acceptance was stored as a typed gate's JSON before writes
refused that input (T12292) could not be decomposed and had no route forward.
`cleo doctor gate-text` lists them (dry run, exits 1 while any remain);
`--apply` converts each criterion on an open task to its typed gate in place,
with the same checks as `cleo req add`. A task in an AC-locked stage converts
only with `--reason`, audited like `cleo update --reason`; without one it is
listed with that command. The old text is kept in the AC history, the task
audit row carries a receipt per criterion, and a row with evidence bindings but
no uid is reported instead of losing them. Terminal tasks are listed for
information only and never fail the command.
