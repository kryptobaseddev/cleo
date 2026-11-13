---
id: t14534-typed-gate-admission-wait
tasks: [T14534]
kind: fix
summary: "Typed gates: reserve proportional bookkeeping time and name admission refusals"
---

Typed process gates reserve 10% of their available admission budget, capped at two seconds, so short shared deadlines retain a bounded, non-zero admission wait. Admission never waits longer than the gate's own timeout or the original shared deadline. A refused admission reports `E_GATE_ADMISSION_REFUSED` with the ledger's reason and holders, without claiming that a process ran.
