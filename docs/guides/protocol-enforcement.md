# Protocol Enforcement Guide

**Version**: 1.0.0 | **Epic**: T2679 | **Status**: ACTIVE

## Overview

CLEO implements **protocol enforcement** to ensure all agent-generated outputs conform to the RCSD-IVTR lifecycle protocols. This guide explains how protocol validation works, how to interpret violations, and how to resolve them.

---

## Quick Reference

### Exit Codes

| Code | Protocol | Description |
|------|----------|-------------|
| 60 | Research | Research protocol violation |
| 61 | Consensus | Consensus protocol violation |
| 62 | Specification | Specification protocol violation |
| 63 | Decomposition | Decomposition protocol violation |
| 64 | Implementation | Implementation protocol violation |
| 65 | Contribution | Contribution protocol violation |
| 66 | Release | Release protocol violation |
| 67 | Generic | Unknown protocol or generic violation |

### Common Commands

```bash
# Validate a manifest entry (research)
cleo research validate T1234

# Validate specification protocol
cleo spec validate T1234 --file docs/specs/FEATURE.md

# Validate implementation with function tags
cleo implementation validate T1234

# Validate release protocol
cleo release validate --version 1.2.3
```

---

## Protocol Validation

### How It Works

When you complete a task using a protocol-specific workflow:

1. Agent writes output file
2. Agent appends entry to `MANIFEST.jsonl`
3. **Validation runs** against protocol requirements
4. If violations detected → exit code 60-67
5. Violations logged with severity and fix suggestions

### Validation Modes

| Mode | Strictness | Use Case |
|------|-----------|----------|
| **Default** | Errors only | Normal operations |
| **Strict** | Errors + warnings | Pre-release validation |
| **CI/CD** | Strict + blocking | Automated pipelines |

Enable strict mode:
```bash
cleo research validate T1234 --strict
```

---

## Protocol Requirements

### 1. Research Protocol (RSCH)

**Required manifest fields:**
- `agent_type: "research"`
- `key_findings: [...]` (3-7 items)
- `topics: [...]` (1+ items)
- `sources: [...]` (strict mode only)

**Constraints:**
- **RSCH-001**: MUST NOT modify code files
- **RSCH-002**: SHOULD include sources (warning in strict)
- **RSCH-006**: MUST have 3-7 key_findings
- **RSCH-007**: MUST set agent_type to "research"

**Example violation:**
```json
{
  "valid": false,
  "violations": [
    {
      "requirement": "RSCH-006",
      "severity": "error",
      "message": "key_findings must contain 3-7 items (found: 2)"
    }
  ],
  "score": 33
}
```

**Fix:**
```bash
# Add more key findings to manifest entry
jq '.key_findings += ["Additional insight from research"]' MANIFEST.jsonl
```

---

### 2. Consensus Protocol (CONS)

**Required manifest fields:**
- `agent_type: "consensus"`
- `voting_matrix: {...}` with options, votes, confidence scores

**Constraints:**
- **CONS-001**: MUST have 2+ options
- **CONS-003**: Confidence scores must be 0-100
- **CONS-004**: MUST meet 60% confidence threshold
- **CONS-007**: MUST set agent_type to "consensus"

**Example voting matrix:**
```json
{
  "options": ["approach-a", "approach-b"],
  "votes": {
    "approach-a": {"confidence": 75, "agents": ["agent-1", "agent-2"]},
    "approach-b": {"confidence": 45, "agents": ["agent-3"]}
  },
  "winner": "approach-a",
  "threshold_met": true
}
```

---

### 3. Specification Protocol (SPEC)

**Required manifest fields:**
- `agent_type: "specification"`
- `version: "x.y.z"`
- `rfc2119_keywords: true` (file must contain MUST/SHOULD/MAY)

**Constraints:**
- **SPEC-001**: MUST use RFC 2119 keywords
- **SPEC-002**: MUST include version field
- **SPEC-003**: SHOULD include authority section (strict)
- **SPEC-007**: MUST set agent_type to "specification"

**RFC 2119 keywords:**
- MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT
- SHOULD, SHOULD NOT, RECOMMENDED
- MAY, OPTIONAL

---

### 4. Decomposition Protocol (DCMP)

**Required data:**
- Parent epic ID
- Child task IDs array
- Task hierarchy validation

**Constraints:**
- **DCMP-004**: Child descriptions SHOULD be clear (strict)
- **DCMP-006**: MUST NOT exceed 7 siblings per parent
- **DCMP-007**: MUST set agent_type to "decomposition"

---

### 5. Implementation Protocol (IMPL)

**Required manifest fields:**
- `agent_type: "implementation"`
- `functions_added: [...]` with @task tags

**Constraints:**
- **IMPL-003**: New functions MUST have @task tags
- **IMPL-007**: MUST set agent_type to "implementation"

**Example @task tag:**
```bash
# Validate user input
# @task T1234
# @layer validation
# @returns 0 if valid, 1 if invalid
validate_input() {
    local input="$1"
    # ... validation logic
}
```

---

### 6. Contribution Protocol (CONT)

**Required manifest fields:**
- `agent_type: "contribution"`
- `functions_tagged: [...]` with @task and @contribution tags

**Constraints:**
- **CONT-002**: Functions MUST have @task tags
- **CONT-007**: MUST set agent_type to "contribution"

**Example contribution tag:**
```bash
# Enhanced validation with caching
# @task T2345
# @contribution agent-7
# @layer validation
validate_with_cache() {
    # ... implementation
}
```

---

### 7. Release Protocol (RLSE)

**Required data:**
- Version string (semver)
- Changelog entry

**Constraints:**
- **RLSE-001**: Version MUST be valid semver (x.y.z)
- **RLSE-002**: MUST include changelog entry
- **RLSE-007**: MUST set agent_type to "release"

---

## Commit Task Enforcement

### Commit Message Format

All commits MUST reference a task ID:

```bash
git commit -m "feat(protocol): Add validation functions (T2692)"
                                                        ↑ Required
```

### Commit Hook

Install the commit-msg hook:

```bash
# For this repository
cp .cleo/templates/git-hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg

# For other repositories
cleo init --install-hooks
```

### Auto-Bypass Conditions

The hook automatically bypasses for:

- **Merge commits**: `Merge branch 'feature'`
- **Revert commits**: `Revert "previous commit"`
- **CI/CD environments**: When `$CI` or `$GITHUB_ACTIONS` set

### Manual Bypass

If you need to bypass (use sparingly):

```bash
git commit --no-verify -m "emergency hotfix"
```

**Bypasses are logged** to `.cleo/bypass-log.json`:
```json
{
  "timestamp": "2026-01-28T09:30:00Z",
  "commit": "abc123",
  "user": "developer",
  "justification": "manual",
  "note": "Emergency fix",
  "message": "emergency hotfix"
}
```

---

## Troubleshooting

### Error: Exit code 60-67

**Diagnosis:**
```bash
# Check validation output
cleo research validate T1234 --verbose

# Review violation details
jq '.violations' < /tmp/validation-result.json
```

**Resolution:**
1. Read violation messages
2. Update manifest entry or output file
3. Re-run validation
4. Ensure score ≥ 60%

---

### Error: Missing @task tags

**Symptom:**
```
IMPL-003 violation: New functions must have @task tags
Found 3 new functions without tags
```

**Fix:**
```bash
# Add @task tag to each new function
# Before:
my_function() {
    # logic
}

# After:
# @task T1234
my_function() {
    # logic
}
```

---

### Error: Insufficient key_findings

**Symptom:**
```
RSCH-006 violation: key_findings must contain 3-7 items (found: 2)
```

**Fix:**
```bash
# Edit MANIFEST.jsonl and add findings
jq '.key_findings += ["Additional research finding"]' MANIFEST.jsonl
```

---

### Error: Invalid semver format

**Symptom:**
```
RLSE-001 violation: Version must be valid semver (found: "v1.2")
```

**Fix:**
```bash
# Use proper semver format
cleo release --version 1.2.0  # Not "v1.2" or "1.2"
```

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Protocol Validation

on: [push, pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Install CLEO
        run: ./install.sh

      - name: Validate protocols (strict mode)
        run: |
          for task in $(jq -r '.id' claudedocs/agent-outputs/MANIFEST.jsonl); do
            cleo validate-protocol "$task" --strict || exit 1
          done
```

---

## Metrics and Scoring

### Enforcement Score

Enforcement score = `(passed_requirements / total_requirements) * 100`

**Thresholds:**
- **≥90%**: Excellent enforcement
- **60-89%**: Acceptable enforcement
- **<60%**: Failed enforcement (blocks completion)

### Viewing Metrics

```bash
# Show protocol compliance for epic
cleo epic show T2679 --metrics

# Generate enforcement report
cleo stats --protocols --format json > protocol-report.json
```

---

## Best Practices

### 1. Validate Early

Run validation during development, not just at completion:

```bash
# After creating manifest entry
cleo research validate T1234

# Before completing task
cleo validate T1234 --strict
```

---

### 2. Use Templates

Use protocol templates to ensure compliance:

```bash
# Generate research template
cleo research start T1234 --template

# Generates: claudedocs/agent-outputs/T1234-research.md
# With proper frontmatter and structure
```

---

### 3. Review Bypass Logs

Periodically review bypass logs:

```bash
# Show recent bypasses
jq '.[] | select(.timestamp > "2026-01-28")' .cleo/bypass-log.json

# Count bypasses by justification
jq 'group_by(.justification) | map({justification: .[0].justification, count: length})' .cleo/bypass-log.json
```

---

## Reference

### Specifications

- **Protocol Enforcement Spec**: `docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md`
- **Commit Task Enforcement**: `docs/specs/COMMIT-TASK-ENFORCEMENT-SPEC.md`
- **Protocol Corrections**: `docs/specs/PROTOCOL-MISALIGNMENT-CORRECTIONS.md`

### Library Functions

- **Validation Library**: `lib/protocol-validation.sh`
- **Exit Codes**: `lib/exit-codes.sh`

### Tests

- **Protocol Validation Tests**: `tests/unit/protocol-validation.bats`
- **Commit Hook Tests**: `tests/integration/commit-hook.bats`

---

## Support

For protocol enforcement issues:

1. Check this guide
2. Review specification docs
3. Run `cleo doctor --protocols`
4. Check bypass logs
5. Review test examples in `tests/` directory

**Epic**: T2679 | **Version**: 1.0.0 | **Last Updated**: 2026-01-28
