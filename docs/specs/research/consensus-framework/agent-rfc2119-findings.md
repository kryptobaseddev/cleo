# RFC 2119 Audit Findings

## Agent: RFC 2119 Expert (technical-writer)
## Investigation: CONSENSUS-FRAMEWORK-SPEC Meta-Validation
## Date: 2025-12-19

---

## Reference Standards

This audit applies [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119) and [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174.html) (BCP 14) keyword requirements to the CONSENSUS-FRAMEWORK-SPEC.md document.

---

## 1. Missing Conformance Section

The specification lacks the required RFC 2119/8174 boilerplate text. This should be added immediately after the Executive Summary section.

### Draft Boilerplate to Add (After Line 14)

```markdown
---

## Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119][RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html
```

### Placement Rationale

- After Executive Summary (line 14) and before Task Tracking (line 16)
- Early placement ensures readers understand keyword semantics before encountering requirements
- Follows IETF convention of placing terminology near document start

---

## 2. Keyword Audit: Current Uppercase Keywords

| Line | Current Text | Status | Notes |
|------|--------------|--------|-------|
| 429 | "Each worker agent prompt MUST include:" | Valid | Absolute requirement, correctly uppercase |
| 595 | "All phases MUST be tracked via cleo." | Valid | Absolute requirement, correctly uppercase |

**Current Uppercase MUST Count: 2**

---

## 3. Keyword Audit: Lowercase Keywords Requiring Capitalization

| Line | Current Text | Proposed Change | Keyword | Rationale |
|------|--------------|-----------------|---------|-----------|
| 70 | "JSON reads should be allowed" | Keep lowercase | N/A | This is a claim description, not a specification requirement |
| 203 | "Must cite specific worker agent findings" | "MUST cite specific worker agent findings" | MUST | Evidence standard is absolute requirement for validity |
| 233 | "Synthesis Agent must provide explicit evidence" | "Synthesis Agent MUST provide explicit evidence" | MUST | Required action for suspicious consensus |
| 246 | `action: "Synthesis Agent must justify with evidence"` | `action: "Synthesis Agent MUST justify with evidence"` | MUST | Mandatory action in YAML example |
| 270 | `cons: ["May be premature optimization"]` | Keep lowercase | N/A | Example option text, not a requirement |
| 289 | "Should resolve, can assume for now" | "SHOULD resolve, MAY assume for now" | SHOULD/MAY | Severity definition is normative |
| 728 | "should be updated with" | "SHOULD be updated with" | SHOULD | Best practice recommendation |

---

## 4. Implicit Requirements Without Keywords

These statements express requirements implicitly without using RFC 2119 keywords.

| Statement | Location | Proposed Addition | Keyword |
|-----------|----------|-------------------|---------|
| "Task Orchestrator (Claude) launches subagents via Task tool" | Line 148 | "Task Orchestrator (Claude) SHALL launch subagents via Task tool" | SHALL |
| "Task Orchestrator does NOT read subagent output files directly" | Line 149 | "Task Orchestrator MUST NOT read subagent output files directly" | MUST NOT |
| "Synthesis Agent (project-supervisor-orchestrator) reviews all worker outputs" | Line 150 | "Synthesis Agent MUST review all worker outputs" | MUST |
| "Task Orchestrator only reads final consolidated output from Synthesis Agent" | Line 151 | "Task Orchestrator SHALL only read final consolidated output" | SHALL |
| "This protects Task Orchestrator context window" | Line 152 | Remove or rewrite as rationale (not a requirement) | N/A |
| "Evidence citations required" | Line 825 | "Evidence citations REQUIRED" or "Evidence citations MUST be provided" | REQUIRED/MUST |
| "No analysis, no synthesis" | Line 127 | "Task Orchestrator MUST NOT perform analysis or synthesis" | MUST NOT |
| "No cross-domain synthesis" | Line 128 | "Worker Agents MUST NOT perform cross-domain synthesis" | MUST NOT |
| "No original investigation" | Line 129 | "Synthesis Agent MUST NOT conduct original investigation" | MUST NOT |
| "Reproducible test results (3/3 runs)" | Line 838 | "Tests MUST produce reproducible results (3/3 runs)" | MUST |
| "Challenge Agent attacks all findings" | Line 839 | "Challenge Agent MUST attack all findings" | MUST |
| "Evidence justification required" | Line 843 | "Evidence justification MUST be provided" | MUST |
| "Escalate to HITL if insufficient" | Line 844 | "MUST escalate to HITL if evidence insufficient" | MUST |
| "Fresh agent context, no prior involvement" | Line 205 | "Synthesis Agent MUST have fresh context with no prior phase involvement" | MUST |

---

## 5. Keyword Statistics

### Current State
| Keyword | Count |
|---------|-------|
| MUST | 2 |
| MUST NOT | 0 |
| SHALL | 0 |
| SHALL NOT | 0 |
| SHOULD | 0 |
| SHOULD NOT | 0 |
| MAY | 0 |
| REQUIRED | 0 |
| RECOMMENDED | 0 |
| OPTIONAL | 0 |
| **Total** | **2** |

### Proposed Additions
| Keyword | Additions | New Total |
|---------|-----------|-----------|
| MUST | +8 | 10 |
| MUST NOT | +4 | 4 |
| SHALL | +2 | 2 |
| SHOULD | +2 | 2 |
| MAY | +1 | 1 |
| REQUIRED | 0 | 0 |
| **Total** | **+17** | **19** |

### Keyword Balance Assessment

The proposed distribution follows best practices:
- MUST/MUST NOT: 14 (74%) - Core interoperability and safety requirements
- SHALL: 2 (10%) - Behavioral requirements
- SHOULD/MAY: 3 (16%) - Flexibility for implementation

This is appropriate for a process specification where agent behavior must be deterministic.

---

## 6. Anti-Pattern Findings

### 6.1 Keywords Used for Implementation (Not Interop)

| Location | Issue | Recommendation |
|----------|-------|----------------|
| Line 595 | "All phases MUST be tracked via cleo" | Valid - this IS an interoperability requirement (session recovery depends on it) |
| Line 429 | "Each worker agent prompt MUST include:" | Valid - defines interface contract between orchestrator and workers |

**Verdict**: No anti-patterns found. Both existing MUST keywords relate to interoperability.

### 6.2 Keyword Inflation Risk

The current document has significant keyword under-usage, not inflation:
- 935 lines of specification
- Only 2 RFC 2119 keywords
- Ratio: 0.002 keywords per line

Compare to typical IETF specs: 0.01-0.05 keywords per line.

**Risk**: Under-specification leads to ambiguous agent behavior.

### 6.3 Security Implications Not Documented

The specification mentions security-adjacent concerns but lacks explicit security keywords:

| Topic | Location | Missing Requirement |
|-------|----------|---------------------|
| Agent Hallucination | Lines 825, 836-839 | "Agents MUST NOT present unverified claims as evidence" |
| Evidence Tampering | Not addressed | "Evidence files MUST NOT be modified after creation" |
| Context Injection | Not addressed | "Agent prompts MUST NOT include unvalidated external input" |

**Recommendation**: Add a Security Considerations section with explicit MUST/MUST NOT requirements.

### 6.4 Ambiguous Normative Language

Several sections use normative-sounding language without RFC 2119 keywords:

| Section | Example | Issue |
|---------|---------|-------|
| Agent Execution Model | "DO NOT do direct analysis work" | Uses emphasis instead of MUST NOT |
| Consensus Rules | "PROVEN: 4/5 agents agree" | Defines state but not requirement |
| Failure Modes | "Code wins (implementation truth)" | Normative principle without keyword |

---

## 7. RFC 2119 Compliance Recommendations

### 7.1 Immediate Changes (High Priority)

1. **Add Terminology Section**: Insert boilerplate after Executive Summary
2. **Capitalize Existing Requirements**: Lines 203, 233, 246, 289, 728
3. **Convert Implicit Requirements**: Lines 148-151, 825, 838-839, 843-844

### 7.2 Structural Changes (Medium Priority)

1. **Add Role Separation Requirements** (Lines 127-129):
   ```markdown
   | Role | MUST Do | MUST NOT Do |
   |------|---------|-------------|
   | Task Orchestrator | Spawn agents, pass context, monitor | Perform analysis or synthesis |
   | Worker Agents (5) | Domain-specific investigation | Cross-domain synthesis |
   | Synthesis Agent | Consolidate, flag conflicts, write artifacts | Original investigation |
   ```

2. **Add Agent Execution Rules Section**:
   ```markdown
   ### Agent Execution Requirements

   1. Task Orchestrator MUST launch subagents via Task tool
   2. Task Orchestrator MUST NOT read subagent output files directly
   3. Synthesis Agent MUST review all worker outputs before synthesis
   4. Task Orchestrator SHALL only read final consolidated output from Synthesis Agent
   ```

3. **Formalize Evidence Standards**:
   ```markdown
   ### Evidence Requirements

   - All claims MUST include file:line citations
   - Technical claims MUST have reproducible test results (3/3 runs)
   - Feature existence claims MUST include both code search AND doc search
   - Documentation claims MUST cite code contradiction with file:line proof
   ```

### 7.3 New Sections Needed (Lower Priority)

1. **Security Considerations Section**:
   ```markdown
   ## Security Considerations

   Agents MUST NOT:
   - Present unverified claims as evidence
   - Modify evidence files after creation
   - Include unvalidated external input in prompts
   - Execute arbitrary code from investigated claims

   Evidence files SHOULD be checksummed for integrity verification.
   ```

2. **Conformance Levels Section**:
   ```markdown
   ## Conformance Levels

   A conforming implementation MUST:
   - Deploy exactly 5 worker agents in Phase 2
   - Use the Synthesis Agent for all cross-domain consolidation
   - Track all phases via cleo
   - Apply Anti-Consensus Protocol for unanimous agreement < 2 exchanges

   A conforming implementation MAY:
   - Use alternative subagent_type mappings
   - Customize evidence severity thresholds
   - Extend the Question Collection Protocol format
   ```

---

## 8. Summary of Findings

### Compliance Score: 15/100 (Critical)

| Criterion | Score | Max | Notes |
|-----------|-------|-----|-------|
| Terminology section present | 0 | 15 | Missing entirely |
| MUST/MUST NOT keywords used | 5 | 25 | Only 2 instances |
| SHOULD/MAY keywords used | 0 | 20 | None present |
| Implicit requirements converted | 0 | 20 | At least 14 missed |
| Security considerations | 0 | 10 | Section missing |
| Conformance levels defined | 0 | 10 | Section missing |
| **Total** | **5** | **100** | |

### Critical Issues

1. **No RFC 2119 boilerplate** - Readers cannot interpret keyword semantics
2. **Massive under-specification** - 14+ implicit requirements lack keywords
3. **Missing MUST NOT** - No explicit prohibitions despite many implied
4. **No security section** - Agent behavior risks unaddressed

### Recommendation

This specification requires significant RFC 2119 remediation before it can be considered normative. Without proper keyword usage, implementers cannot distinguish mandatory requirements from optional recommendations, leading to non-interoperable implementations.

---

## Sources

- [RFC 2119: Key words for use in RFCs to Indicate Requirement Levels](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words](https://www.rfc-editor.org/rfc/rfc8174.html)
