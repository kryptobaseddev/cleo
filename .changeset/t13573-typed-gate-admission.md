---
id: t13573-typed-gate-admission
tasks: [T13573]
kind: fix
summary: "Typed process gates (cleo verify --run, check.gate.verify) admit through the machine ledger like cleo run"
---

Typed test, command and lint gates were spawned with heap caps but never admitted, so `cleo verify --run` ran a gate while `cleo run` jobs waited on a full, pressure-halved budget. A typed process gate now acquires the same machine-wide admission ledger as `cleo run` and `tool:` evidence, under the same pressure predicate, charged what `cleo run` would charge the same command (`planRunFootprint`). Test gates are charged as `test-run`, command and lint gates as `scoped-build`. The gate waits while the budget is full. If the budget is still full past its deadline (less the bookkeeping margin), the gate is refused with the admission's own reason naming the holders, and nothing is spawned. The gate's child inherits the admission token, so a governed command it starts is not charged twice. It shows in holder reports as `gate:test` or `gate:command`.
