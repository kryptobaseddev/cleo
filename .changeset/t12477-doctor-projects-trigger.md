---
id: t12477-doctor-projects-trigger
tasks: [T12477]
kind: docs
summary: the new-device/restore/migration trigger now leads with `cleo doctor projects` (CLEO-INJECTION.md 2.20.9 + ct-cleo 2.20.9)
---

`cleo doctor projects` (T12471, #1611) is the machine-wide registry integrity
check: it reports moved, missing, split and temp rows with remedies, is a dry
run by default, rebinds only on checkout-nonce proof with `--apply` and a
receipt, and restores with `--rollback <id>`. The Triggers row in
CLEO-INJECTION.md and the ct-cleo identity section now name it first and drop
the TODO(T12471) placeholders.
