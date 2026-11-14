---
id: ADR-059
title: Override Governance Pumps — per-session cap + shared-evidence flag
status: accepted
created: 2026-04-27
updated: 2026-04-27
tasks: [T1501, T1502, T1504]
supersedes: ~
---

# ADR-059 — Override Governance Pumps

## Context

Two recurrent failure modes were identified in sessions from 2026-04-21 to 2026-04-28
(v2026.4.141 → v2026.4.152):

1. **P0-5 — Override escalation (T1501):** Agents accumulated 40+ `CLEO_OWNER_OVERRIDE`
   bypasses in a single session without any friction.  The `E_OVERRIDE_RATE_LIMIT` gate
   that existed in `owner-override-auth.ts` was in-process only (reset each CLI invocation)
   and was never wired into the `cleo verify` path.  Every new `cleo` process started with
   a fresh counter.

2. **P0-6 — Copy-paste evidence (T1502):** Agents closed 3–12 unrelated tasks using
   identical `commit:<sha>` atoms, making the evidence trail unfalsifiable.  No detection
   or warning existed.

## Decisions

### D1 — Per-session CLEO_OWNER_OVERRIDE cap (T1501, updated T1504)

**Default cap:** 10 overrides per session (raised from 3 by T1504 — see §D3).

**Persistence:** The running count is stored in
`.cleo/audit/session-override-count.<sessionId>.json` so it survives across multiple
CLI invocations within the same session.

**Above-cap behavior:** When `count >= cap`, the call is rejected with
`E_OVERRIDE_CAP_EXCEEDED` unless `CLEO_OWNER_OVERRIDE_WAIVER=<absolute path>` is set
and the waiver file:
  - exists on disk
  - contains the string `cap-waiver: true` anywhere in its content (YAML front-matter
    or a plain line is acceptable)

**Session status surface:** `cleo session status` now includes an `overrideCount` field
showing the current cap progress for the active session.

**Audit trail:** Every force-bypass JSONL entry now includes a `sessionOverrideOrdinal`
field (1-based within the session) to enable post-hoc escalation pattern analysis.

### D2 — Shared-evidence flag for batch closes (T1502)

**Detection threshold:** When the same evidence atom (`commit:<sha>`, `tool:<name>`,
`test-run:<path>`, etc.) has already been applied to 3 or more distinct tasks in the
current session, the 4th+ application triggers the check.

**Persistence:** Atom usage is recorded in
`.cleo/audit/shared-evidence-recent.jsonl` (append-only rolling log).  Entries from
other sessions are ignored.

**Behavior without `--shared-evidence`:**
  - Non-strict mode (default): emit a warning to stderr, allow the write, and log
    `sharedAtomWarning: true` in the force-bypass audit entry.
  - Strict mode (`CLEO_STRICT_EVIDENCE=1`): reject with
    `E_SHARED_EVIDENCE_FLAG_REQUIRED`.

**Behavior with `--shared-evidence`:** Accept silently and log
`sharedEvidence: true` in the audit entry.

### D3 — Cap default tuning + worktree-context exemption (T1504)

**Context:** T1500 audit found that 39 of 178 force-bypass entries are
by-design — they originate from worktree-orchestrate flows where the
evidence system does not understand worktree branches.  The original cap of
3 (D1) was too low for orchestrate sessions that legitimately spawn multiple
workers and re-verify.

**Cap raised:** `DEFAULT_OVERRIDE_CAP_PER_SESSION` 3 → 10.  Direct sessions
(solo human operator) typically use 1–3 overrides per session; the new limit
gives orchestrate sessions enough headroom without removing friction.

**Worktree-context exemption:** When the CLI command string passed to
`checkAndIncrementOverrideCap` contains `/worktrees/` (the canonical layout
under `~/.local/share/cleo/worktrees/`), and `CLEO_OVERRIDE_EXEMPT_WORKTREE`
is not explicitly set to `0` or `false`, the override:

- is permitted immediately without incrementing the per-session counter.
- returns `workTreeContext: true` in the result.
- is still logged to force-bypass.jsonl with `workTreeContext: true` for
  full audit coverage.

The exemption is off by default in terms of detection scope: only commands
whose path literally passes through the worktree directory are tagged.
Agents that invoke `cleo` from a worktree path automatically qualify;
sessions running from the main working tree do not.

**Env controls:**

| Variable | Default | Effect |
|----------|---------|--------|
| `CLEO_OVERRIDE_CAP_PER_SESSION` | — | Not implemented (use the `cap` param directly) |
| `CLEO_OVERRIDE_EXEMPT_WORKTREE` | `true` | Set to `"0"` or `"false"` to disable worktree exemption |

## Implementation

| File | Change |
|------|--------|
| `packages/contracts/src/branch-lock.ts` | Added `E_OVERRIDE_CAP_EXCEEDED` and `E_SHARED_EVIDENCE_FLAG_REQUIRED` error codes |
| `packages/contracts/src/operations/validate.ts` | Added `sharedEvidence?: boolean` to `ValidateGateParams` |
| `packages/core/src/tasks/gate-audit.ts` | Extended `ForceBypassRecord` with `sessionOverrideOrdinal`, `sharedEvidence`, `sharedAtomWarning`, `workTreeContext` |
| `packages/core/src/security/override-cap.ts` | NEW — cap enforcement, waiver validation, persistent count; T1504: raised default 3→10, added `isWorktreeContext`, `isWorktreeExemptionEnabled`, `WORKTREE_PATH_SEGMENT`, `workTreeContext` result field |
| `packages/core/src/security/shared-evidence-tracker.ts` | NEW — atom usage tracking, enforce function |
| `packages/core/src/security/index.ts` | Re-exports for new modules (extended for T1504 exports) |
| `packages/core/src/internal.ts` | Internal API surface for dispatch layer (extended for T1504 exports) |
| `packages/cleo/src/dispatch/engines/validate-engine.ts` | Wired cap check + shared-evidence enforcement into `validateGateVerify`; T1504: passes `command` to cap check + logs `workTreeContext` in bypass record |
| `packages/cleo/src/dispatch/engines/session-engine.ts` | `sessionStatus` now returns `overrideCount` |
| `packages/cleo/src/dispatch/domains/session.ts` | Updated fallback shape with `overrideCount: 0` |
| `packages/cleo/src/dispatch/domains/check.ts` | Threads `sharedEvidence` param to engine |
| `packages/cleo/src/cli/commands/verify.ts` | Added `--shared-evidence` flag |

## Error Codes

| Code | Condition |
|------|-----------|
| `E_OVERRIDE_CAP_EXCEEDED` | Per-session override count ≥ cap and no valid waiver doc |
| `E_SHARED_EVIDENCE_FLAG_REQUIRED` | Atom reuse >3 tasks and `CLEO_STRICT_EVIDENCE=1` and no `--shared-evidence` |

## Waiver Document Format

A waiver document is any file containing the string `cap-waiver: true`.  The recommended
format is YAML front-matter:

```yaml
---
cap-waiver: true
rationale: |
  <mandatory explanation — at least one sentence>
approver: <name>
date: <ISO 8601>
---
```

The file is an artifact of the approval process; its content beyond the marker line is
advisory only (not machine-validated).

## Consequences

- Override escalation is now bounded per session.  Operators who genuinely need >10
  overrides must produce a waiver document explaining the need — this is the minimum
  friction required to surface patterns that led to the v2026.4.141→.152 failure mode.
- Shared-evidence copy-paste is warned immediately rather than discovered in post-hoc
  audit.  CI pipelines can enable strict mode to turn this into a hard gate.
- The `sessionOverrideOrdinal` field enables time-series analysis of escalation patterns
  within a session for future BRAIN / Sentient learning.
- Worktree-orchestrate sessions no longer exhaust the cap budget through by-design
  overrides.  The 39 entries identified in the T1500 audit are now tagged
  `workTreeContext: true` in force-bypass.jsonl and excluded from the counter.
  Administrators can filter these out of escalation reports using the new field.
