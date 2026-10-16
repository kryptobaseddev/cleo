---
id: goal-v1-contract
tasks: [T13792]
kind: feat
summary: "@cleocode/contracts exports the goal/v1 protocol types: GoalContract with per-criterion proves, GoalTaskLink and GoalOutcome"
---

CLEO owns the goal protocol and OpenCode-Goal is the goal runtime (epic
T13791). `packages/contracts/src/goal-contract.ts` mirrors OpenCode-Goal's
goal/v1 contract field for field and adds an optional `proves` list per
criterion. Each entry takes one of the three target forms of a `satisfies:`
atom:
- positional `T123#AC2`;
- canonical `T123#<criterion uuid>`, which stays put when ACs are renumbered;
- pinned `T123#AC2@<14-digit pin>`.

`GoalOutcome` is what a run hands back: the contract lock sha256, base and head
commits, and a verdict plus evidence per criterion. Evidence is one of: command,
exit code and test report with its sha256; paths; verifier quotes; human
sign-off. A passing diff proves paths did not change, and a human sign-off
counts only when CLEO's own owner or HITL record backs it. Types only.
