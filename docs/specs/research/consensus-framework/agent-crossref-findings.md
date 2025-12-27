# Cross-Reference Audit Findings

## Agent: Cross-Reference Architect (system-architect)
## Investigation: CONSENSUS-FRAMEWORK-SPEC Meta-Validation

**Date**: 2025-12-19
**Spec Under Review**: CONSENSUS-FRAMEWORK-SPEC.md
**Status**: Design Complete | Tasks Logged (T184-T214)
**Version**: 1.3.0

---

### 1. Spec Ecosystem Map

```
                    SPEC-BIBLE-GUIDELINES.md (v1.0.0 IMMUTABLE)
                    [Meta-Authority: How to write specs]
                              │
        ┌─────────────────────┼─────────────────────────────────┐
        │                     │                                 │
        ▼                     ▼                                 ▼
   LLM-TASK-ID-             LLM-AGENT-FIRST-         CONSENSUS-FRAMEWORK-
   SYSTEM-DESIGN-SPEC       SPEC.md (v3.1)            SPEC.md (v1.3.0)
   (v1.0.0 IMMUTABLE)       [Agent CLI Design]        [Investigation Framework]
   [ID Authority]                  │                         │
        │                          │                         │
        ├──────────────────────────┼─────────────────────────┤
        │                          │                         │
        ▼                          ▼                         ▼
   ┌─────────────────┐      ┌─────────────────┐      ┌───────────────┐
   │ HIERARCHY-      │      │ CONFIG-SYSTEM   │      │ Uses:         │
   │ ENHANCEMENT     │      │ FILE-LOCKING    │      │ - cleo │
   │ PHASE-SYSTEM    │      │ TODOWRITE-SYNC  │      │ - Serena MCP  │
   │ FIND-COMMAND    │      │ RELEASE-MGMT    │      │ - Task tool   │
   └─────────────────┘      └─────────────────┘      └───────────────┘
         │                         │
         ▼                         ▼
   (Task Management)         (Infrastructure)
```

**Key Insight**: CONSENSUS-FRAMEWORK-SPEC is a **framework spec** (methodology), not a **feature spec** (implementation). It sits alongside LLM-AGENT-FIRST-SPEC as a design philosophy document.

---

### 2. Relationship Analysis

| Related Spec | Relationship | Direction | Strength |
|--------------|--------------|-----------|----------|
| **SPEC-BIBLE-GUIDELINES.md** | AUTHORITATIVE for spec writing | Inbound | MUST reference |
| **LLM-AGENT-FIRST-SPEC.md** | Related: shares agent-first philosophy | Peer | SHOULD reference |
| **LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md** | Defers to for task ID format | Inbound | SHOULD reference |
| **PHASE-SYSTEM-SPEC.md** | Related: framework defines phases internally | Indirect | MAY reference |
| **TODOWRITE-SYNC-SPEC.md** | Related: both address multi-agent coordination | Indirect | MAY reference |
| **FILE-LOCKING-SPEC.md** | Related: framework involves concurrent agent writes | Indirect | MAY reference |

#### Relationship Type Definitions

| Type | Meaning |
|------|---------|
| **AUTHORITATIVE** | The referenced spec is the single source of truth for a domain |
| **Defers to** | On conflicts, the referenced spec wins |
| **Related** | Connected concepts, but no authority hierarchy |
| **Implements** | This spec realizes the referenced spec's requirements |
| **Peer** | Same authority level, complementary scope |

---

### 3. Missing References

| Spec | Why Needed | Relationship Type | Priority |
|------|------------|-------------------|----------|
| **SPEC-BIBLE-GUIDELINES.md** | Framework is a spec; MUST follow spec standards | AUTHORITATIVE | CRITICAL |
| **LLM-AGENT-FIRST-SPEC.md** | Framework deploys LLM agents; shares philosophy | Related (Peer) | HIGH |
| **LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md** | Framework uses task IDs (T184-T214, T205-T214) | Defers to | HIGH |
| *(Implementation Report)* | Spec Bible requires linking to implementation tracking | Tracks status | MEDIUM |

#### Why These Are Missing

1. **SPEC-BIBLE-GUIDELINES.md**: The Consensus Framework spec was written on 2025-12-14, before SPEC-BIBLE-GUIDELINES became IMMUTABLE on 2025-12-17. It predates the formal spec structure requirements.

2. **LLM-AGENT-FIRST-SPEC.md**: The framework uses "5 specialist agents" (technical, design, docs, impl, challenge) but does not reference the LLM-Agent-First design principles that would govern their behavior.

3. **LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md**: The spec references task IDs (T184-T214) throughout but does not formally defer to the ID system spec for ID format authority.

---

### 4. Proposed Related Specifications Section

```markdown
## Related Specifications

| Document | Relationship |
|----------|--------------|
| **[SPEC-BIBLE-GUIDELINES.md](SPEC-BIBLE-GUIDELINES.md)** | **AUTHORITATIVE** for specification structure and standards. This spec MUST follow the guidelines defined there. |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **Related**: Shares agent-first philosophy. Agents deployed by this framework SHOULD follow LLM-Agent-First design principles. |
| **[LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)** | **Defers to** for task ID format. Task IDs (T184-T214) in this spec follow the ID contract defined there. |
| **[PHASE-SYSTEM-SPEC.md](PHASE-SYSTEM-SPEC.md)** | **Related**: Framework defines internal phases (Phase 1-4) that parallel cleo's phase system. |
| *(Implementation Report)* | Tracks implementation status for this specification. |

### Authority Clarifications

This specification is **AUTHORITATIVE** for:
- Multi-agent consensus methodology
- Evidence-based claim validation protocol
- Agent role definitions (Technical, Design, Docs, Implementation, Challenge, Synthesis)
- Voting thresholds and consensus rules
- HITL gate protocol
- Question collection and severity definitions

This specification **defers to**:
- SPEC-BIBLE-GUIDELINES for document structure
- LLM-TASK-ID-SYSTEM-DESIGN-SPEC for task ID format
- LLM-AGENT-FIRST-SPEC for agent behavior standards
```

---

### 5. Authority Recommendations

#### What CONSENSUS-FRAMEWORK-SPEC is AUTHORITATIVE for:

| Domain | Description | Exclusive? |
|--------|-------------|------------|
| **Multi-Agent Consensus Methodology** | The 4-phase, 7-agent approach to claim validation | YES |
| **Evidence Standards by Claim Type** | Reproducible tests, code analysis, comparative analysis | YES |
| **Voting Thresholds** | PROVEN (4/5), REFUTED (<=2/5), CONTESTED (3/5) | YES |
| **Anti-Consensus Protocol** | SUSPICIOUS_CONSENSUS flag, evidence justification | YES |
| **Agent Role Definitions** | Technical Validator, Design Philosophy, Documentation, Implementation, Challenge, Synthesis | YES |
| **HITL Gate Protocol** | When human decisions are required | YES |
| **Question Collection Protocol** | YAML format, severity levels, options structure | YES |
| **Output Artifact Formats** | Consensus Report, Feature Specs, Doc Corrections, Evidence Dossiers | YES |

#### What it SHOULD NOT claim authority over:

| Domain | Authoritative Spec |
|--------|-------------------|
| Task ID format | LLM-TASK-ID-SYSTEM-DESIGN-SPEC |
| Specification structure | SPEC-BIBLE-GUIDELINES |
| CLI output format | LLM-AGENT-FIRST-SPEC |
| Phase lifecycle (cleo) | PHASE-SYSTEM-SPEC |

---

### 6. Document Hierarchy Position

#### Spec Classification

| Dimension | Classification | Rationale |
|-----------|---------------|-----------|
| **Type** | Framework Specification | Defines a methodology, not a feature |
| **Level** | Design Philosophy | Sits alongside LLM-AGENT-FIRST-SPEC |
| **Scope** | Cross-Cutting | Affects how investigations are conducted across all domains |
| **Status** | Design Complete | Ready for implementation but not yet executed |

#### Hierarchy Diagram

```
Level 0: Meta-Authority
    └── SPEC-BIBLE-GUIDELINES.md (How to write specs)

Level 1: Core System Authorities
    ├── LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md (ID system)
    └── LLM-AGENT-FIRST-SPEC.md (Agent CLI design)

Level 2: Design Philosophy / Frameworks  ◀── CONSENSUS-FRAMEWORK-SPEC
    └── CONSENSUS-FRAMEWORK-SPEC.md (Investigation methodology)

Level 3: Feature Specifications
    ├── PHASE-SYSTEM-SPEC.md
    ├── HIERARCHY-ENHANCEMENT-SPEC.md
    ├── CONFIG-SYSTEM-SPEC.md
    ├── FILE-LOCKING-SPEC.md
    ├── TODOWRITE-SYNC-SPEC.md
    ├── FIND-COMMAND-SPEC.md
    └── RELEASE-VERSION-MANAGEMENT-SPEC.md

Level 4: Implementation Guides
    ├── PHASE-DELETE-IMPLEMENTATION.md
    ├── PHASE-RENAME-IMPLEMENTATION.md
    └── PHASE-ROLLBACK-IMPLEMENTATION.md
```

#### Implications

1. **Not in SPEC-INDEX.md**: The Consensus Framework spec is NOT currently listed in the specification index. It should be added under "Design Philosophy" category.

2. **Domain Authority Map Gap**: The SPEC-INDEX.md "Domain Authority Map" does not include a "Consensus/Investigation" domain.

3. **Implementation Report Missing**: Per SPEC-BIBLE-GUIDELINES, every spec SHOULD have an implementation report. CONSENSUS-FRAMEWORK-SPEC has tasks logged (T184-T214) but no formal implementation report document.

---

### 7. Compliance Issues with SPEC-BIBLE-GUIDELINES

| Rule | Compliance | Issue |
|------|------------|-------|
| MUST NOT contain checklists | **PASS** | No `[ ]` or `[x]` checkboxes |
| MUST NOT contain status tracking | **PARTIAL** | Contains "Design Complete" which is borderline |
| MUST NOT contain completion percentages | **PASS** | No percentages |
| MUST NOT contain timeline estimates | **PASS** | No dates for completion |
| MUST use RFC 2119 keywords | **PARTIAL** | Uses "MUST" but lacks formal boilerplate |
| MUST include Related Specifications section | **FAIL** | Missing entirely |
| MUST link to Implementation Report | **FAIL** | No implementation report exists |
| MUST have version and status metadata | **PASS** | Has Version: 1.3.0 and Status |

#### RFC 2119 Conformance Section Required

The spec uses "MUST" in several places:
- "Each worker agent prompt MUST include..."
- "All phases MUST be tracked via cleo"

But it lacks the required boilerplate:

```markdown
## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals.
```

---

### 8. Recommendations

#### Critical (MUST Fix)

1. **Add Related Specifications Section** - Use proposed section from Finding 4
2. **Add RFC 2119 Conformance Section** - Standard boilerplate required
3. **Create Implementation Report** - Track T184-T214 completion formally

#### High Priority (SHOULD Fix)

4. **Add to SPEC-INDEX.md** - Under "Design Philosophy" category
5. **Add to Domain Authority Map** - New domain: "Consensus/Investigation"
6. **Cross-reference from LLM-AGENT-FIRST-SPEC** - Agents may use consensus framework

#### Medium Priority (MAY Consider)

7. **Reference FILE-LOCKING-SPEC** - Concurrent agent file access
8. **Reference TODOWRITE-SYNC-SPEC** - Multi-agent task coordination

---

### 9. SPEC-INDEX.json Addition (Proposed)

```json
{
  "file": "CONSENSUS-FRAMEWORK-SPEC.md",
  "version": "1.3.0",
  "status": "ACTIVE",
  "lastUpdated": "2025-12-14",
  "synopsis": "Multi-agent consensus framework for evidence-based claim validation. 5 specialist agents, 4 phases, voting thresholds, HITL gates.",
  "domain": "consensus-investigation",
  "type": "framework",
  "authoritativeFor": ["consensus-methodology", "agent-roles", "voting-thresholds", "hitl-gates"],
  "dependsOn": ["SPEC-BIBLE-GUIDELINES.md", "LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md"],
  "relatedTo": ["LLM-AGENT-FIRST-SPEC.md", "PHASE-SYSTEM-SPEC.md"]
}
```

---

*End of Cross-Reference Audit Findings*
