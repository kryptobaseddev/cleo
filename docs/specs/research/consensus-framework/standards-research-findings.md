# Standards Research Findings

## Agent: Standards Research (deep-research-agent)
## Investigation: CONSENSUS-FRAMEWORK-SPEC Meta-Validation
## Date: 2025-12-19

---

## 1. RFC 2119 Best Practices

### 1.1 Proper Boilerplate Text

RFC 2119 specifies a recommended introductory phrase that MUST appear near the beginning of any document using these keywords:

```
The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in RFC 2119.
```

**RFC 8174 Clarification (2017)**: Updated to clarify that ONLY UPPERCASE usage has special meaning. The updated boilerplate is:

```
The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all
capitals, as shown here.
```

### 1.2 Keyword Definitions

| Keyword | Meaning |
|---------|---------|
| MUST / REQUIRED / SHALL | Absolute requirement |
| MUST NOT / SHALL NOT | Absolute prohibition |
| SHOULD / RECOMMENDED | Valid reasons may exist to ignore, but full implications must be understood |
| SHOULD NOT / NOT RECOMMENDED | Valid reasons may exist to comply, but full implications must be understood |
| MAY / OPTIONAL | Truly optional; implementations may or may not include |

### 1.3 When Overuse is a Problem

From IETF and OASIS guidelines:

1. **Overuse diminishes impact**: If everything is MUST, nothing is MUST
2. **SHOULD vs MUST confusion**: Using SHOULD when you mean MUST creates implementation variance
3. **Avoid for non-requirements**: Don't use RFC 2119 keywords for informative text, examples, or rationale
4. **Agent constraint**: RFC 2119 keywords should constrain *agents* (things that act), not make declarative statements about abstract concepts
5. **Testability**: Every MUST/SHOULD statement should be testable for conformance

### 1.4 Current Spec Issues Identified

The CONSENSUS-FRAMEWORK-SPEC.md:
- **Does NOT include RFC 2119 boilerplate** (violation of best practice)
- Uses "MUST" informally (e.g., "All tasks logged in cleo with label `consensus-framework`" uses imperative without formal keywords)
- Mixes normative requirements with tracking/status information
- "CRITICAL" annotations used instead of proper RFC 2119 terminology

---

## 2. Spec vs Status Separation

### 2.1 IETF RFC Approach

**Core Principle**: Published RFCs are immutable. Status is tracked separately.

| Concern | Tracked In |
|---------|------------|
| Normative specification | The RFC document itself |
| Implementation status | Separate implementation reports |
| Errors/corrections | Errata database (external) |
| Document relationships | RFC metadata (obsoletes, updates) |
| Standardization status | RFC status field (Proposed Standard, Internet Standard, etc.) |

**Key Pattern**: RFCs NEVER contain mutable status information within the document body. Status changes via:
1. New RFCs that "update" or "obsolete" previous ones
2. External errata submissions
3. IETF datatracker status fields

### 2.2 W3C Approach

**Document Types**:
| Type | Purpose | Status Tracking |
|------|---------|-----------------|
| Recommendation | Normative spec | Status in header, not body |
| Candidate Recommendation | Spec seeking implementation | Implementation Report (separate doc) |
| Working Draft | In-progress spec | Status section in header only |
| Editor's Draft | Latest work | No status tracking |

**Implementation Reports**: W3C maintains separate "Implementation Report" documents that track:
- Which features have implementations
- Interoperability testing results
- At-risk features

**Example**: WAI-ARIA 1.0 has a separate `implementation-report` document at `/WAI/ARIA/1.0/CR/implementation-report`

### 2.3 What Belongs Where

| Content Type | In Spec | In Separate Doc |
|--------------|---------|-----------------|
| Normative requirements | YES | NO |
| Informative examples | YES (marked) | NO |
| Implementation status | NO | YES |
| Task tracking | NO | YES |
| Version history/changelog | MINIMAL | Full history external |
| Errata/corrections | NO (immutable) | YES (errata doc) |
| Conformance testing | REFERENCE | Full suite external |

---

## 3. Standard Structures

### 3.1 IETF RFC Structure (Required Sections)

From RFC 7322 (RFC Style Guide):

```
1. Header (title, authors, date, status)
2. Abstract [REQUIRED]
3. Status of This Memo [REQUIRED]
4. Copyright Notice [REQUIRED]
5. Table of Contents [REQUIRED for longer docs]
6. Introduction [REQUIRED]
7. Requirements Language (RFC 2119 boilerplate)
8. [BODY SECTIONS - domain specific]
9. IANA Considerations [REQUIRED]
10. Security Considerations [REQUIRED]
11. References
    11.1. Normative References
    11.2. Informative References
12. Authors' Addresses
```

### 3.2 Normative vs Informative References

From IESG Statement on References:

- **Normative**: Documents that MUST be read to understand/implement the spec
- **Informative**: Background, historical context, additional information

These MUST be separated into distinct subsections.

### 3.3 W3C Specification Structure

From W3C QA Framework:

```
1. Abstract
2. Status of This Document
3. Table of Contents
4. Introduction (informative)
5. Conformance (normative)
   - Conformance Classes
   - Requirements Language
6. [BODY SECTIONS]
   - Each section marked as "normative" or "informative"
7. Security Considerations
8. Privacy Considerations
9. Accessibility Considerations
10. IANA Considerations (if applicable)
11. References
    - Normative References
    - Informative References
12. Appendices (typically informative)
```

### 3.4 Marking Normative Content

W3C Best Practice (Good Practice 2):

> "Specify in the conformance clause how to distinguish normative from informative content."

Methods:
1. Section headings: "Glossary (Normative)" or "Examples (Informative)"
2. Explicit statement: "All text is normative except sections marked non-normative"
3. CSS styling: Different visual treatment for normative vs informative
4. Consolidated list in conformance section

---

## 4. Anti-Patterns Identified

### 4.1 Mixing Specification with Implementation Tracking

**Anti-Pattern**: Embedding task IDs, implementation status, and mutable tracking data within a normative specification document.

**Why It's Bad**:
1. **Mutability pollution**: Specs should be versioned and stable; tracking data changes constantly
2. **Confusion of concerns**: Readers can't distinguish requirements from status
3. **Maintenance burden**: Every status change requires spec update
4. **Breaks immutability**: IETF principle - published specs don't change
5. **Tooling conflicts**: Spec parsers, validators expect stable structure

**In Current Spec**:
- Lines 17-78: "Task Tracking" section with T184-T214 task IDs
- Lines 4: "Status: Design Complete | Tasks Logged (T184-T214)"
- Lines 22-78: Multiple tables of task IDs with statuses

### 4.2 Overloading Document Purpose

**Anti-Pattern**: Using a single document for specification, tracking, execution protocol, and changelog.

**Why It's Bad**:
1. **Cognitive overload**: 935 lines mixing concerns
2. **No clear conformance scope**: What must be followed vs what's informational?
3. **Versioning confusion**: Changelog (lines 909-934) belongs external

**Recommendation**: Split into:
- `CONSENSUS-FRAMEWORK-SPEC.md` - Pure normative specification
- `CONSENSUS-FRAMEWORK-STATUS.md` - Current investigation status, task tracking
- `CONSENSUS-FRAMEWORK-CHANGELOG.md` - Version history

### 4.3 Implicit Requirements

**Anti-Pattern**: Using imperative statements without RFC 2119 keywords.

**Examples from current spec**:
- "All tasks logged in cleo" - Is this MUST or SHOULD?
- "Task Orchestrator uses subagents organized in blocks" - Requirement or description?
- "Every claim requires file:line citation" - MUST or recommendation?

### 4.4 Missing Conformance Clause

**Anti-Pattern**: No explicit statement of what conformance means.

**Current spec lacks**:
- Definition of conformance classes (what types of things conform?)
- Explicit normative/informative section markers
- Testable conformance criteria

### 4.5 Status in Header

**Anti-Pattern**: Line 4 mixes document status with implementation status.

```
Status: Design Complete | Tasks Logged (T184-T214)
```

**Should be**: Document maturity status only (Draft, Proposed, Final)

---

## 5. Recommendations for CONSENSUS-FRAMEWORK-SPEC

### 5.1 Structural Recommendations

1. **Add RFC 2119 boilerplate** in Section 1 or 2
   ```markdown
   ## Conventions and Terminology

   The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
   "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
   "OPTIONAL" in this document are to be interpreted as described in
   BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all
   capitals, as shown here.
   ```

2. **Add Conformance Clause** defining:
   - What entities must conform (Task Orchestrator, Worker Agents, Synthesis Agent)
   - What constitutes conformant behavior
   - How conformance is verified

3. **Mark all sections as normative or informative**
   - Executive Summary: Informative
   - Agent Architecture: Normative
   - Consensus Rules: Normative
   - Examples: Informative
   - Quick Start: Informative

4. **Separate References**
   - Normative: RFC 2119, BCP 14, any required external specs
   - Informative: Related frameworks, background reading

### 5.2 Content Separation Recommendations

1. **Extract Task Tracking** (lines 17-78) to separate document
   - Create: `docs/specs/CONSENSUS-FRAMEWORK-STATUS.md`
   - Contains: Task IDs, current investigation state, claim statuses

2. **Extract Changelog** (lines 909-935) to separate document
   - Create: `docs/specs/CONSENSUS-FRAMEWORK-CHANGELOG.md`
   - Or use git tags/releases for version tracking

3. **Simplify Header** (line 4)
   - From: `Status: Design Complete | Tasks Logged (T184-T214)`
   - To: `Status: Draft` or `Status: 1.3.0 (Stable)`

### 5.3 Keyword Formalization

Convert informal imperatives to RFC 2119:

| Current Text | Recommended |
|--------------|-------------|
| "All tasks logged in cleo" | "All tasks MUST be logged in cleo" |
| "Task Orchestrator does NOT read subagent output files directly" | "Task Orchestrator MUST NOT read subagent output files directly" |
| "Evidence citations required" | "Evidence citations MUST be provided" |
| "Challenge Agent attacks all findings" | "Challenge Agent SHOULD challenge all findings" |

### 5.4 Structural Reorganization

Recommended section order (following IETF/W3C patterns):

```markdown
# Multi-Phase Consensus Research Framework Specification

## Abstract
[Brief summary - informative]

## Status of This Document
[Document maturity only - no task tracking]

## Conventions and Terminology
[RFC 2119 boilerplate, definitions]

## Introduction (Informative)
[Background, motivation, scope]

## Conformance
[Conformance classes, requirements summary]

## Architecture (Normative)
[Agent Architecture, Role Separation]

## Consensus Protocol (Normative)
[Voting Thresholds, Evidence Standards, Anti-Consensus Protocol]

## Execution Protocol (Normative)
[Phase progression, handoffs, gates]

## Output Artifacts (Normative)
[Required outputs, formats]

## Security Considerations
[Trust model, agent verification]

## References
### Normative References
### Informative References

## Appendices (Informative)
### A. Examples
### B. Quick Start Guide
```

### 5.5 Cross-Reference Pattern

Instead of embedding task IDs, use cross-references:

```markdown
Implementation status is tracked in [CONSENSUS-FRAMEWORK-STATUS.md](./CONSENSUS-FRAMEWORK-STATUS.md).

For the current investigation, see the Status Document Section 2: Active Claims.
```

---

## Summary

The CONSENSUS-FRAMEWORK-SPEC.md exhibits several anti-patterns common when specifications evolve organically:

1. **Mixing concerns**: Normative spec + status tracking + changelog in one document
2. **Missing formalism**: No RFC 2119 boilerplate, no conformance clause
3. **Implicit requirements**: Imperatives without MUST/SHOULD/MAY qualification
4. **Embedded mutability**: Task IDs and investigation status that change frequently

Following IETF/W3C best practices would yield:
- A stable, versioned specification document
- Separate status/tracking documents
- Clear normative vs informative boundaries
- Testable conformance criteria

---

## Sources

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels
- RFC 8174: Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
- RFC 7322: RFC Style Guide
- RFC 2026: The Internet Standards Process
- IESG Statement: Normative and Informative References
- W3C QA Framework: Specification Guidelines
- W3C Process Document (2024)
- W3C Manual of Style
- OASIS Keyword Guidelines for Specifications and Standards
- ETSI: A Guide To Writing World Class Standards
