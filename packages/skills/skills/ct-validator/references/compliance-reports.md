# Compliance Reports

The shape, severity calculus, and downstream consumption of the
validation report. The report is the validator's product — its format
is rigid because `ct-ivt-looper`, `ct-release-orchestrator`, and HITL
gates all parse it.

## Canonical Report Scaffold

Every report MUST use this structure. Sections are mandatory; their
content varies by mode.

```markdown
# Validation Report: {{VALIDATION_TARGET}}

**Mode**: schema | code | document | protocol
**Date**: {{DATE}}
**Validator**: ct-validator v2.0.0

---

## Summary

- **Status**: PASS | PARTIAL | FAIL
- **Compliance**: {X}%
- **Critical Issues**: {N}
- **Warnings**: {N}
- **Suggestions**: {N}

## Checklist Results

| Check | Status | Details |
|-------|--------|---------|
| {CHECK_1} | PASS/FAIL | {Details} |
| {CHECK_2} | PASS/FAIL | {Details} |

## Issues Found

### Critical
{List or "None"}

### Warnings
{List or "None"}

### Suggestions
{List or "None"}

## Remediation

{Required fixes if FAIL/PARTIAL, or "No remediation required" if PASS}

## Trace

- Target: {file/spec/diff path}
- Tooling: {versions of tools run}
- Reproducer: {one command that re-runs this report}
```

The Trace section is essential — without a reproducer, the report
cannot be re-run later to confirm a remediation worked.

## Status Calculus

| Mode | PASS | PARTIAL | FAIL |
|------|------|---------|------|
| Schema | 0 violations | (n/a) | ≥1 violation |
| Code | 0 critical, ≤2 warnings | 0 critical, 3+ warnings | ≥1 critical |
| Document | All required sections present, 0 broken links | 1-2 missing sections | 3+ missing sections OR broken refs |
| Protocol | 100% REQ compliance | 70-99% compliance | <70% compliance |

The status is not a vote — it is a computed function of the findings.
Two validators running on the same target MUST produce the same
status.

PARTIAL is reserved for cases where the target is shippable WITH
recorded remediation; FAIL means the target cannot ship as-is.

## Severity Definitions

| Severity | Meaning | Examples |
|----------|---------|----------|
| Critical | Blocks ship; data corruption, security, AGENTS.md rejection | `any` type, missing required field, broken link in spec |
| Warning | Should fix soon; degrades quality but does not block | Long body, unused import, missing optional section |
| Suggestion | Improvement opportunity; no obligation | Extract helper, rename for clarity |

Each finding MUST carry a severity. Findings without severity are
unactionable — the consumer cannot prioritize.

## Per-Finding Format

```markdown
### Critical

**C-001**: `packages/cleo/src/dispatch.ts:42` uses `any` type.
- Rule: AGENTS.md Type Safety §1 — "NEVER use `any` type"
- Fix: Import the relevant type from `@cleocode/contracts` or
  define a narrower union.
- Verification: `pnpm biome check packages/cleo/src/dispatch.ts`

**C-002**: `packages/cleo/src/release.ts:107` catches `err: unknown`.
- Rule: AGENTS.md Type Safety §5 — "NEVER use `catch (err: unknown)`"
- Fix: Throw and catch by class from `@cleocode/contracts/errors`.
- Verification: Replace with `catch (err)` and pattern-match by
  `instanceof`.

### Warnings

**W-001**: `packages/cleo/src/dispatch.ts` is 487 lines (warn at 400).
- Rule: ct-skill-validator audit_body §body-length
- Fix: Extract sub-handlers into sibling files.
- Verification: re-run audit_body.py.

### Suggestions

**S-001**: `packages/cleo/src/dispatch.ts:120` has a TODO with no task ID.
- Rule: Internal — TODOs should reference task IDs.
- Fix: File a task, attach the ID: `// TODO(T9999): ...`.
```

Each finding gets a stable ID (`C-NNN`, `W-NNN`, `S-NNN`) so subsequent
reports can reference whether the same issue persists.

## Compliance Percentage

For modes that report a percentage:

```text
compliance = (passed_checks / total_checks) × 100
```

Round to one decimal. For Protocol mode (REQ compliance), checks are
the REQs in the spec's traceability matrix. For Schema mode, "checks"
is the count of constraints evaluated.

When the denominator is zero (e.g., a spec with no REQs), the
percentage is undefined — emit `N/A` and report a Critical finding for
the empty spec.

## Integration with ct-ivt-looper

The IVT loop reads the validator's `status` and `compliance` fields
to decide whether to continue iterating. The contract:

- `status: PASS` → IVT loop converges; release-orchestrator may proceed.
- `status: PARTIAL` → IVT loop loops once more with the remediation as
  input; if still PARTIAL on iteration 3, escalates to HITL.
- `status: FAIL` → IVT loop blocks; release-orchestrator MUST not
  proceed; HITL escalation immediate.

This contract is the reason status calculus is rigid — fuzzy statuses
break the loop's termination conditions.

## Integration with Release

`ct-release-orchestrator` reads the most recent validation report
for the epic before allowing ship. The release pipeline (ADR-065)
contains a gate that asserts `status: PASS` on the implementation
against the spec. PARTIAL reports trigger a recorded remediation
plan; FAIL reports block.

## Machine-Readable Sidecar

Always emit a JSON sidecar next to the markdown report:

```json
{
  "target": "packages/cleo/src/release.ts",
  "mode": "code",
  "status": "FAIL",
  "compliance": 88.5,
  "findings": {
    "critical": [
      {"id": "C-001", "file": "...", "line": 42, "rule": "...", "fix": "..."},
      {"id": "C-002", "file": "...", "line": 107, "rule": "...", "fix": "..."}
    ],
    "warnings": [...],
    "suggestions": [...]
  },
  "trace": {
    "tooling": ["biome@2.4.11", "tsc@5.6.0"],
    "reproducer": "pnpm biome check . && pnpm exec tsc -b",
    "timestamp": "2026-05-19T19:35:00Z"
  }
}
```

The orchestrator parses this when programmatic decisions are needed;
the human report (.md) is for review.

## Anti-Patterns

| Anti-pattern | Why it fails |
|--------------|--------------|
| Vague finding ("file looks weird") | Cannot remediate |
| Missing severity | Consumer cannot prioritize |
| No reproducer in trace | Cannot re-validate after fix |
| PARTIAL with no remediation plan | Status calculus violation |
| Findings without rule reference | Disputable, not actionable |
| Markdown only, no JSON sidecar | Breaks orchestrator integration |
