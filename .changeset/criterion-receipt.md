---
id: criterion-receipt
tasks: [T14199]
kind: feat
summary: "cleo verify --criterion binds a decision or stored document to one non-code criterion, covering only that criterion and setting no gate"
---

A code task's criterion that an owner decision, a design note or a filing
meets used to be waived, because the code gates take no `decision:` and no
document-only `files:` (owner override audit, class A).

`cleo verify <id> --criterion --evidence 'decision:<id>;satisfies:<id>#AC<n>'`
(or `files:<document paths>`) records a per-criterion receipt: one binding
for that criterion in the AC-coverage gate and a `criterion.receipt`
audit-log entry. It never touches `implemented`, `testsPassed` or
`qaPassed`, which still owe their code evidence. A criterion naming a code
path (the T14065 token rule) is refused with `E_CRITERION_NAMES_CODE`,
naming the token; so are code files, gate atoms, several criteria at once,
and child-task or typed criteria.
