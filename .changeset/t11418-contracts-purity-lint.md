---
id: t11418-contracts-purity-lint
tasks: [T11418]
kind: chore
summary: Add forward-only Contracts Purity Lint (Gate 10) — no net-new runtime helpers in @cleocode/contracts
---

E5 contracts-purity lock for SG-PACKAGE-ARCH. scripts/lint-no-runtime-in-contracts.mjs baselines the 53 existing runtime helpers (migrate OUT under T11392) and fails on net-new bodied functions/arrows that aren't type guards/zod/const data. CI job 'Contracts Purity Lint', AGENTS.md Gate 10. --strict passes once contracts is pure.
