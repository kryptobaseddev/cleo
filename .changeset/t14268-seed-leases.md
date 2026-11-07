---
id: t14268-seed-leases
tasks: [T14268]
kind: test
summary: "tests that seed a task as active now also give it a live test lease, so they keep passing once active is derived from the lease"
---

Test-only preparation for retiring stored `active` (D11230). A shared helper
in `test-db-helper.ts` gives a task a live claim lease: `seedTasks` leases
every task it seeds as `active`, and `leaseTestTask` / `leaseTestTasks` lease
tasks a test created through `createTask` or a migration. Every assertion
holds under today's stored-status model and under the derived model.
