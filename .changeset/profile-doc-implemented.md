---
id: profile-doc-implemented
tasks: [T14187]
kind: fix
summary: "an ops, census or audit task with no code change proves implemented with its stored document and a note"
---

`cleo done --plan` proposed `files:<stored doc>;note:…` for a gate-profiled
task with no commit, PR or decision (a measurement, T14178), and the
`implemented` gate refused it: it accepted files or note only beside a
commit, decision or PR.

`@cleocode/contracts` now holds one table, `PROFILE_GATE_EVIDENCE`, of the
atom combinations each gate profile adds (`GATE_PROFILE_NAMES`, the closed
`profile:<name>` set). `ops`, `census` and `audit` add `[files, note]` to
`implemented`; `decision` adds nothing, so a decision task still proves
itself with its decision. `validateEvidenceForGate` and the requirement
messages take the profile, and `cleo verify`, `cleo complete` and
`cleo done --plan` read the same table: the plan proposes files+note only
where the gate accepts it.

The profile applies only while the task classifies as non-code and every
`files:` path is a document (a stored attachment or blob, or a document
artifact). A profiled change that touches code keeps the base requirements
and still owes a commit or PR, and the code gates.
