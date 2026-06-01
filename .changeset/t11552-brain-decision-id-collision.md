---
id: t11552-brain-decision-id-collision
tasks: [T11552]
kind: fix
summary: brain_decisions.id now allocated atomically inside the INSERT — decision-store survives concurrent agents without UNIQUE collisions or CLEO_OWNER_OVERRIDE
---

Fixes a P1 Living-Brain integrity defect where `cleo memory decision-store` (and every `storeDecision` caller) hit a repeatable `UNIQUE constraint failed: brain_decisions.id` under concurrent writes, blocking the BRAIN decision-store and forcing the `CLEO_OWNER_OVERRIDE` fallback.

Root cause: `storeDecision` allocated the sequential `Dnnn` id with a `MAX(id)+1` read in application code (`nextDecisionId`, an async function with `await` boundaries) and INSERTed the row only later. Two agents writing in the same instant both read e.g. `D042`, both proposed `D043`, and the second INSERT collided on the `id` PRIMARY KEY — losing the decision. Because two writers always read the same `MAX(id)`, the collision was deterministic and reproducible.

Fix: the next id is now computed by a `MAX(CAST(substr(id,2) AS INTEGER))+1` subquery evaluated *inside* the INSERT statement (`BrainDataAccessor.addDecisionWithSequentialId`). node:sqlite executes the statement synchronously and atomically, so the id read and the row write are a single indivisible operation that concurrent async callers cannot interleave. The allocation is also numeric (correct past `D999 → D1000`, where the prior lexical ordering regressed) and tolerant of legacy `D-abcd` ids (`GLOB 'D[0-9]*'`). A bounded retry remains as defense-in-depth for the genuine cross-process case, and the path never uses `INSERT OR IGNORE` so a decision is never silently dropped.

Regression coverage in `packages/core/src/memory/__tests__/decisions.test.ts`: 30 concurrent `storeDecision` calls all persist with distinct sequential ids (a fan-out that exhausts a naive read-then-write retry budget), plus an injected cross-process PRIMARY KEY collision that the retry loop recovers from. Both tests fail against the pre-fix code with the exact `UNIQUE constraint failed: brain_decisions.id` symptom.
