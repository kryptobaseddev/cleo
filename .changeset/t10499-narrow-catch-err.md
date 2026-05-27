---
id: t10499-narrow-catch-err
tasks: [T10499]
kind: fix
summary: narrow catch err in validate-spawn-readiness (replace any with Error narrowing)
---

T10451 shipped `validateSpawnReadiness` with two `catch (err: any)` clauses
which fail biome's `noExplicitAny` check during release.yml's lint step.
Result: v5.118-121 release publishes all failed at the lint gate, leaving
npm stuck at v5.120 despite tags reaching `main`. Narrowed both clauses
to instanceof Error / structured shapes.

Closes T10499. Saga: T9862.
