---
id: retire-goal-loop
tasks: [T13797, T13821]
kind: refactor
summary: "cleo goal keeps only protocol verbs (draft, close, status); cleo go hands the ready wave to OpenCode-Goal; CLEO's unwired goal loop is retired (ADR-097)"
---

CLEO owns the goal protocol and OpenCode-Goal is the goal runtime (owner
decision 2026-10-16; ADR-097, `adr-097-goal-protocol-ocg-runtime`).

- **`cleo goal`** keeps only the protocol verbs `draft`, `close` and a new
  `status`. `status` reads the project's goal runs (`.opencode/goals/*/goal.yaml`
  and `run.json`) read-only, and lists the CLEO tasks each serves (`--task`
  filters).
- **`cleo go`** is repurposed. For implementation-stage work it drafts a
  goal/v1 contract for the active saga's ready wave, reusing an existing draft
  and never overwriting it. It returns `goalHandoff` with the exact next step:
  `/goal start <slug>` when OpenCode-Goal is installed, otherwise the commands
  that install it. It never installs anything itself. Its IVTR cantbook fan-out
  (`ivtrFanOut`, the injected runner, `CLEO_GO_VIA_PLAYBOOK`) is removed.
- **Retired:**
  - the never-wired Stop hook;
  - the judge and stub fuzzy judge;
  - the turn loop and the continuation builder;
  - `cleo go`'s goal arming;
  - the `cleo goal set|advance|subgoal|append` verbs and their contracts.

  The persisted goal record (the `tasks_goal` store and `GoalRecord`) stays.
