---
id: t10509-ac-coverage-gate
tasks: [T10509]
kind: feat
summary: "complete: AC-coverage gate refuses unsatisfied ACs (T10381 Wave 2d — IVTR closure)"
---

`cleo complete <tid>` now runs an AC-coverage check BEFORE marking the
task done. Every acceptance criterion on the task MUST have at least
one `evidence_ac_bindings` row (any kind: `direct`, `satisfies`, or
`coverage`); the call fails with `E_AC_COVERAGE_INCOMPLETE` listing the
offenders otherwise. This closes the IVTR rubber-stamp gap — the core
goal of Saga SG-IVTR-AC-BINDING.

Two audited override paths exist:

- `--waive-ac "<csv>" --waive-reason "<text>"` — per-AC waiver logged
  to `.cleo/audit/ac-waiver.jsonl`. Tokens may be canonical AC UUIDs or
  `AC<n>` aliases. The reason flag is mandatory.
- `CLEO_OWNER_OVERRIDE=1` + `CLEO_OWNER_OVERRIDE_REASON=<text>` — full
  bypass logged to `.cleo/audit/force-bypass.jsonl` with
  `kind: "ac-coverage"`.

The gate is a no-op for tasks that declare zero ACs (the existing
`enforcement.acceptance.mode='block'` knob covers the "every task must
declare ACs" case).

Adds `AcBindingRow` + `DataAccessor.getAcBindings` to the contracts +
core accessors so the gate reads through the canonical SSoT instead of
poking the schema directly.
