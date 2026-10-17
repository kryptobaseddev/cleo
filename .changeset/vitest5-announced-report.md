---
id: vitest5-announced-report
tasks: [T13874]
kind: fix
summary: verify --run proves minCount from the JSON report vitest 5 writes under the package it ran in
---

With `--reporter=json` and no `outputFile`, vitest 5 writes its report to
`.vitest/json/output.json` under its own root, which is the child's cwd, and
prints `JSON report written to <path>`. Behind `pnpm --filter <pkg> exec` that
root is the package, so the gate looked at the project root, found nothing,
and failed every `minCount` gate with "emitted no machine-readable test report"
(VidaPeps T2018 to T2022 and T781).

The gate now also reads the report path the run announces on stdout, as long
as it is inside the project. That report still has to postdate the spawn:
both its mtime and its `startTime` must be at or after the run started.
