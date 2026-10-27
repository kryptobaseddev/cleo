---
id: done-plan-readiness-matches-complete
tasks: [T14036, T14037]
kind: fix
summary: "cleo done --plan is ready only when cleo complete would accept; show and the plan flag stale testsPassed and qaPassed"
---

`cleo done --plan` could report `ready: true` while a required gate was false
and nothing in the plan recorded it, and it never checked the dependencies
`cleo complete` refuses on. It also kept change-set blockers (no-change-set
for a deletion-only PR, a task reviewed in another checkout) when every
required gate was already recorded and `cleo complete` would accept.

The plan now adds a `manual-gate` blocker, tagged with its gate, for each
required gate that is not passed, has no derived evidence and no other
blocker naming it. It adds a `completion-refused` blocker for each unresolved
dependency, using the same check as `cleo complete` (`unresolvedDependencies`).
It drops change-set blockers once every required gate stands.

`gateStaleness`, the read-only form of the rule `cleo complete` applies to a
recorded testsPassed or qaPassed, is now shared by complete, the plan (whose
blocker names why a recorded gate no longer stands) and `cleo show`, which
warns `W_EVIDENCE_STALE` with the reason.
