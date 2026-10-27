---
id: done-plan-ready-matches-complete
tasks: [T14036, T14037]
kind: fix
summary: "cleo done --plan is ready exactly when cleo complete would accept, and show flags recorded gates that no longer stand"
---

`cleo done --plan` and `cleo complete` disagreed in both directions. The plan
said `ready: true` with a required gate still false (EscapePlan T584/T586),
because a gate with no derivable evidence produced no blocker, and it ignored
`depends` edges that `complete` refuses. It also refused with `no-change-set`
when every gate was already recorded and `complete` succeeded (EscapePlan
T616, Kodo T301). The plan now reports a `gate-not-derivable` blocker for each
required gate that is neither passed nor planned, a `dependency-unresolved`
blocker for each non-terminal dependency (with the complete, drop-edge or
waiver remedy), and drops change-set blockers once every required gate
stands.

A recorded gate that had gone stale stayed invisible until `complete`
refused it. A new read-only `gateStaleness` applies complete's own checks
(re-validation of each gate's atoms, plus the testsPassed/qaPassed superseded
rules). The plan uses it to judge recorded gates and names the reason, and
`cleo show` emits a `W_GATE_STALE` warning for each stale gate.
