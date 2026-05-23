---
"@cleocode/cleo": patch
---

ci(T10135): stdout-discipline lint gate — prevents render logic leaking back into packages/cleo (B10)

Adds scripts/lint-stdout-discipline.mjs + CI job 'Stdout Discipline Lint (T10135)'. Allowlists packages/core/src/render/, packages/animations/, the cleo animation-bridge, the thin renderers/index.ts dispatcher, the top-level CLI entry, scripts/, and test files. Baseline-regression mode by default (fails only on net-new violations vs scripts/.lint-stdout-discipline-baseline.json); --strict for zero-tolerance.

Closes T10135 (final B-task of E11-HUMAN-RENDER-CONTRACT). Epic: T10114. ADR: adr-077-human-render-contract.
