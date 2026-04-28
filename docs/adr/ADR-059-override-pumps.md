---
id: ADR-059
title: Override Governance Pumps — per-session cap + shared-evidence flag
status: accepted
created: 2026-04-27
tasks: [T1501, T1502]
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

### D1 — Per-session CLEO_OWNER_OVERRIDE cap (T1501)

**Default cap:** 3 overrides per session.

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

## Implementation

| File | Change |
|------|--------|
| `packages/contracts/src/branch-lock.ts` | Added `E_OVERRIDE_CAP_EXCEEDED` and `E_SHARED_EVIDENCE_FLAG_REQUIRED` error codes |
| `packages/contracts/src/operations/validate.ts` | Added `sharedEvidence?: boolean` to `ValidateGateParams` |
| `packages/core/src/tasks/gate-audit.ts` | Extended `ForceBypassRecord` with `sessionOverrideOrdinal`, `sharedEvidence`, `sharedAtomWarning` |
| `packages/core/src/security/override-cap.ts` | NEW — cap enforcement, waiver validation, persistent count |
| `packages/core/src/security/shared-evidence-tracker.ts` | NEW — atom usage tracking, enforce function |
| `packages/core/src/security/index.ts` | Re-exports for new modules |
| `packages/core/src/internal.ts` | Internal API surface for dispatch layer |
| `packages/cleo/src/dispatch/engines/validate-engine.ts` | Wired cap check + shared-evidence enforcement into `validateGateVerify` |
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

- Override escalation is now bounded per session.  Operators who genuinely need >3
  overrides must produce a waiver document explaining the need — this is the minimum
  friction required to surface patterns that led to the v2026.4.141→.152 failure mode.
- Shared-evidence copy-paste is warned immediately rather than discovered in post-hoc
  audit.  CI pipelines can enable strict mode to turn this into a hard gate.
- The `sessionOverrideOrdinal` field enables time-series analysis of escalation patterns
  within a session for future BRAIN / Sentient learning.
