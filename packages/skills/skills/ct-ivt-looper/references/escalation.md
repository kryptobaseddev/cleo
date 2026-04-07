# IVT Non-Convergence Escalation

When the loop exhausts `MAX_ITERATIONS` without converging, the skill hands control back to a human reviewer. This file documents the hand-off contract.

## When to Escalate

Escalation fires on exactly one condition:

```
iteration == MAX_ITERATIONS && converged == false
```

Other failure modes — missing framework, protected branch, credential error — also exit with code 65, but they are **pre-loop** escalations. This document covers post-loop escalation only.

## Manifest Entry on Escalation

The escalation manifest entry MUST include:

| Field | Value | Why |
|-------|-------|-----|
| `agent_type` | `"testing"` | IVT-008; every run, converged or not |
| `framework` | detected framework | IVT-001 |
| `testsRun` | final count | Evidence of the last attempt |
| `testsPassed` | final count | — |
| `testsFailed` | final count | — |
| `ivtLoopConverged` | `false` | IVT-007 |
| `ivtLoopIterations` | `MAX_ITERATIONS` | Shows exhaustion |
| `key_findings` | diagnostic lines | Reviewer reads these first |

Example:

```json
{
  "agent_type": "testing",
  "framework": "pytest",
  "testsRun": 87,
  "testsPassed": 84,
  "testsFailed": 3,
  "ivtLoopConverged": false,
  "ivtLoopIterations": 5,
  "key_findings": [
    "tests/test_auth.py::test_expired_token failed on all 5 iterations",
    "fix attempts alternated between re-raising and swallowing TokenExpiredError",
    "spec clause SEC-003 not satisfied by any current test",
    "worktree left at commit 3a2f1e9 on branch feature/auth-refresh"
  ]
}
```

`key_findings` is the most important field. The reviewer does not re-run the loop's diagnostics; they read the findings and decide which lever to pull.

## Worktree State

The skill MUST NOT revert the worktree on escalation. The reviewer needs:

- The last patch that was attempted.
- The last test output.
- Any temporary files the loop created.
- The current branch (as left by the loop).

Reverting destroys all of this evidence and forces the reviewer to re-run the loop from scratch. Do not revert.

## Reviewer Levers

When a human reviewer picks up an escalated loop, they have four options:

| Lever | When to use | Consequence |
|-------|-------------|-------------|
| **Raise the cap** | The loop was making progress but needed more iterations | Set `MAX_ITERATIONS` higher for this task; rerun the skill |
| **Rewrite the spec** | A spec clause is impossible or contradictory | Update the spec, then rerun the loop; the trace will now match |
| **Manual correction** | The spec is fine but the loop's fix generator is stuck | Apply a human patch, then rerun; the loop resumes from the corrected state |
| **Abandon the task** | The work is no longer needed | Mark the task `cancelled`; no rerun |

The skill does not pick a lever itself. Picking a lever is a human decision.

## Rerun Semantics

When the skill is re-invoked after an escalation, it MUST:

1. Read the previous manifest entry for the task.
2. Start a new iteration counter (the cap applies per invocation, not globally).
3. Keep the worktree state; do not reset to a prior commit.
4. Write a fresh manifest entry on completion — do not edit the old one.

The previous manifest entry stays in the canon as the record of the failed attempt. The new entry sits alongside it. This preserves the history for post-mortems.

## Escalation Is Not Failure

A loop that converges in five iterations and a loop that escalates to HITL are both valid outcomes. Escalation is the mechanism by which the skill stays honest about its limits. Agents that hide non-convergence by spoofing convergence metrics are worse than agents that escalate cleanly.

The only actual failure mode is: skipping the escalation, marking the task done, and letting uncovered spec clauses leak into a release.
