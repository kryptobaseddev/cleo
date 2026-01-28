# Protocol Misalignment Corrections Specification

**Version**: 1.0.0
**Status**: ACTIVE
**Created**: 2026-01-28
**Updated**: 2026-01-28
**Author**: Protocol Specification Agent (T2690)

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Part 1: Preamble

### 1.1 Purpose

This specification documents **protocol-code misalignments** identified in Wave 0 research (T2680-T2684) and provides authoritative corrections to align protocol specifications with actual implementation behavior. It addresses the gap between aspirational protocol text and realized functionality.

### 1.2 Authority

This specification is **AUTHORITATIVE** for:

- Protocol text corrections (ALIGN-*)
- Threshold value decisions (THRESH-*)
- Implementation documentation requirements (IMPL-DOC-*)
- Orphaned code connection requirements (ORPH-*)

This specification **DEFERS TO**:

- [PROTOCOL-ENFORCEMENT-SPEC.md](PROTOCOL-ENFORCEMENT-SPEC.md) for enforcement architecture
- Individual protocol files (`protocols/*.md`) for specific requirement definitions (post-correction)
- [PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md) for RCSD pipeline integration

### 1.3 Scope

This specification governs:

1. **Critical misalignments** - Protocol vs code contradictions blocking enforcement
2. **Orphaned implementations** - Code exists but protocol lacks connection documentation
3. **Threshold decisions** - Resolve ambiguous percentage/ratio requirements
4. **Documentation gaps** - Protocol missing key implementation details

### 1.4 Evidence Base

This specification incorporates findings from:

- **T2680-T2684**: Wave 0 research audits (7 protocols, 100 requirements, 22% average enforcement)
- **T2687**: Priority consensus (4-tier system, 3250 lines orphaned code)
- **Git history analysis**: Implementation patterns vs protocol requirements

**Key Evidence**:
- Consensus threshold: Protocol says 80%, code uses >50% majority
- Orphaned consensus functions: 1850 lines in `lib/contribution-protocol.sh` never called
- Orphaned contribution functions: 1400 lines in `lib/contribution-protocol.sh` disconnected
- Provenance tagging: Defined in 2 protocols, validated in 0 locations

---

## Part 2: Critical Misalignments (CRITICAL Priority)

### 2.1 Consensus Threshold Mismatch

**Issue**: Protocol specifies 80% threshold, code implements >50% majority

**Evidence**:
- **Protocol** (`protocols/consensus.md` line 84):
  ```
  | **PROVEN** | 4/5 agents OR 80%+ weighted confidence | Reproducible evidence |
  ```

- **Code** (`lib/contribution-protocol.sh` lines 850-853):
  ```bash
  #      - Majority: >50% agreement (weighted)
  #      - Split: No majority (<= 50%)
  elif $topAnswer.percentage > 0.5 then
  ```

**Impact**: Consensus verdicts may be accepted with 51% support when protocol requires 80%

**Decision** (ALIGN-001):

| ID | Requirement | Rationale |
|----|-------------|-----------|
| ALIGN-001 | Consensus threshold MUST be **50%** (simple majority) | Practical threshold proven by existing implementation; 80% too stringent for 2-3 option decisions |
| ALIGN-002 | Protocol MUST update line 84 to reflect "3/5 agents OR 50%+ weighted confidence" | Match implementation behavior |
| ALIGN-003 | Protocol MAY add optional strict mode "80% weighted confidence for critical decisions" | Future enhancement without breaking existing usage |

**Correction Required**:

**File**: `protocols/consensus.md`

**Line 84** (current):
```markdown
| **PROVEN** | 4/5 agents OR 80%+ weighted confidence | Reproducible evidence |
```

**Line 84** (corrected):
```markdown
| **PROVEN** | 3/5 agents OR 50%+ weighted confidence | Reproducible evidence |
```

**Optional Addition** (after line 87):
```markdown
| **PROVEN_STRICT** | 4/5 agents OR 80%+ weighted confidence | Critical decisions requiring high certainty |
```

**Rationale**:
- Code has been using 50% threshold successfully
- 80% threshold impractical for 2-3 option votes (would often fail)
- Strict mode available for safety-critical decisions if needed
- Aligns with Git commit voting patterns (simple majority)

---

### 2.2 Orphaned Consensus Implementation

**Issue**: 1850 lines of consensus machinery exist but protocol doesn't document how to invoke

**Evidence**:
- **T2681 Audit**: `contribution_compute_consensus()`, `contribution_weighted_vote()`, `contribution_detect_conflicts()` implemented but never called
- **No CLI Command**: No `scripts/consensus.sh` exists to access functions
- **Protocol Silence**: `protocols/consensus.md` doesn't mention how orchestrator triggers consensus

**Impact**: Consensus protocol 100% theoretical, cannot be used in practice (0% enforcement)

**Correction Required**:

| ID | Requirement | Rationale |
|----|-------------|-----------|
| ORPH-001 | Consensus protocol MUST document CLI entry point: `scripts/consensus.sh compute` | Makes orphaned implementation accessible |
| ORPH-002 | Consensus protocol MUST document orchestrator integration: `cleo consensus compute --task T#### --input voting-matrix.json` | Standard invocation pattern |
| ORPH-003 | Consensus protocol MUST document function location: `lib/contribution-protocol.sh` | Discoverability for maintainers |
| ORPH-004 | Consensus protocol SHOULD document typical workflow: Research → Voting Matrix → Consensus Computation → Decision | User journey clarity |

**Protocol Addition** (after line 200 in `protocols/consensus.md`):

```markdown
## Implementation Integration

### CLI Invocation

**Command**: `cleo consensus compute <task-id>`

**Example**:
```bash
# Create voting matrix (JSON file)
cat > voting-matrix.json << 'EOF'
{
  "questionId": "CONS-001",
  "question": "Should we use pre-commit hooks or runtime validation?",
  "options": [
    {"option": "A: Pre-commit hooks only", "vote": "reject", "confidence": 0.15, "rationale": "..."},
    {"option": "B: Runtime validation only", "vote": "accept", "confidence": 0.38, "rationale": "..."},
    {"option": "C: Both (hybrid approach)", "vote": "accept", "confidence": 0.92, "rationale": "..."}
  ]
}
EOF

# Compute consensus
cleo consensus compute T2685 --input voting-matrix.json --output consensus-result.json

# Result includes verdict, winning option, consensus score
```

### Function Location

**Library**: `lib/contribution-protocol.sh`

**Key Functions**:
- `contribution_compute_consensus()` - Main consensus computation
- `contribution_weighted_vote()` - Weighted scoring algorithm
- `contribution_detect_conflicts()` - Conflict identification
- `contribution_format_consensus_output()` - JSON output formatting

**Note**: Functions prefixed `contribution_*` but used for consensus protocol (naming mismatch documented in T2687 priority 8).

### Orchestrator Integration

Orchestrators MUST invoke consensus computation via CLI command when task requires decision:

```bash
# Detect consensus task
if task_requires_protocol "$task_id" "consensus"; then
    # Validate voting matrix exists
    if [[ ! -f "voting-matrix.json" ]]; then
        echo "ERROR: Consensus task requires voting-matrix.json input"
        exit 1
    fi

    # Compute consensus
    cleo consensus compute "$task_id" --input voting-matrix.json --output consensus-result.json

    # Check verdict
    verdict=$(jq -r '.verdict' consensus-result.json)
    if [[ "$verdict" == "PROVEN" ]]; then
        echo "✓ Consensus reached"
    elif [[ "$verdict" == "CONTESTED" ]]; then
        echo "⚠ Consensus contested - HITL escalation required"
        cleo escalate "$task_id" --reason "consensus-contested"
    fi
fi
```
```

**Rationale**:
- CLI entry point makes 1850 lines of orphaned code accessible
- Standard `cleo consensus compute` pattern follows `cleo release create` success model
- Orchestrator integration enables automated consensus without manual computation
- Function location documented for maintainers (despite naming mismatch)

---

### 2.3 Orphaned Contribution Implementation

**Issue**: 1400 lines of contribution machinery exist but protocol doesn't document integration with `cleo complete` workflow

**Evidence**:
- **T2684 Audit**: `contribution_create_manifest_entry()`, `contribution_validate_task()` implemented but never called (14% enforcement)
- **No CLI Command**: No `scripts/contribution.sh` exists
- **Protocol Silence**: `protocols/contribution.md` doesn't mention how to trigger contribution tracking

**Impact**: Contribution protocol mostly theoretical, lacks automated enforcement

**Correction Required**:

| ID | Requirement | Rationale |
|----|-------------|-----------|
| ORPH-005 | Contribution protocol MUST document CLI entry point: `scripts/contribution.sh track` | Makes implementation accessible |
| ORPH-006 | Contribution protocol MUST document integration with `cleo complete` workflow | Automatic contribution tracking |
| ORPH-007 | Contribution protocol MUST document function location: `lib/contribution-protocol.sh` | Discoverability |
| ORPH-008 | Contribution protocol SHOULD document typical workflow: Implementation → Manifest → Contribution Record → Attribution | User journey |

**Protocol Addition** (after line 180 in `protocols/contribution.md`):

```markdown
## Implementation Integration

### Automatic Contribution Tracking

Contribution tracking is **automatically triggered** when completing tasks:

```bash
# Standard task completion
cleo complete T2688 --notes "Completed protocol enforcement spec"

# Internal workflow:
# 1. Validate task exists and manifest entry created
# 2. Call contribution_create_manifest_entry() to build attribution
# 3. Append contribution record to .cleo/contributions.json
# 4. Update task metadata with contribution ID
# 5. Mark task complete
```

### Manual Contribution Tracking

For non-task contributions (e.g., PR reviews, documentation fixes):

```bash
# Track contribution manually
cleo contribution track \
    --type "documentation" \
    --description "Updated PROTOCOL-ENFORCEMENT-SPEC.md" \
    --files "docs/specs/PROTOCOL-ENFORCEMENT-SPEC.md" \
    --pr "https://github.com/user/repo/pull/123"

# Output: Contribution ID contrib_20260128_abc123
```

### Function Location

**Library**: `lib/contribution-protocol.sh`

**Key Functions**:
- `contribution_create_manifest_entry()` - Build contribution record
- `contribution_validate_task()` - Pre-completion validation
- `contribution_compute_attribution()` - Calculate contribution metrics
- `contribution_format_output()` - JSON output formatting

### Integration with cleo complete

The `cleo complete` command automatically invokes contribution tracking:

**File**: `scripts/complete-task.sh`

**Integration Point** (after line 150):
```bash
# After manifest validation, before marking complete
if [[ -f "lib/contribution-protocol.sh" ]]; then
    source lib/contribution-protocol.sh

    contribution_create_manifest_entry "$task_id" "$manifest_entry" || {
        echo "WARNING: Contribution tracking failed (non-blocking)"
    }
fi
```

**Rationale**: Automatic tracking ensures contribution protocol compliance without manual steps.
```

**Rationale**:
- CLI entry point makes 1400 lines accessible
- Integration with `cleo complete` provides automatic enforcement (follows release.md pattern)
- Manual tracking option covers non-task contributions
- Function location documented despite naming

---

## Part 3: High-Priority Corrections (HIGH Priority)

### 3.1 Provenance Tag Validation Gap

**Issue**: IMPL-003 and CONT-002 define `@task T####` provenance tags but no validation exists

**Evidence**:
- **Protocol** (`protocols/implementation.md` lines 59-102): Defines provenance tag format
- **Protocol** (`protocols/contribution.md` lines 45-78): Defines same provenance format
- **Code**: Zero validation - no grep for `@task`, no pre-commit hook, no runtime check

**Impact**: Attribution system exists in theory only, cannot trace code to tasks

**Correction Required**:

| ID | Requirement | Implementation |
|----|-------------|----------------|
| IMPL-DOC-001 | Implementation protocol MUST document validation command: `cleo provenance validate` | Exposes validator |
| IMPL-DOC-002 | Implementation protocol MUST document pre-commit hook location: `.git/hooks/pre-commit` | Installation path |
| IMPL-DOC-003 | Implementation protocol SHOULD document validation thresholds: 80% coverage for new code | Quality target |

**Protocol Addition** (after IMPL-003 definition):

```markdown
### Provenance Validation

**Pre-commit Hook** (Phase 2):

The pre-commit hook validates new code contains `@task` tags:

```bash
# .git/hooks/pre-commit (partial)

# Get staged files
staged_files=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(sh|js|py|ts)$')

# Check each file for @task tags in new code
for file in $staged_files; do
    # Get added lines
    added_lines=$(git diff --cached "$file" | grep '^+' | grep -v '^+++')

    # Check if new functions/classes lack @task tags
    if echo "$added_lines" | grep -E '(function |class |def )' >/dev/null; then
        # New code structure added - require @task tag
        if ! git diff --cached "$file" | grep '@task T[0-9]' >/dev/null; then
            echo "ERROR: New code in $file missing @task T#### tag"
            exit 1
        fi
    fi
done
```

**Runtime Validation**:

Check existing codebase coverage:

```bash
# Validate provenance coverage
cleo provenance validate --threshold 80

# Output:
# Provenance Coverage Report
# =========================
# Files analyzed:      145
# Files with tags:     98 (68%)
# Lines with tags:     12,450 / 18,300 (68%)
# Functions tagged:    234 / 298 (79%)
#
# Below threshold (80%):
#   lib/contribution-protocol.sh: 45% (orphaned code)
#   lib/orchestrator-startup.sh: 62%
#   scripts/consensus.sh: 0% (not yet implemented)
```

**Validation Thresholds**:

| Code Type | Required Coverage | Rationale |
|-----------|------------------|-----------|
| New code (hooks) | 100% | Enforce at commit time |
| Existing code (runtime) | 80% | Gradual improvement target |
| Legacy code (pre-v0.70.0) | 50% | Grandfathered, document intent to improve |
```

**Rationale**:
- Pre-commit hook provides fast feedback (Phase 2 after COMMIT-TASK-ENFORCEMENT implemented)
- Runtime validation tracks gradual improvement
- Thresholds realistic (100% for new, 80% target for existing, 50% legacy)

---

### 3.2 Research Protocol Behavioral Constraint Gap

**Issue**: RSCH-001 prohibits code changes but no enforcement exists

**Evidence**:
- **Protocol** (`protocols/research.md` line 30): "MUST NOT implement code or make changes to codebase"
- **Code**: No tool allowlist, no git diff check, no validation

**Impact**: Research agents could accidentally modify code without detection

**Correction Required**:

| ID | Requirement | Implementation |
|----|-------------|----------------|
| IMPL-DOC-004 | Research protocol MUST document tool allowlist: Read, Grep only | Pre-spawn constraint |
| IMPL-DOC-005 | Research protocol MUST document validation command: `cleo research validate <task-id>` | Post-completion check |
| IMPL-DOC-006 | Research protocol SHOULD document orchestrator integration: pre-spawn allowlist enforcement | Automated constraint |

**Protocol Addition** (after RSCH-001):

```markdown
### Enforcement

**Pre-spawn Tool Allowlist**:

When spawning research agents, orchestrator MUST restrict tools:

```json
{
  "subagent_type": "cleo-subagent",
  "allowed_tools": ["Read", "Grep"],
  "prohibited_tools": ["Write", "Edit", "Bash"],
  "protocol": "research"
}
```

**Post-completion Validation**:

After research task completion, validate no code changes:

```bash
# Validate research task didn't modify code
cleo research validate T2680

# Internal check:
# 1. Get commit range for task duration
# 2. git diff <start-commit>..<end-commit> --name-only
# 3. Filter for code files (.sh, .js, .py, etc.)
# 4. If code changes detected → violation (exit 60)
```

**Orchestrator Integration**:

```bash
# Before spawning research agent
if task_requires_protocol "$task_id" "research"; then
    # Enforce tool allowlist
    allowed_tools='["Read", "Grep"]'

    # Spawn with constraints
    spawn_subagent \
        --task "$task_id" \
        --protocol research \
        --allowed-tools "$allowed_tools"
fi

# After research completion
cleo research validate "$task_id" || {
    echo "ERROR: Research task $task_id modified code (RSCH-001 violation)"
    exit 60
}
```

**Exit Code**: 60 (research protocol violation)
```

**Rationale**:
- Pre-spawn allowlist prevents violations (most effective)
- Post-completion validation catches any bypasses
- Exit code 60 consistent with PROTOCOL-ENFORCEMENT-SPEC

---

### 3.3 Specification Protocol Authority Section Gap

**Issue**: SPEC-003 requires authority section but only 1/5 sampled specs have it (20% adoption)

**Evidence**:
- **Protocol** (`protocols/specification.md` line 45): "MUST include authority/scope section"
- **Reality** (T2682 audit): 1/5 specs have authority section, 4/5 lack it
- **Drift**: Increasing over time as discipline declines

**Decision** (ALIGN-004):

| ID | Requirement | Rationale |
|----|-------------|-----------|
| ALIGN-004 | SPEC-003 authority section requirement MUST be downgraded from MUST to SHOULD | Reality shows 80% non-compliance; MUST implies blocking enforcement |
| ALIGN-005 | Specification protocol SHOULD add enforcement note: "Authority section SHOULD be added to all new specs; legacy specs MAY omit" | Gradual improvement without retroactive invalidation |
| ALIGN-006 | Specification protocol MAY add linter: `scripts/validate-spec.sh` to check authority section | Future enforcement mechanism (Phase 4) |

**Protocol Correction**:

**Line 45** (current in `protocols/specification.md`):
```markdown
| SPEC-003 | MUST include authority/scope section defining what specification governs |
```

**Line 45** (corrected):
```markdown
| SPEC-003 | SHOULD include authority/scope section defining what specification governs |
```

**Add to SPEC-003 row** (enforcement note):
```markdown
Note: Authority section required for new specifications (v0.70.0+). Legacy specifications MAY omit but SHOULD backfill when updated.
```

**Rationale**:
- Reality check: 80% non-compliance means MUST is aspirational, not enforced
- Downgrade to SHOULD aligns protocol with reality
- Gradual improvement: require for new, encourage for legacy
- Future linter can warn (non-blocking) to encourage adoption

---

### 3.4 Decomposition Atomicity Test Gap

**Issue**: DCMP-004 defines 6-point atomicity test but no `validate_atomicity()` function exists

**Evidence**:
- **Protocol** (`protocols/decomposition.md` lines 79-88): Defines atomicity test (single file, <300 lines, clear acceptance criteria, etc.)
- **Code**: No validation function, no atomicity checking

**Impact**: Non-atomic leaf tasks create hidden work, poor decomposition quality

**Correction Required**:

| ID | Requirement | Implementation |
|----|-------------|----------------|
| IMPL-DOC-007 | Decomposition protocol MUST document validation command: `cleo atomicity check <task-id>` | Exposes atomicity validator |
| IMPL-DOC-008 | Decomposition protocol SHOULD document atomicity criteria as checklist | User-facing guidance |
| IMPL-DOC-009 | Decomposition protocol MAY integrate with `cleo add` for pre-creation validation | Proactive quality check |

**Protocol Addition** (after DCMP-004):

```markdown
### Atomicity Validation

**Validation Command**:

```bash
# Check if task is atomic
cleo atomicity check T2688

# Output:
# Atomicity Report for T2688
# ==========================
# ✓ Single concern (protocol enforcement)
# ✓ Clear acceptance criteria (7 key findings documented)
# ✗ File scope (touches 3 files: docs/specs/*.md, lib/protocol-validation.sh, .git/hooks/commit-msg)
# ✓ Estimated lines: ~200 (within 300 limit)
# ✓ No hidden subtasks
# ✓ Completable in one session
#
# Score: 5/6 (83%)
# Verdict: MOSTLY_ATOMIC (acceptable)
```

**Atomicity Checklist** (from DCMP-004):

1. ✓ **Single concern** - Task addresses one problem/feature
2. ✓ **Clear acceptance criteria** - Success measurable
3. ✓ **File scope** - Touches 1-3 files (not sprawling)
4. ✓ **Size estimate** - <300 lines of changes
5. ✓ **No hidden subtasks** - No "and also..." requirements
6. ✓ **Completable in session** - Fits context window

**Scoring**:
- 6/6: ATOMIC (ideal)
- 5/6: MOSTLY_ATOMIC (acceptable)
- 4/6: BORDERLINE (review recommended)
- 3/6 or less: NON_ATOMIC (decompose further)

**Integration with Task Creation**:

```bash
# Pre-creation validation (opt-in)
cleo add "Implement protocol enforcement" --validate-atomicity

# If non-atomic, suggest decomposition:
# WARNING: Task appears non-atomic (score 3/6)
# Concerns:
#   - File scope too broad (touches 8 files)
#   - Hidden subtasks detected ("and also validate...", "plus add...")
#
# Suggestions:
#   - Break into: (1) Core validation, (2) Hook implementation, (3) Testing
#   - Use: cleo epic create "Protocol Enforcement" to group related tasks
```

**Function Location**: `lib/protocol-validation.sh` (validate_atomicity function)

**Rationale**: Proactive atomicity checking improves decomposition quality without blocking workflow.
```

**Rationale**:
- CLI command makes atomicity checking accessible
- Scoring system (6-point checklist) provides gradual quality assessment
- Integration with `cleo add` enables proactive validation
- Non-blocking (SHOULD/MAY) allows gradual adoption

---

## Part 4: Medium-Priority Corrections (MEDIUM Priority)

### 4.1 agent_type Enum Gap

**Issue**: All 7 protocols require `agent_type` field but no enum constraint enforces valid values

**Evidence**:
- **Protocols**: RSCH-007, CONS-007, SPEC-007, IMPL-007, CONT-007, RLSE-007, DCMP-007 all require `agent_type`
- **Schema**: `schemas/manifest.schema.json` allows any string (no enum)

**Impact**: Manifest entries may have wrong/missing `agent_type`, breaking categorization

**Correction Required**:

| ID | Requirement | Implementation |
|----|-------------|----------------|
| ALIGN-007 | All protocol files MUST document valid agent_type enum: `["research", "analysis", "specification", "implementation", "documentation"]` | Consistency across protocols |
| ALIGN-008 | Manifest schema MUST add enum constraint to `agent_type` field | Validation enforcement |
| ALIGN-009 | Validation functions SHOULD check `agent_type` matches protocol (research → "research", consensus → "analysis", etc.) | Correctness validation |

**Schema Correction**:

**File**: `schemas/manifest.schema.json`

**Current** (line 45):
```json
"agent_type": {
  "type": "string",
  "description": "Type of agent that created the entry"
}
```

**Corrected**:
```json
"agent_type": {
  "type": "string",
  "enum": ["research", "analysis", "specification", "implementation", "documentation"],
  "description": "Type of agent that created the entry"
}
```

**Protocol Updates** (all 7 protocol files):

Add after each `agent_type` requirement:

```markdown
Valid values: `research` (research protocol), `analysis` (consensus protocol), `specification` (specification/decomposition protocols), `implementation` (implementation/contribution/release protocols), `documentation` (documentation tasks).
```

**Rationale**:
- Enum constraint prevents typos and invalid values
- Validation functions can enforce protocol-specific expectations
- Schema validation automatic (no code changes needed beyond schema update)

---

### 4.2 Key Findings Count Validation Gap

**Issue**: RSCH-006 requires 3-7 key findings but only checks existence, not count

**Evidence**:
- **Protocol** (`protocols/research.md` line 36): "MUST include 3-7 key findings"
- **Code** (`lib/research-manifest.sh` line 120): `check_manifest_entry()` checks field exists, not count

**Impact**: Research manifests may have 0, 1, or 50+ findings without detection

**Correction Required**:

| ID | Requirement | Implementation |
|----|-------------|----------------|
| IMPL-DOC-010 | Research protocol MUST document validation: `key_findings` array length between 3-7 | Explicit constraint |
| IMPL-DOC-011 | Validation function SHOULD check: `jq '.key_findings | length' | awk '$1 >= 3 && $1 <= 7'` | Enforcement logic |
| IMPL-DOC-012 | Violation SHOULD exit with code 60 (research protocol violation) | Consistent error handling |

**Code Correction**:

**File**: `lib/protocol-validation.sh` (new function)

```bash
validate_research_findings_count() {
    local manifest_entry="$1"

    local findings_count
    findings_count=$(echo "$manifest_entry" | jq '.key_findings | length')

    if [[ $findings_count -lt 3 || $findings_count -gt 7 ]]; then
        echo '{"valid": false, "violation": "RSCH-006", "message": "Key findings must be 3-7, got '$findings_count'"}'
        return 60
    fi

    echo '{"valid": true}'
    return 0
}
```

**Protocol Addition** (after RSCH-006):

```markdown
**Validation**: Manifest entry `key_findings` array MUST have length between 3 and 7 inclusive. Validated via:

```bash
jq '.key_findings | length' manifest-entry.json | awk '$1 >= 3 && $1 <= 7 || exit 60'
```

**Rationale**: 3-7 findings balances depth (minimum 3 for substantive research) and conciseness (maximum 7 to avoid overwhelming readers).
```

**Rationale**:
- Simple jq check enforces count constraint
- Exit code 60 consistent with research protocol violations
- Documentation clarifies rationale (3 = minimum depth, 7 = maximum conciseness)

---

## Part 5: Implementation Roadmap

### 5.1 Wave 3 Critical Corrections (Immediate)

**T2694**: Fix consensus threshold mismatch
- Update `protocols/consensus.md` line 84: "3/5 agents OR 50%+ weighted confidence"
- Optional: Add PROVEN_STRICT for 80% threshold
- Expected outcome: Protocol matches code (50% majority)

**T2696**: Update protocol files to match code (critical priority)
- Consensus: Add implementation integration section (CLI, orchestrator)
- Contribution: Add implementation integration section (CLI, cleo complete)
- Provenance: Add validation sections (pre-commit, runtime)
- Research: Add enforcement sections (tool allowlist, validation)

### 5.2 Wave 4 High-Priority Corrections (Follow-up Epic)

- Add `agent_type` enum to manifest schema
- Add key findings count validation to research protocol
- Downgrade SPEC-003 from MUST to SHOULD (authority section)
- Add atomicity validation documentation to decomposition protocol

### 5.3 Success Metrics

**Baseline (Wave 0)**:
- Protocol-code misalignment: 5 critical gaps
- Threshold contradictions: 1 (consensus 50% vs 80%)
- Orphaned implementations: 3250 lines (1850 consensus + 1400 contribution)
- Validation gaps: 4 (provenance, research, atomicity, agent_type)

**Target (Post-Wave 3)**:
- Threshold contradictions: 0 (consensus aligned at 50%)
- Orphaned implementations: 0 (CLI entry points documented)
- Documentation gaps: 0 (integration sections added)

**Target (Post-Wave 4)**:
- Validation gaps: 0 (all 4 implemented)
- Schema constraints: enforced (agent_type enum)
- Protocol-code alignment: 100% for MUST requirements

---

## Part 6: Open Questions

1. Should consensus threshold **strict mode** (80%) be implemented now or deferred?
   - **Context**: 50% sufficient for most decisions, 80% for critical only
   - **Impact**: Implementation complexity vs future-proofing
   - **Recommendation**: Defer to future epic when use case arises

2. Should provenance validation be **blocking** (fail commit) or **warning** (log violation)?
   - **Context**: Zero current enforcement, backfill needed
   - **Impact**: Developer friction vs data quality
   - **Recommendation**: Warning initially (Wave 4), blocking after backfill (Wave 5)

3. Should function naming be corrected (`contribution_*` → `consensus_*`)?
   - **Context**: 10 functions misnamed, low priority (MEDIUM per T2687)
   - **Impact**: Discoverability vs refactor risk
   - **Recommendation**: Defer to Wave 5 (clarity improvement after critical gaps fixed)

4. Should authority section be **backfilled** for legacy specs or left as-is?
   - **Context**: SPEC-003 downgraded to SHOULD
   - **Impact**: Data completeness vs effort
   - **Recommendation**: Backfill opportunistically (when spec updated), don't force

5. Should atomicity validation be **blocking** (prevent task creation) or **advisory** (warn only)?
   - **Context**: Atomicity subjective (6-point checklist)
   - **Impact**: Task creation UX vs decomposition quality
   - **Recommendation**: Advisory only (SHOULD), never blocking

---

## Part 7: References

### 7.1 Wave 0 Research

- **T2680**: Research Protocol Audit (19% enforced, manifest validation only)
- **T2681**: Consensus Protocol Audit (0% enforced, 1850 lines orphaned, threshold mismatch)
- **T2682**: Specification Protocol Audit (14% enforced, authority section 20% adoption)
- **T2683**: Decomposition Protocol Audit (36% enforced, atomicity test not validated)
- **T2684**: Execution Protocols Audit (provenance 0% enforced, release 86% best)

### 7.2 Consensus Decisions

- **T2687**: Priority Classification (4-tier system, 3250 lines orphaned critical)

### 7.3 Related Specifications

- [PROTOCOL-ENFORCEMENT-SPEC.md](PROTOCOL-ENFORCEMENT-SPEC.md) - Enforcement architecture and exit codes
- [COMMIT-TASK-ENFORCEMENT-SPEC.md](COMMIT-TASK-ENFORCEMENT-SPEC.md) - Commit-msg hook (provenance entry point)

---

## Part 8: Conclusion

This specification documents **5 critical misalignments** between protocol text and implementation:

1. **Consensus threshold**: Protocol 80% vs code 50% → **Align at 50%**
2. **Orphaned consensus**: 1850 lines inaccessible → **Add CLI entry point documentation**
3. **Orphaned contribution**: 1400 lines disconnected → **Add integration documentation**
4. **Provenance gap**: 0% enforcement → **Add validation documentation**
5. **Research behavioral**: No enforcement → **Add tool allowlist documentation**

**Key Principle**: **Align protocol with reality** rather than force reality to match aspirational text. Where code works (50% threshold), update protocol. Where code missing (orphaned functions), document how to access. Where enforcement needed (provenance), document validation strategy.

**Next Actions**:
- T2694: Fix consensus threshold (protocol update)
- T2696: Add integration documentation (protocol additions)
- Wave 4: Implement validation functions (code additions)

**Expected Outcome**: 100% protocol-code alignment for MUST requirements, zero contradictions, zero orphaned implementations.
