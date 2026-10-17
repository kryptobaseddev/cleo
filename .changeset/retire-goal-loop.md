---
id: retire-goal-loop
tasks: [T13797]
kind: refactor
summary: "CLEO's unwired goal loop is retired: cleo goal keeps only the protocol verbs draft and close (ADR-097)"
---

CLEO owns the goal protocol and OpenCode-Goal is the goal runtime (owner
decision 2026-10-16; ADR-097, `adr-097-goal-protocol-ocg-runtime`). CLEO's own
goal loop was never driven in production and is removed:
- the never-wired Stop hook (`cleo-os` `goal-stop-hook.ts`);
- the judge and its stub fuzzy judge (`StaticGoalJudge`);
- the turn loop and the continuation builder;
- `cleo go`'s goal arming (`armedGoalId` leaves its result);
- the `cleo goal set|status|advance|subgoal|append` verbs;
- the judge, continuation and advance contracts.

The persisted goal record stays: the `tasks_goal` store and `GoalRecord`.
`cleo goal` now exposes only the protocol verbs `draft` and `close`.
