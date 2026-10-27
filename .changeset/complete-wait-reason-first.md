---
id: complete-wait-reason-first
tasks: [T14042]
kind: fix
summary: "cleo complete waiting on merged CI says so first, with the re-run step, before the CI detail"
---

When merged CI had not finished, `cleo complete` refused with "failed
verification gates: testsPassed/qaPassed (<the whole CI reason>)", so a
truncated message never said to wait. The refusal now starts with "waits for
merged CI ... re-run 'cleo complete <id>' when it has", followed by the CI
detail. The `ci:` refusal itself already leads with its decisive reason (#2483).
