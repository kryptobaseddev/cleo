# Protocol Enforcement Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Created**: 2026-01-28
**Updated**: 2026-01-28
**Author**: Protocol Specification Agent (T2688)

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Part 1: Preamble

### 1.1 Purpose

This specification defines the **dual-layer enforcement architecture** for CLEO protocols: pre-commit hooks (fast feedback) and runtime validation (comprehensive coverage). It addresses the protocol compliance gap identified in Wave 0 research (22% average enforcement across 7 protocols, 100 total requirements).

### 1.2 Authority

This specification is **AUTHORITATIVE** for:

- Enforcement architecture (ENFC-001 to ENFC-010)
- Validation function signatures (VFUNC-*)
- Protocol violation exit codes (60-67)
- Bypass policies and audit trails (BYPS-*)
- Testing requirements for enforcement (TEST-*)

This specification **DEFERS TO**:

- Individual protocol files (`protocols/*.md`) for specific requirement definitions
- [COMMIT-TASK-ENFORCEMENT-SPEC.md](COMMIT-TASK-ENFORCEMENT-SPEC.md) for commit-msg hook implementation
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) for RCSD pipeline integration

### 1.3 Scope

This specification governs:

1. **Enforcement layers** - Pre-commit hooks and runtime validation coordination
2. **Validation functions** - Signature contracts for protocol checking
3. **Error codes** - Exit code ranges 60-67 for protocol violations
4. **Bypass mechanisms** - When and how to override enforcement
5. **Testing strategy** - Validation of enforcement logic itself

### 1.4 Evidence Base

This specification incorporates findings from:

- **T2680-T2684**: Wave 0 research audits (7 protocols, 100 requirements)
- **T2685**: Consensus decision (Option C: both hooks + runtime, confidence 0.92)
- **T2686**: Commit enforcement consensus (commit-msg hook with session scope, confidence 0.88)
- **T2687**: Priority consensus (4-tier system, 3250 lines orphaned code)

**Key Evidence**:
- Release protocol (86% enforced) success via single automated entry point
- Consensus/contribution (0-14% enforced) failure due to orphaned implementations
- Provenance tagging (0% enforced) defined in 2 protocols, validated in 0

---

## Part 2: Enforcement Architecture (ENFC-*)

### 2.1 Dual-Layer Design

| ID | Requirement | Rationale |
|----|-------------|-----------|
| ENFC-001 | Protocol enforcement MUST use both pre-commit hooks AND runtime validation | Layered defense: hooks for fast feedback, runtime for comprehensive coverage |
| ENFC-002 | Enforcement layers MUST share validation logic via `lib/protocol-validation.sh` | Single source of truth; prevents duplication and drift |
| ENFC-003 | Pre-commit hooks MUST be bypassable via `--no-verify` flag | Emergency escape hatch; documented bypass policy required |
| ENFC-004 | Runtime validation MUST be non-bypassable for critical requirements | Safety net; catches bypassed hook violations |
| ENFC-005 | Each protocol MUST define validation functions in `lib/protocol-validation.sh` | Centralized validation; discoverable and testable |
| ENFC-006 | Validation functions MUST return structured JSON with violations array | Parseable; supports automation and reporting |
| ENFC-007 | Protocol violations MUST use exit codes 60-67 (protocol-specific failures) | Distinguishable from system errors (1-22); retryable status |
| ENFC-008 | Enforcement SHOULD be phased: runtime first, then hooks incrementally | Risk reduction; proven by release.md success pattern |
| ENFC-009 | CLI entry points MUST exist for protocols requiring manual invocation | Addresses orphaned implementation gap (consensus, contribution) |
| ENFC-010 | Orchestrators MUST validate protocol compliance before marking tasks complete | Automated enforcement; no manual compliance checking |

### 2.2 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         ENFORCEMENT LAYERS                        │
└─────────────────────────────────────────────────────────────────┘
                                │
         ┌──────────────────────┴──────────────────────┐
         │                                             │
         ▼                                             ▼
┌─────────────────────┐                     ┌─────────────────────┐
│   PRE-COMMIT HOOKS  │                     │  RUNTIME VALIDATION │
│   (Fast Feedback)   │                     │  (Comprehensive)    │
├─────────────────────┤                     ├─────────────────────┤
│ • commit-msg        │                     │ • cleo complete     │
│ • pre-commit        │                     │ • scripts/*.sh CLI  │
│ • Bypassable        │                     │ • Non-bypassable    │
│ • Developer UX      │                     │ • Orchestrator      │
└──────────┬──────────┘                     └──────────┬──────────┘
           │                                           │
           └──────────────┬────────────────────────────┘
                          │
                          ▼
           ┌───────────────────────────────┐
           │   lib/protocol-validation.sh  │
           │   (Shared Validation Logic)   │
           ├───────────────────────────────┤
           │ • validate_protocol()         │
           │ • validate_research()         │
           │ • validate_consensus()        │
           │ • validate_specification()    │
           │ • validate_implementation()   │
           │ • validate_contribution()     │
           │ • validate_decomposition()    │
           │ • validate_release()          │
           └───────────────────────────────┘
```

### 2.3 Enforcement Timeline

**Phase 1: Runtime Validation (Immediate - Wave 3)**
- Add `lib/protocol-validation.sh` with 7 protocol validators
- Create CLI entry points: `scripts/consensus.sh`, `scripts/contribution.sh`
- Integrate with `cleo complete` workflow
- Expected outcome: 22% → 40% enforcement rate

**Phase 2: Pre-commit Hooks (Follow-up Epic)**
- Add commit-msg hook for task ID enforcement
- Add pre-commit hook for provenance tag validation
- Add pre-commit hook for test execution
- Expected outcome: 40% → 55% enforcement rate

**Phase 3: Integration (Long-term)**
- Hooks call same validation functions as runtime
- Configuration-driven enforcement levels
- Metrics dashboard: `cleo compliance report`
- Expected outcome: 55% → 70% enforcement rate

---

## Part 3: Validation Function Signatures (VFUNC-*)

### 3.1 Core Validation Contract

| ID | Requirement | Example |
|----|-------------|---------|
| VFUNC-001 | Validation functions MUST accept `(task_id, manifest_entry)` parameters | `validate_research(T2680, {...})` |
| VFUNC-002 | Validation functions MUST return JSON with `{valid, violations, score}` structure | `{"valid": false, "violations": [...], "score": 60}` |
| VFUNC-003 | Violation objects MUST include `{requirement, severity, message, fix}` fields | `{"requirement": "RSCH-001", "severity": "error", ...}` |
| VFUNC-004 | Validation functions MUST exit with code 0 (valid) or 60-67 (protocol-specific violation) | Exit 60 for research violations, 61 for consensus, etc. |
| VFUNC-005 | Validation functions SHOULD compute compliance score (0-100) | Enables gradual improvement tracking |
| VFUNC-006 | Validation functions MAY accept `--strict` flag for blocking vs warning mode | Development vs production enforcement |

### 3.2 Function Template

```bash
#!/usr/bin/env bash
# lib/protocol-validation.sh

validate_research() {
    local task_id="$1"
    local manifest_entry="$2"
    local strict="${3:-false}"

    local violations=()
    local score=100

    # RSCH-001: MUST NOT implement code
    if has_code_changes "$task_id"; then
        violations+=('{"requirement":"RSCH-001","severity":"error","message":"Research task modified code","fix":"Revert code changes, research is read-only"}')
        score=$((score - 30))
    fi

    # RSCH-006: MUST include 3-7 key findings
    local findings_count
    findings_count=$(echo "$manifest_entry" | jq '.key_findings | length')
    if [[ $findings_count -lt 3 || $findings_count -gt 7 ]]; then
        violations+=('{"requirement":"RSCH-006","severity":"error","message":"Key findings must be 3-7, got '$findings_count'","fix":"Add/remove findings in manifest entry"}')
        score=$((score - 20))
    fi

    # RSCH-007: MUST set agent_type: research
    local agent_type
    agent_type=$(echo "$manifest_entry" | jq -r '.agent_type')
    if [[ "$agent_type" != "research" ]]; then
        violations+=('{"requirement":"RSCH-007","severity":"error","message":"agent_type must be research, got '$agent_type'","fix":"Update manifest entry agent_type field"}')
        score=$((score - 15))
    fi

    # Build result JSON
    local valid="true"
    if [[ ${#violations[@]} -gt 0 ]]; then
        valid="false"
    fi

    local violations_json
    violations_json=$(printf '%s\n' "${violations[@]}" | jq -s '.')

    local result
    result=$(jq -n \
        --argjson valid "$valid" \
        --argjson violations "$violations_json" \
        --argjson score "$score" \
        '{valid: $valid, violations: $violations, score: $score}')

    echo "$result"

    # Exit code
    if [[ "$valid" == "false" && "$strict" == "true" ]]; then
        return 60  # Research protocol violation
    fi

    return 0
}
```

### 3.3 Protocol-Specific Exit Codes

| Exit Code | Protocol | Description | Retryable |
|-----------|----------|-------------|-----------|
| 60 | research.md | Research protocol violation (e.g., code changes, missing findings) | No |
| 61 | consensus.md | Consensus protocol violation (e.g., threshold not met, invalid voting) | Yes (after fixes) |
| 62 | specification.md | Specification protocol violation (e.g., missing RFC 2119, no version) | No |
| 63 | decomposition.md | Decomposition protocol violation (e.g., non-atomic tasks, MECE failure) | No |
| 64 | implementation.md | Implementation protocol violation (e.g., missing provenance, no tests) | No |
| 65 | contribution.md | Contribution protocol violation (e.g., missing provenance, no manifest) | No |
| 66 | release.md | Release protocol violation (e.g., version mismatch, missing changelog) | Yes (after fixes) |
| 67 | (reserved) | Future protocol additions | TBD |

**Rationale**: Exit codes 60-67 distinct from:
- 1-22: System/operational errors (file not found, validation failed, permission denied)
- 100+: Special status codes (session discovery, focus required, etc.)

---

## Part 4: Protocol Validation Requirements

### 4.1 Research Protocol Validation

**Function**: `validate_research(task_id, manifest_entry)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| RSCH-001 | No code changes detected (git diff empty) | error | 60 |
| RSCH-002 | Sources documented in manifest or markdown | warning | 60 (strict) |
| RSCH-003 | Output file exists in `claudedocs/agent-outputs/` | error | 60 |
| RSCH-004 | Manifest entry exists in `MANIFEST.jsonl` | error | 60 |
| RSCH-006 | Key findings count between 3-7 | error | 60 |
| RSCH-007 | `agent_type: "research"` in manifest | error | 60 |

**Implementation**: Pre-spawn tool allowlist (Read/Grep only) + post-completion git diff check

### 4.2 Consensus Protocol Validation

**Function**: `validate_consensus(task_id, manifest_entry, voting_matrix)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| CONS-001 | Voting matrix with ≥2 options | error | 61 |
| CONS-002 | Weighted scoring formula applied | error | 61 |
| CONS-003 | Confidence scores (0.0-1.0) for each option | error | 61 |
| CONS-004 | Threshold met (50% by default, configurable) | error | 61 |
| CONS-005 | Conflict detection (tie-breaking documented) | warning | 61 (strict) |
| CONS-007 | `agent_type: "analysis"` in manifest | error | 61 |

**Implementation**: CLI command `scripts/consensus.sh compute` with orchestrator integration

### 4.3 Specification Protocol Validation

**Function**: `validate_specification(task_id, manifest_entry, spec_file)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| SPEC-001 | RFC 2119 keywords present (MUST/SHOULD/MAY) | error | 62 |
| SPEC-002 | Version field in frontmatter | error | 62 |
| SPEC-003 | Authority section defining scope | warning | 62 (strict) |
| SPEC-005 | Related specifications section | warning | 62 (strict) |
| SPEC-007 | `agent_type: "specification"` in manifest | error | 62 |

**Implementation**: Markdown linter `scripts/validate-spec.sh` (pre-commit hook candidate)

### 4.4 Decomposition Protocol Validation

**Function**: `validate_decomposition(task_id, epic_id, child_tasks)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| DCMP-001 | MECE check (mutually exclusive, collectively exhaustive) | warning | 63 (strict) |
| DCMP-002 | Dependency graph valid (no cycles) | error | 63 |
| DCMP-003 | Max depth 3 enforced (epic→task→subtask) | error | 63 |
| DCMP-004 | Atomicity test (6 criteria: single file, <300 lines, clear acceptance criteria, etc.) | warning | 63 (strict) |
| DCMP-006 | Max 7 siblings per parent | error | 63 |
| DCMP-007 | `agent_type: "specification"` in manifest | error | 63 |

**Implementation**: `lib/hierarchy.sh` already enforces DCMP-003, DCMP-006 (36% baseline enforcement)

### 4.5 Implementation Protocol Validation

**Function**: `validate_implementation(task_id, manifest_entry)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| IMPL-003 | Provenance tags `@task T####` present in new code | error | 64 |
| IMPL-004 | Tests pass (critical subset for hooks, full suite for runtime) | error | 64 |
| IMPL-006 | Style validation passes (shellcheck for bash, etc.) | warning | 64 (strict) |
| IMPL-007 | `agent_type: "implementation"` in manifest | error | 64 |

**Implementation**: Pre-commit hook + `cleo complete` validation

### 4.6 Contribution Protocol Validation

**Function**: `validate_contribution(task_id, manifest_entry)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| CONT-002 | Provenance tags in contributed code | error | 65 |
| CONT-003 | Tests pass before PR submission | error | 65 |
| CONT-007 | `agent_type: "implementation"` in manifest | error | 65 |

**Implementation**: CLI command `scripts/contribution.sh validate` + git hook integration

### 4.7 Release Protocol Validation

**Function**: `validate_release(version, changelog_entry)`

| Requirement | Check | Severity | Exit Code |
|-------------|-------|----------|-----------|
| RLSE-001 | Version follows semver (major.minor.patch) | error | 66 |
| RLSE-002 | Changelog entry exists for version | error | 66 |
| RLSE-003 | All tests pass before release | error | 66 |
| RLSE-004 | Git tag matches version | error | 66 |
| RLSE-007 | `agent_type: "implementation"` in manifest | error | 66 |

**Implementation**: `scripts/release.sh` (86% enforcement - success model)

---

## Part 5: Bypass Policy (BYPS-*)

### 5.1 Bypass Mechanisms

| ID | Requirement | Use Case |
|----|-------------|----------|
| BYPS-001 | Pre-commit hooks MUST be bypassable via `--no-verify` flag | Emergency hotfixes, WIP commits, cross-repo work |
| BYPS-002 | Runtime validation MUST NOT be bypassable for MUST requirements | Safety net for critical requirements |
| BYPS-003 | Bypass usage MUST be logged to `.cleo/bypass-log.json` | Audit trail for compliance review |
| BYPS-004 | Bypass log entries MUST include timestamp, commit hash, user, justification | Traceable for post-hoc analysis |
| BYPS-005 | SHOULD requirements MAY be bypassable in both hooks and runtime (warning mode) | Gradual improvement without blocking work |
| BYPS-006 | Bypass justification codes MUST be from enum: `emergency`, `wip`, `cross-repo`, `automation`, `other` | Categorizable for pattern analysis |

### 5.2 Bypass Log Format

```json
{
  "timestamp": "2026-01-28T08:45:00Z",
  "commit": "abc123def456",
  "operation": "commit",
  "hook": "commit-msg",
  "user": "keaton",
  "session": "session_20260128_084500_abc123",
  "justification": "emergency",
  "justificationNote": "Production crash requires immediate fix outside normal workflow",
  "violations": [
    {"requirement": "IMPL-003", "severity": "error", "message": "Missing @task tag"}
  ]
}
```

### 5.3 Permitted Bypass Scenarios

**ALLOWED**:
- Emergency hotfixes (production issues)
- WIP commits (work-in-progress, will be squashed)
- Merge commits (automated via GitHub/GitLab)
- Revert commits (emergency rollbacks)
- Cross-repository work (changes spanning multiple repos)

**PROHIBITED**:
- Normal feature development
- Bug fixes (should be tracked via tasks)
- Refactoring work
- Test additions

### 5.4 Bypass Audit

**Command**: `cleo audit bypass [--since YYYY-MM-DD]`

**Report Format**:
```
Bypass Audit Report
===================
Period: 2026-01-01 to 2026-01-28

Total bypasses: 12
  Emergency:    3 (25%)
  WIP:          7 (58%)
  Cross-repo:   2 (17%)

Top violations bypassed:
  IMPL-003 (provenance tags): 8 occurrences
  IMPL-004 (tests):           3 occurrences
  CONT-002 (provenance):      1 occurrence

Recommended actions:
  - Review WIP commits for squash/fixup
  - Retroactively add provenance tags to IMPL-003 violations
  - Create task linkage for bypassed work
```

---

## Part 6: Testing Requirements (TEST-*)

### 6.1 Enforcement Testing

| ID | Requirement | Rationale |
|----|-------------|-----------|
| TEST-001 | Each validation function MUST have unit tests with positive/negative cases | Validates validators; prevents enforcement bugs |
| TEST-002 | Unit tests MUST cover all MUST requirements per protocol | Complete coverage; no gaps |
| TEST-003 | Integration tests MUST validate hook + runtime coordination | End-to-end verification |
| TEST-004 | Tests MUST verify exit codes match specification (60-67 range) | Correct error signaling |
| TEST-005 | Tests MUST verify bypass policy works correctly | Escape hatch functional |
| TEST-006 | Test fixtures MUST include valid and invalid manifest entries | Realistic test data |
| TEST-007 | SHOULD use BATS for shell script validation function tests | Consistency with existing test suite |

### 6.2 Test Structure

```bash
tests/
├── unit/
│   ├── protocol-validation-research.bats
│   ├── protocol-validation-consensus.bats
│   ├── protocol-validation-specification.bats
│   ├── protocol-validation-decomposition.bats
│   ├── protocol-validation-implementation.bats
│   ├── protocol-validation-contribution.bats
│   └── protocol-validation-release.bats
├── integration/
│   ├── enforcement-hooks.bats
│   ├── enforcement-runtime.bats
│   └── enforcement-bypass.bats
└── fixtures/
    ├── valid-research-manifest.json
    ├── invalid-research-manifest.json
    ├── valid-consensus-matrix.json
    └── ...
```

### 6.3 Test Coverage Targets

| Protocol | MUST Requirements | Target Coverage | Priority |
|----------|-------------------|----------------|----------|
| research.md | 7 | 100% | High |
| consensus.md | 7 | 100% | Critical |
| specification.md | 7 | 100% | High |
| decomposition.md | 7 | 100% | High |
| implementation.md | 7 | 100% | Critical |
| contribution.md | 7 | 100% | Critical |
| release.md | 7 | 100% | High |

**Rationale**: 100% coverage of MUST requirements ensures no enforcement gaps. SHOULD/MAY requirements tested at lower priority.

---

## Part 7: Implementation Roadmap

### 7.1 Wave 3 Tasks (Immediate)

**T2692**: Connect consensus CLI (`scripts/consensus.sh`)
- Create CLI entry point for orphaned `lib/contribution-protocol.sh` functions
- Add orchestrator integration hooks
- Expected: 0% → 70% enforcement for consensus.md

**T2693**: Connect contribution CLI (`scripts/contribution.sh`)
- Create CLI entry point for contribution protocol
- Integrate with `cleo complete` workflow
- Expected: 14% → 60% enforcement for contribution.md

**T2694**: Fix consensus threshold mismatch
- Decide: 50% (practical) or 80% (stringent)
- Update protocol OR code to match
- Document rationale

**T2695**: Add `lib/protocol-validation.sh` foundation
- Create shared validation library
- Implement 7 protocol validation functions
- Add exit code handling (60-67)

**T2696**: Add provenance tag validator
- Pre-commit hook: validate `@task T####` in new code
- Runtime validator: check existing codebase coverage
- Exit code 64 for violations

**T2697**: Add agent_type enum to manifest schema
- Update `schemas/manifest.schema.json`
- Add enum constraint: `["research", "analysis", "specification", "implementation", "documentation"]`
- Validate at manifest append time

### 7.2 Success Metrics

**Baseline (Wave 0)**:
- Average enforcement: 22%
- Orphaned code: 3250 lines
- Protocol violations: undetected

**Target (Post-Wave 3)**:
- Average enforcement: 40%
- Orphaned code: 0 lines (CLI wired)
- Protocol violations: exit codes 60-67

**Target (Post-Wave 4)**:
- Average enforcement: 55%
- Pre-commit hooks: active for provenance, tests
- Bypass audit: operational

**Target (Long-term)**:
- Average enforcement: 70%
- Full hook + runtime integration
- Metrics dashboard operational

---

## Part 8: Open Questions

1. Should consensus threshold be **50% (practical)** or **80% (stringent)**?
   - **Context**: Protocol specifies 80%, code uses 50%
   - **Impact**: Decision validation strictness
   - **Recommendation**: Start with 50%, adjust based on false positives

2. Should provenance validation be **blocking** (fail commit) or **warning** (log violation)?
   - **Context**: Zero current enforcement, may have gaps in existing code
   - **Impact**: Developer friction vs data quality
   - **Recommendation**: Warning mode initially, blocking after backfill

3. Should atomicity validation be **pre-add** (block creation) or **post-add** (warn on completion)?
   - **Context**: Atomicity subjective (6-point test)
   - **Impact**: Task creation UX vs quality
   - **Recommendation**: Post-add warning, escalate to blocking after tuning

4. Should agent_type enum be **exhaustive** (fixed list) or **extensible** (allow new types)?
   - **Context**: Current types: research, analysis, specification, implementation, documentation
   - **Impact**: Schema evolution vs validation strictness
   - **Recommendation**: Exhaustive initially, add extension mechanism later

5. Should spec validator be **pre-commit hook** (blocking) or **CI check** (non-blocking)?
   - **Context**: Specification quality currently convention-based (57%)
   - **Impact**: Developer workflow vs gradual improvement
   - **Recommendation**: CI check initially, promote to hook after adoption

---

## Part 9: References

### 9.1 Research Foundation (Wave 0)

- **T2680**: Research Protocol Audit (19% enforced, manifest validation only)
- **T2681**: Consensus Protocol Audit (0% enforced, 1850 lines orphaned)
- **T2682**: Specification Protocol Audit (14% enforced, convention-based)
- **T2683**: Decomposition Protocol Audit (36% enforced, best baseline)
- **T2684**: Execution Protocols Audit (release 86%, implementation 29%, contribution 14%)

### 9.2 Consensus Decisions (Wave 1)

- **T2685**: Enforcement Strategy (Option C: both hooks + runtime, confidence 0.92)
- **T2686**: Commit Enforcement (commit-msg hook with session scope, confidence 0.88)
- **T2687**: Priority Classification (4-tier system, orphaned code critical)

### 9.3 Related Specifications

- [COMMIT-TASK-ENFORCEMENT-SPEC.md](COMMIT-TASK-ENFORCEMENT-SPEC.md) - Commit-msg hook implementation
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) - RCSD pipeline and HITL gates
- [CLEO-SUBAGENT-PROTOCOL-v1.md](CLEO-SUBAGENT-PROTOCOL-v1.md) - Subagent output requirements

### 9.4 Implementation Evidence

**Success Pattern** (release.md - 86%):
- Single automated script: `scripts/release.sh`
- Runtime validation at execution
- Clear entry point for protocol

**Failure Pattern** (consensus.md - 0%):
- 1850 lines implemented, no CLI access
- Functions never called
- No orchestrator integration

---

## Part 10: Conclusion

This specification defines a **dual-layer enforcement architecture** addressing the 22% baseline compliance identified in Wave 0 research. By combining pre-commit hooks (fast feedback) and runtime validation (comprehensive coverage), CLEO protocols can achieve target 70% enforcement while maintaining developer UX.

**Key Insights**:
1. **Orphaned implementations** (3250 lines) represent highest ROI - CLI wiring unlocks existing functionality
2. **Release protocol success** (86%) proves single automated entry point pattern works
3. **Exit codes 60-67** provide protocol-specific signaling distinct from system errors
4. **Phased rollout** reduces risk - runtime first, hooks incrementally

**Next Actions**:
- Wave 3 implementation (T2692-T2697) addresses critical gaps
- T2689 specifies commit-msg hook details
- T2690 updates protocol text to match reality

**Expected Outcome**: 22% → 40% enforcement after Wave 3, → 55% after Wave 4, → 70% long-term.
