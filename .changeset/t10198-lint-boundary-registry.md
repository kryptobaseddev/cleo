---
"@cleocode/cleo": patch
---

feat(T10198): boundary-registry CI gate (SAGA T10176, ADR-078)

scripts/lint-boundary-registry.mjs enforces registry-vs-filesystem invariant:
orphan modules + missing modules + drift all fail the gate. Wired into CI as
required check via .github/workflows/boundary-registry-lint.yml. Poison test
under scripts/__tests__/.
