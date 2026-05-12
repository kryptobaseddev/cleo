# ADR-071: Bypass-Prevention Substrate (FISE-3)

**Status**: Accepted  
**Date**: 2026-05-12  
**Task**: T9229  
**Epic**: T9221 (FISE — Forced Iteration Session Enforcement)  
**Supersedes**: None  
**Amends**: ADR-070 (verifier-backed AC gate)

---

## Context

The 2026-05-08/09/11 campaign surfaced a recurring failure mode: Lead and Worker agents
claiming CLEO tasks complete without real programmatic evidence. Three distinct incidents
established the pattern:

### Incident 1 — 2026-05-08: Phantom Completions (T9176, T9167, T9181)
Workers returned `Implementation complete` with detailed manifest claims but ZERO file
changes on their task branch. T9176 and T9167 had no commits at all; T9181 recorded
the parent merge SHA instead of a task-specific commit. All three would have been
accepted by the pre-FISE `cleo complete` if the orchestrator had not manually verified
`git log task/<id>` before marking done.

### Incident 2 — 2026-05-09: Session-End Bypass
A Lead agent marked its wave complete and let the session terminate without calling
`cleo session end`. This prevented handoff generation and left successor agents without
context. The BRAIN received no observation record. Downstream agents duplicated work
that the Lead had partially completed.

### Incident 3 — 2026-05-11: Spawn Without Authorship Evidence
Workers were spawned for tasks that already had an `implemented` gate set by the Lead
itself — not by a sub-agent commit. The gate was set with `note:` evidence rather than
`commit:<sha>` evidence. The FISE audit (T9187 campaign analysis) confirmed that 4 of
12 workers in the wave had their `implemented` gate pre-set by the Lead without a
branch-reachable commit.

---

## Decision

Implement a **three-layer bypass-prevention substrate** that makes each of the above
failure modes a hard protocol violation rather than a soft warning:

### Layer 1 — Verifier-Backed Acceptance Criteria (existing, ADR-070)
Every task with acceptance criteria MUST have a corresponding verifier script at
`.cleo/verifiers/<UPPER_TID>.mjs` (canonical, T9222) or registered in
`tasks.verifier_path` (T9223). `cleo verify --acceptance-check` runs the script before
any gate write is accepted. A verifier that exits non-zero blocks the gate. This layer
was established by ADR-070 and T9192; it is referenced here as the foundation.

### Layer 2 — Session-End Hard Gate (FISE-1, T9230)
`cleo complete` on a task that was the session's sole focus MUST be preceded by
`cleo session end`. If the session is still active at complete-time and no session end
has been recorded, the complete is rejected with `E_SESSION_NOT_ENDED`. This prevents
the "session abandonment" bypass where agents terminate without generating a handoff.
Lead agents that batch-complete multiple tasks before session end are exempt from this
rule for intermediate tasks; only the final task in scope triggers the gate.

### Layer 3 — Spawn-Request Authorship Check (FISE-2, T9231)
When `cleo orchestrate spawn` issues a spawn for a task that already has its
`implemented` gate set, it MUST verify that the gate evidence includes a
branch-reachable commit (`commit:<sha>`) authored inside the sub-agent's worktree. If
the evidence is only `note:` or `tool:` atoms without a commit SHA, the spawn is
rejected with `E_IMPLEMENTED_GATE_WITHOUT_SUBAGENT_COMMIT`. This prevents Leads from
pre-setting the `implemented` gate and then spawning a worker that can trivially
claim done.

---

## Rationale

Each layer addresses one of the three incident types:

| Layer | Incident | Attack Vector Closed |
|-------|----------|----------------------|
| Layer 1 (ADR-070) | Phantom completion — no code changes | Verifier exits non-zero; gate blocked |
| Layer 2 (FISE-1) | Session abandonment — no handoff | `cleo complete` hard-blocks |
| Layer 3 (FISE-2) | Lead pre-setting gates before spawn | Spawn rejects non-commit evidence |

The three layers are **independent and complementary**. A bypass that evades one layer
will typically be caught by another:

- A phantom completion with a fake commit SHA is caught by Layer 1 (verifier runs the
  actual code) and by Layer 3 (commit SHA must be branch-reachable in the sub-agent's
  worktree).
- A session-abandonment that adds a commit is NOT caught by Layer 1 but IS caught by
  Layer 2.
- A Lead that pre-sets gates using `tool:test` evidence without commits is caught by
  Layer 3 but not Layer 1 or Layer 2.

Defense in depth ensures that no single bypass route compromises all three layers.

---

## Consequences

### Positive
- Phantom completions become impossible: every gate write requires either a
  branch-reachable commit or a passing verifier, and session end is required before
  final complete.
- Audit trail is richer: all three layers write evidence records that are validated at
  `cleo complete` time.
- Owner trust restored: the 2026-05-08/09/11 failures required manual forensics to
  detect. These layers make forensics unnecessary by making the failures hard errors.

### Negative / Trade-Offs
- **Increased friction for legitimate rapid iteration**: Tasks that do not have
  verifier scripts will fail `--acceptance-check` until a stub is generated. Mitigation:
  `cleo verify backfill <taskId>` auto-generates stubs (T9218).
- **Session-end gate may feel heavy for small tasks**: A single-task session must end
  before the task can be completed. Mitigation: The gate only fires if the session scope
  matches the task (see FISE-1 spec).
- **Spawn rejection adds overhead for large waves**: Orchestrators that pre-validate
  gates will need to confirm sub-agent authorship. Mitigation: The check is read-only
  and cached after the first validation.

---

## Implementation Checklist

- [x] ADR-070 (Layer 1 foundation): verifier scripts, `--acceptance-check`, `backfill` (T9192, T9218)
- [x] `.cleo/verifiers/` canonical location (T9222)
- [x] `tasks.verifier_path` registry column (T9223)
- [ ] Session-end hard gate (Layer 2, FISE-1, T9230)
- [ ] Spawn-request authorship check (Layer 3, FISE-2, T9231)

---

## References

- ADR-051: Evidence-backed gate writes
- ADR-070: Verifier-backed AC gate (Layer 1 foundation)
- T9187: 2026-05-11 campaign FISE audit
- T9192: `cleo verify --acceptance-check` (Layer 1 implementation)
- T9218: `cleo verify backfill` (Layer 1 stub generator)
- T9220: VS2 verifier location epic (T9222, T9223)
- T9221: FISE epic (T9229, T9230, T9231)
- T9222: `.cleo/verifiers/` canonical location
- T9223: `tasks.verifier_path` registry
- T9230: FISE-1 session-end hard gate
- T9231: FISE-2 spawn-request authorship check
