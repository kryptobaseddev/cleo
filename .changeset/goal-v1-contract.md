---
id: goal-v1-contract
tasks: [T13792]
kind: feat
summary: "@cleocode/contracts exports the goal/v1 protocol types: GoalContract with per-criterion proves, GoalTaskLink and GoalOutcome"
---

CLEO owns the goal protocol and OpenCode-Goal is the goal runtime (epic
T13791). `packages/contracts/src/goal-contract.ts` mirrors OpenCode-Goal's
goal/v1 contract field for field and adds an optional `proves` list per
criterion, in the `T123#AC2` form a `satisfies:` atom takes. `GoalOutcome` is
what a run hands back: the contract lock sha256, base and head commits, and a
verdict plus evidence per criterion (command, exit code and test report;
paths; verifier quotes; human sign-off). Types only.
