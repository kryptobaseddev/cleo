---
"@cleocode/cleo": patch
---

feat(T10199): dual-implementation CI gate (SAGA T10176, ADR-078)

scripts/lint-dual-implementation.mjs closes the T9977 partial-application failure
mode: detects Rust+TS duplicates of the same primitive and fails the gate unless
allowlisted via boundary registry. Wired as required check.
