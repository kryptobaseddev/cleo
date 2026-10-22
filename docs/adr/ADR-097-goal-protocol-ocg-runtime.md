# ADR-097: CLEO owns the goal protocol; CLEO Goal is the goal runtime

- Status: Accepted
- Date: 2026-10-16 (amended 2026-10-17)
- Deciders: project owner (decisions 2026-10-16 and 2026-10-17)
- Epic: T13791 (parent saga T11283)
- Design: CLEO doc `ocg-cleo-integration`
- Supersedes: CLEO's in-repo goal loop (EP-CLEO-GOAL-SYSTEM, T11290 / T11496)

## Context

CLEO had its own goal loop: a DB-persisted per-agent goal record, an
evidence-aware judge with a stub LLM fallback (`StaticGoalJudge`), a
continuation builder, `cleo goal set|status|advance|subgoal|append`, goal
arming in `cleo go`, and a Stop hook (`goal-stop-hook.ts`). The Stop hook was
never wired into any harness, the fuzzy judge was a stub, and nothing drove
the loop in production.

OpenCode-Goal, now **CLEO Goal**, independently became a working goal runtime.
It has hash-locked `goal/v1` contracts, host-run checks, an independent
verifier with re-read quotes, owner sign-off, budgets, amendments and a run
ledger. Two goal systems would have meant two contract formats, two judges and
two Stop hooks fighting over the same event.

## Decision

1. **CLEO owns the goal protocol. CLEO Goal is the goal runtime.**
   - The runtime is the package `@cleocode/goal`. It is published from its own
     repository through its own OIDC trusted publisher.
   - It stays standalone: it has no dependency on CLEO, and it installs on its
     own as a harness plugin.
   - Its bin is `cleo-goal`, with the alias `ocg`, which officially stands for
     "open cleo goal".
   - CLEO Goal talks to CLEO only through the `cleo` CLI and LAFS envelopes,
     and never reads `.cleo/`. CLEO talks to CLEO Goal only through the
     `cleo-goal` bin and its versioned JSON output, and never reads its
     internal files (for example `run.json`).
2. **CLEO installs CLEO Goal as an optionalDependency.** `cleo doctor` checks
   its version and health (T13819). `cleo goal install --harness <h>` installs
   it into a project, project-scoped and never in user-global harness config
   (T13820).
3. **The protocol lives in CLEO:**
   - `goal/v1` contract, task link and outcome types in `@cleocode/contracts`
     (`goal-contract.ts`, T13792). Criteria bind to CLEO acceptance criteria
     through `proves`, in the three `satisfies:` forms.
   - `cleo goal draft` writes a contract from a task's acceptance criteria,
     never weaker than the gates it proves (T13793).
   - `cleo goal close` treats a run's outcome as claims. It re-checks what
     CLEO can at the head commit, records evidence through the `cleo verify` /
     `cleo done` write, and completes only tasks whose criteria are all mapped
     (T13794).
   - `cleo tasks changeset --test-plan` exposes the change set and the exact
     tests owed (T13795).
   - `cleo done --commit` completes landed work that no PR or branch cites
     (T13799).
4. **One Stop entry per provider** (`cleo hook stop`, T13796), run in order
   goal tick → ask-enforce → session end. The tick runs `cleo-goal tick`,
   falling back to `ocg tick`. CLEO Goal installs no Stop hook of its own.
5. **`cleo goal` and `cleo go` are repurposed, not dropped.**
   - `cleo goal` keeps only protocol verbs: `draft`, `close` and `status`.
     `status` returns once `cleo-goal status --json` (versioned) exists, and
     refuses a schema version it does not recognize.
   - `cleo go` drafts a goal for the next ready wave and starts a goal run
     through the CLEO Goal bin (T13821). When CLEO Goal is missing, it points
     at `cleo goal install`.
6. **CLEO's own goal loop is retired** (T13797).
   - Removed: the Stop hook, the judge and stub fuzzy judge, the loop, the
     continuation builder, goal arming in `cleo go`, and the
     `cleo goal set|advance|subgoal|append` verbs.
   - Kept: the persisted goal record (`tasks_goal` store, `GoalRecord`
     contracts).

## Consequences

- One contract format and one judge path: evidence from a goal run reaches
  CLEO's gates only through the existing evidence validators.
- A verifier verdict, a diff guard or a runtime's exit code never satisfies a
  gate on its own.
- Agents that called `cleo goal set|advance|subgoal|append` get "unknown
  subcommand". No harness or skill invoked them.
- CLEO Goal must cite every linked task id in a goal-run commit message when
  work lands without a PR or branch, so `cleo done --commit` can bind each
  task.
