---
id: t10135-stdout-discipline-lint
tasks: [T10135]
kind: chore
summary: "B10 CI gate 'Stdout Discipline Lint' — prevents render logic leaking back into packages/cleo"
prs: [569]
---

Adds `scripts/lint-stdout-discipline.mjs` + the `Stdout Discipline Lint`
CI job. Allowlists `packages/core/src/render/`, `packages/animations/`,
the cleo `animation-bridge.ts`, the thin `renderers/index.ts`
dispatcher, the top-level CLI entry, `scripts/`, and test files.
Baseline mode default (75 pre-existing violations locked in); `--strict`
flips to zero-tolerance after follow-up sweeps. Regression test fixture
asserts a deliberate violation in `packages/contracts/` fails the gate.

Final B-task of E11-HUMAN-RENDER-CONTRACT.
