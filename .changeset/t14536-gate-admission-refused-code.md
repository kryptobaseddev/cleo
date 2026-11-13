---
id: t14536-gate-admission-refused-code
tasks: [T14536]
kind: fix
summary: "Typed gates: a refused admission is its own verify code, and late gates keep the bookkeeping reserve"
---

A `--run-typed` evidence write whose linked typed gate the machine-wide ledger refused to start now fails with `E_GATE_ADMISSION_REFUSED` (exit 7, fix `cleo verify <id> --run`) and records nothing, instead of storing a generic gate error. The prefix is exported as `GATE_ADMISSION_REFUSED_PREFIX`. When the shared deadline binds for a later gate in a batch, admission now ends a whole two-second bookkeeping budget before that deadline, so a late refusal is reported as itself, never as `E_OPERATION_DEADLINE`.
