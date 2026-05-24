---
id: t9936-reject-invalid-kind
tasks: [T9936]
kind: fix
summary: cleo changeset add rejects invalid kind values + lint surfaces all violations
---

T9936: locks the kind-enum gate end-to-end (writer + CLI + lint).

- Adds regression tests in writer (kind='feature' + 6 other invalid shapes).
- Rewrites scripts/lint-changesets.mjs from fail-fast to collect-all so the
  4-file 'kind: feature' drift class surfaces in ONE CI pass.
- Adds scripts/__tests__/lint-changesets.test.mjs (5 tests).

Closes T9936. Saga: T9862.
