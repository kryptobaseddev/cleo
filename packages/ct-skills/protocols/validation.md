# Validation Protocol

**Provenance**: @task T3155, @epic T3147
**Version**: 1.0.1
**Type**: Conditional Protocol
**Stage**: IVTR - V (Validation)
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Verification | "validate", "verify", "check", "audit" | Correctness checking |
| Quality | "quality", "qa", "review" | Quality assurance |
| Compliance | "compliance", "conform", "standard" | Standards adherence |
| Smoke Test | "smoke", "sanity", "basic test" | Initial verification |

**Explicit Override**: `--protocol validation` flag on task creation.

**Lifecycle Position**: After Implementation (I), before Testing (T)

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| VALID-001 | MUST verify implementation matches specification |
| VALID-002 | MUST run existing test suite and report results |
| VALID-003 | MUST check protocol compliance via `lib/protocol-validation.sh` |
| VALID-004 | MUST document pass/fail status for each validation check |
| VALID-005 | MUST write validation summary to manifest |
| VALID-006 | MUST set `agent_type: "validation"` in manifest |
| VALID-007 | MUST block progression if critical validations fail |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| VALID-010 | SHOULD verify edge cases identified in specification |
| VALID-011 | SHOULD check for regressions in related functionality |
| VALID-012 | SHOULD validate error handling paths |
| VALID-013 | SHOULD measure against acceptance criteria |

### MAY

| Requirement | Description |
|-------------|-------------|
| VALID-020 | MAY perform performance validation |
| VALID-021 | MAY verify security constraints |
| VALID-022 | MAY suggest additional test cases |

---

## Validation Checklist

### Code Validation

```bash
# 1. Syntax check
bash -n scripts/*.sh lib/*.sh

# 2. Protocol compliance
source lib/protocol-validation.sh
validate_implementation_protocol "$TASK_ID"

# 3. Run existing tests
bats tests/unit/*.bats
bats tests/integration/*.bats
```

### Specification Compliance

| Check | Command | Pass Criteria |
|-------|---------|---------------|
| Spec exists | `ls docs/specs/*.md` | File present |
| RFC 2119 keywords | `grep -E "MUST|SHOULD|MAY"` | Keywords present |
| Implementation matches | Manual review | All MUST satisfied |

### Exit Code Validation

| Exit Code | Meaning | Action |
|-----------|---------|--------|
| 0 | All validations pass | Proceed to Testing |
| 62 | Specification mismatch | Fix implementation |
| 64 | Implementation protocol violation | Fix provenance |
| 67 | Generic protocol violation | Review and fix |

---

## Output Format

### Validation Report

```markdown
# Validation Report: T####

**Date**: YYYY-MM-DD
**Validator**: agent-id
**Task**: T####
**Epic**: T####

## Summary

- **Status**: PASS | FAIL | PARTIAL
- **Checks Passed**: X/Y
- **Critical Issues**: N

## Detailed Results

| Check | Result | Notes |
|-------|--------|-------|
| Syntax | PASS | No errors |
| Tests | PASS | 48/48 pass |
| Protocol | PASS | Compliance 95% |

## Issues Found

1. [Issue description]
2. [Issue description]

## Recommendations

1. [Action item]
```

### Manifest Entry

@skills/_shared/manifest-operations.md

Use `cleo research add` to create the manifest entry:

```bash
cleo research add \
  --title "Validation: [Feature Name]" \
  --file "T####-validation-report.md" \
  --topics "validation,qa" \
  --findings "RESULT: X/Y checks passed,ISSUES: N found,STATUS: PASS|FAIL" \
  --status complete \
  --task T#### \
  --actionable \
  --agent-type validation
```

---

## Integration Points

### With Implementation Protocol

```
Implementation (I) ──► Validation (V)
                           │
                           ├── Run tests
                           ├── Check compliance
                           └── Verify spec match
```

### With Testing Protocol

```
Validation (V) ──► Testing (T)
       │                │
       │                ├── Write new tests
       │                └── Full coverage
       │
       └── Identifies gaps for Testing to fill
```

### With lib/protocol-validation.sh

The validation protocol uses these functions:

| Function | Purpose | Exit Code |
|----------|---------|-----------|
| `validate_implementation_protocol()` | Check IMPL-* compliance | 64 |
| `validate_specification_protocol()` | Check SPEC-* compliance | 62 |
| `validate_protocol()` | Generic protocol check | 67 |

---

## Enforcement

### Via lib/protocol-validation.sh

```bash
source lib/protocol-validation.sh

# Validate a specific protocol
validate_implementation_protocol "$TASK_ID" "$MANIFEST_ENTRY" "true"

# Generic validation
validate_protocol "implementation" "$TASK_ID" "$DATA"
```

### Exit Codes

| Code | Constant | Description |
|------|----------|-------------|
| 62 | EXIT_PROTOCOL_SPECIFICATION | Spec validation failed |
| 64 | EXIT_PROTOCOL_IMPLEMENTATION | Implementation validation failed |
| 67 | EXIT_PROTOCOL_GENERIC | Generic validation failed |
| 68 | EXIT_VALIDATION_INCOMPLETE | Validation not finished |

---

## Cross-Cutting: Contribution Protocol

When validation involves multi-agent work:

1. **Record validator identity** in manifest
2. **Attribute findings** to validating agent
3. **Track validation consensus** if multiple validators

See: `protocols/contribution.md` for attribution requirements.

---

## References

- **Specification**: `docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md`
- **Implementation**: `lib/protocol-validation.sh`
- **Tests**: `tests/unit/protocol-validation.bats`
