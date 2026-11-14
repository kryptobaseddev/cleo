---
name: ct-validator
description: Compliance validation for verifying systems, documents, or code against requirements, schemas, or standards. Performs schema validation, code compliance checks, document validation, and protocol compliance verification with detailed pass/fail reporting. Use when validating compliance, checking schemas, verifying code standards, or auditing protocol implementations. Triggers on validation tasks, compliance checks, or quality verification needs.
version: 2.2.0
protocol: validation
adrRefs:
  - ADR-051
  - ADR-023
  - ADR-061
dependencies: []
sharedResources:
  - subagent-protocol-base
  - task-system-integration
compatibility:
  - claude-code
  - cursor
  - windsurf
  - gemini-cli
license: MIT
metadata:
  version: 2.2.0
  tier: on-demand
  install: harness
  covers:
    - packages/core/src/validation/protocols/cant/validation.cant
    - packages/core/src/validation/protocols/protocols-markdown/validation.md
    - packages/core/src/validation/protocols/cant/testing.cant
    - packages/core/src/validation/protocols/protocols-markdown/testing.md
  loomStage: validation
  lastReviewed: 2026-11-14
  stability: stable
---

# Validator Context Injection

**Protocol**: @src/protocols/implementation.md
**Type**: Context Injection (cleo-subagent)
**Version**: 2.0.0

---

## Purpose

Context injection for compliance validation tasks spawned via cleo-subagent. Provides domain expertise for verifying that systems, documents, or code comply with specified requirements, schemas, or standards.

---

## Capabilities

1. **Schema Validation** - Verify data structures against JSON Schema
2. **Code Compliance** - Check code against style guides and standards
3. **Document Validation** - Verify documents meet structural requirements
4. **Protocol Compliance** - Check implementations against specifications

---

## Out of Scope (T9675)

`ct-validator` operates on the **`validation`** LOOM lifecycle stage (stage 7). It performs **static** schema, compliance, and audit checks against artifacts that already exist on disk (specs, ADRs, JSON files, RFC 2119 keyword usage, manifest schemas).

This skill does NOT:

- Run a test suite or an iterative IVT loop itself. The `testing` stage (stage 8) is also routed here since `ct-ivt-looper` was removed (T14311): dynamic verification is proven by the task's `testsPassed` evidence gate (`cleo done <id> --plan`, then `cleo verify`), and this skill audits that evidence rather than producing it.
- Modify code or apply fixes. The validator reports; downstream skills remediate.

Governance: see **ADR-051** (programmatic gate integrity), which defines the evidence atoms each stage emits and this skill re-validates, and **ADR-023** (protocol validation dispatch).

---

## Validation Methodology

### Standard Workflow

1. **Define scope** - What is being validated
2. **Identify criteria** - What rules apply
3. **Execute checks** - Run validation against criteria
4. **Document findings** - Record pass/fail with details
5. **Report status** - Summarize compliance level

---

## Blast-Radius Test Scope (MANDATORY · T9842)

When acting as the IVTR Lead in the **Validate** phase (R2), the targeted test
files named in the task spec are NOT sufficient evidence on their own when the
Implement phase touched an infrastructure file. Targeted-only test review is
how cross-package regressions slip past the Lead.

### Precedent — T9814 R2

T9814 swapped `BEGIN IMMEDIATE` for SAVEPOINTs in
`packages/core/src/store/sqlite-data-accessor.ts` to support nested
transactions for `add-batch`. Every targeted test passed (6/6 add-batch,
34/34 add, 9/9 allocate). IVTR Lead R2 approved on the targeted scope. CI
then surfaced `agent-resolver.test.ts preferTier` failing — the resolver
depended on the outer `BEGIN IMMEDIATE` semantics that SAVEPOINTs do not
replicate verbatim. Hotfix commit `baa996d2b` restored the outer-tx case.
The Lead's targeted-only review missed a regression CI caught seconds later.

### Rule

If ANY file in the impl-phase evidence bundle's `filesChanged` matches a
canonical infrastructure path, the Lead MUST run the full per-package vitest
suite for every touched package — NOT the targeted files alone.

### Canonical infrastructure paths

- `packages/core/src/store/**` — DB chokepoint, transactions, migrations
- `packages/core/src/orchestration/**` — spawn-prompt, dispatch resolution, IVTR
- `packages/core/src/dispatch/**` and `packages/cleo/src/dispatch/**` — typed dispatch
- `packages/contracts/src/**` — cross-package types (every consumer rebuilds)
- `packages/worktree/src/**` — worktree-create / git-shim integration
- `packages/core/src/migration/**` — schema bootstrapping
- any path whose basename contains `transaction`, `pragma`, or `migration`

### Required test commands per touched package

```bash
pnpm --filter @cleocode/<pkg> run test  # for each touched package
```

Attach the JSON output of each run as evidence
(`cleo docs add --labels test-output`) and reference the sha256 set in the
`--next` call. Approving on targeted-only results when infrastructure paths
are touched is grounds for loop-back with reason `infra-test-scope-violation`.

### Enforcement

No code enforces this rule: the IVTR loop that appended this block to a
Validate-phase prompt was removed (T14311), and its path matcher with it
(T14394). The reviewer applies the rule by comparing `filesChanged` against
the canonical paths above.

---

## Output Format

### Validation Report Structure

```markdown
# Validation Report: {{VALIDATION_TARGET}}

## Summary

- **Status**: PASS | PARTIAL | FAIL
- **Compliance**: {X}%
- **Critical Issues**: {N}

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
```

---

## Status Definitions

| Status | Meaning | Criteria |
|--------|---------|----------|
| **PASS** | Fully compliant | All checks pass, 0 critical issues |
| **PARTIAL** | Mostly compliant | >70% pass, no critical issues |
| **FAIL** | Non-compliant | <70% pass OR any critical issues |

---

## Task System Integration

@skills/_shared/task-system-integration.md

### Execution Sequence

1. Read task: `{{TASK_SHOW_CMD}} {{TASK_ID}}`
2. Start task: `{{TASK_START_CMD}} {{TASK_ID}}` (if not already started by orchestrator)
3. Execute validation checks
4. Record validation report with `cleo docs add {{TASK_ID}} --content - --type note --slug {{TOPIC_SLUG}}`
5. Record the manifest entry: `cleo manifest append --task {{TASK_ID}} --type validation --content "<one-paragraph summary>"`
6. Complete task: `{{TASK_COMPLETE_CMD}} {{TASK_ID}}`
7. Return summary message

---

## Subagent Protocol

@skills/_shared/subagent-protocol-base.md

### Output Requirements

1. MUST record validation report with `cleo docs add {{TASK_ID}} --content - --type note --slug {{TOPIC_SLUG}}` (never a raw file under `.cleo/agent-outputs/`)
2. MUST record ONE manifest entry: `cleo manifest append --entry '<entry JSON>'` (the flat manifest file is retired, ADR-027)
3. MUST return ONLY: "Validation complete. Manifest appended to pipeline_manifest."
4. MUST NOT return validation content in response

### Manifest Entry Format

```json
{"id":"{{TOPIC_SLUG}}-{{DATE}}","file":"{{DATE}}_{{TOPIC_SLUG}}.md","title":"{{VALIDATION_TARGET}} Validation","date":"{{DATE}}","status":"complete","agent_type":"validation","topics":["validation","compliance","{{TOPIC}}"],"key_findings":["Overall: {PASS|PARTIAL|FAIL} at {X}%","{N} critical issues found","{SUMMARY_OF_MAIN_FINDINGS}"],"actionable":{TRUE_IF_ISSUES},"needs_followup":["{REMEDIATION_TASK_IDS}"],"linked_tasks":["{{EPIC_ID}}","{{TASK_ID}}"]}
```

---

## Validation Types

### Schema Validation

```bash
# JSON Schema validation example
{{VALIDATION_COMMANDS}}
```

**Checks**:
- Required fields present
- Field types correct
- Enum values valid
- Constraints satisfied

### Code Compliance

**Checks**:
- Style guide conformance
- Naming conventions
- Documentation requirements
- Security patterns

### Document Validation

**Checks**:
- Required sections present
- Frontmatter complete
- Links valid
- Format consistent

### Protocol Compliance

**Checks**:
- RFC 2119 keywords used correctly
- Required behaviors implemented
- Constraints enforced
- Error handling present

---

## Completion Checklist

- [ ] Task started via `{{TASK_START_CMD}}` (if not already started)
- [ ] All validation checks executed
- [ ] Results documented with PASS/FAIL status
- [ ] Compliance percentage calculated
- [ ] Critical issues flagged
- [ ] Remediation steps provided (if FAIL/PARTIAL)
- [ ] Validation report written to output directory
- [ ] Manifest entry appended
- [ ] Task completed via `{{TASK_COMPLETE_CMD}}`
- [ ] Return summary message only

---

## Context Variables

When invoked by orchestrator, expect these context tokens:

| Token | Description | Example |
|-------|-------------|---------|
| `{{VALIDATION_TARGET}}` | What is being validated | `CLEO Schema v2.6.0` |
| `{{TARGET_FILES_OR_SYSTEMS}}` | Files/paths to check | `schemas/*.json` |
| `{{VALIDATION_CRITERIA}}` | Checklist of requirements | RFC 2119 compliance items |
| `{{VALIDATION_COMMANDS}}` | Specific commands to run | `ajv validate --spec=draft7` |
| `{{TOPIC_SLUG}}` | URL-safe topic name | `schema-validation` |

---

## Anti-Patterns

| Pattern | Problem | Solution |
|---------|---------|----------|
| Skipping failing checks | Incomplete report | Run all checks, report all failures |
| Vague findings | Unclear remediation | Specific issue + file/line + fix |
| Missing severity | Can't prioritize | Always classify: critical/warning/suggestion |
| No remediation | Findings not actionable | Always provide fix for FAIL/PARTIAL |

---

## See also / References

This skill binds to the **validation** LOOM lifecycle stage. Governing ADRs:

- [ADR-051 — programmatic gate integrity](../../../../docs/adr/adr-051-programmatic-gate-integrity.md) — defines the evidence-atom grammar that the validator emits and re-validates.
- [ADR-023 — protocol validation dispatch](../../../../docs/adr/adr-023-protocol-validation-dispatch.md) — defines the protocol-validation routing layer that dispatches to this skill.

LOOM coverage matrix: [docs/reference/loom-coverage-matrix.md](../../../../docs/reference/loom-coverage-matrix.md).

## See references/

Progressive disclosure — load on demand only:

- `references/validation-modes.md` — schema/code/document/protocol modes, selection rubric, composition
- `references/schema-checking.md` — engine selection, draft selection, pitfalls, bulk validation
- `references/compliance-reports.md` — canonical scaffold, status calculus, severity, release integration
- `references/anti-patterns.md` — twelve validation failure modes with detection and remediation
