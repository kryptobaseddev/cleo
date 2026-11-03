---
id: plan-unbound-criteria
tasks: [T14198]
kind: fix
summary: "cleo done --plan is not ready while cleo complete would refuse an unbound criterion, and names the write that binds it"
---

With every required gate already recorded, `cleo done --plan --satisfies
AC1,…,AC4` reported ready and named only `cleo complete`, which then refused
with E_INTERNAL_AC_COVERAGE_INCOMPLETE for AC4: no write was planned, so the
new `--satisfies` link was never recorded (T14173).

The plan now reads the same criterion coverage `cleo complete` checks. When
every gate is recorded and a criterion has no evidence binding, it is not
ready and its `ac-mapping-needed` blocker names the criteria and the
re-verify that binds them: `cleo verify <id> --gate implemented --evidence
'<implemented atoms>;satisfies:<id>#ACn'`. Once that write runs, the plan is
ready and `cleo complete` accepts the coverage.
