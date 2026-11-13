---
id: t14536-gate-admission-refused-code
tasks: [T14536]
kind: fix
summary: "Typed gates: a refused admission is its own verify code (exit 28), and later gates keep the batch reserve"
---

A `--run-typed` evidence write whose linked typed gate the machine-wide ledger refused to start now fails with `E_GATE_ADMISSION_REFUSED` (new exit code 28, `ExitCode.GATE_ADMISSION_REFUSED`, fix `cleo verify <id> --run`) and records nothing, instead of storing a generic gate error; `cleo verify` exits 28 because `gate.set` now keeps the engine's exit code. The prefix is exported as `GATE_ADMISSION_REFUSED_PREFIX`. The admission reserve (10% of the budget, at most two seconds) is fixed when a gate batch starts, so small budgets keep a bounded non-zero wait and a later gate never waits into the reserve: a late refusal is reported as itself, never as `E_OPERATION_DEADLINE`.
