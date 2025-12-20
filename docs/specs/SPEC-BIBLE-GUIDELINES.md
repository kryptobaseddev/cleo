# Specification Bible Guidelines

**Version**: 1.0.0
**Status**: IMMUTABLE
**Effective**: All specifications in this repository
**Last Updated**: 2025-12-17

---

## Purpose

This document establishes the **HARD RULES** for writing and maintaining specification documents in this project. These guidelines ensure specifications remain stable, authoritative reference documents while implementation progress is tracked separately.

> **This document is the authoritative source for specification standards.**
> All specifications MUST comply with these guidelines.

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [BCP 14](https://www.rfc-editor.org/info/bcp14) [[RFC2119](https://www.rfc-editor.org/rfc/rfc2119)] [[RFC8174](https://www.rfc-editor.org/rfc/rfc8174)] when, and only when, they appear in all capitals.

---

## Part 1: The Fundamental Principle

### 1.1 Separation of Concerns

**Specifications define WHAT. Implementation Reports track WHO, WHEN, and HOW MUCH.**

```
┌─────────────────────────────────┐    ┌─────────────────────────────────┐
│      SPECIFICATION              │    │    IMPLEMENTATION REPORT        │
│      (Immutable Contract)       │    │    (Mutable Status)             │
├─────────────────────────────────┤    ├─────────────────────────────────┤
│ • Requirements (WHAT)           │    │ • Status (done/pending)         │
│ • Constraints (WHAT limits)     │    │ • Checklists ([ ] / [x])        │
│ • Data formats (WHAT shape)     │    │ • Phase tracking                │
│ • Error codes (WHAT failures)   │    │ • Completion percentages        │
│ • Behavioral contracts          │    │ • Timeline milestones           │
│ • Acceptance criteria           │    │ • Assignments (WHO)             │
└─────────────────────────────────┘    └─────────────────────────────────┘
         ↓                                        ↓
    NEVER CHANGES                          UPDATES FREQUENTLY
    (versioned amendments only)            (reflects current state)
```

### 1.2 The Golden Rule

> **Once a specification is APPROVED or IMMUTABLE, it becomes a historical document.**
> Changes require versioned amendments or superseding documents—never in-place modification.

This follows the IETF model: "RFCs never change, but RFC status can change over time."

---

## Part 2: Hard Rules

### 2.1 MUST Rules (Absolute Requirements)

| Rule | Rationale |
|------|-----------|
| Specifications **MUST NOT** contain implementation status | Specs become stale tracking documents |
| Specifications **MUST NOT** contain checklists with `[ ]` or `[x]` | Checklists are mutable tracking |
| Specifications **MUST NOT** contain completion percentages | "75% complete" is implementation state |
| Specifications **MUST NOT** contain timeline estimates | Dates couple spec to delivery schedule |
| Specifications **MUST NOT** contain assignee names | Coupling to org structure |
| Specifications **MUST** use RFC 2119 keywords for requirements | Precision in requirement levels |
| Specifications **MUST** include a Related Specifications section | Dependency mapping |
| Specifications **MUST** link to Implementation Report for status | Clear separation of concerns |
| Specifications **MUST** have version and status metadata | Authority identification |
| Specifications **MUST** define WHAT, never HOW | Behavioral contracts, not implementation |

### 2.2 MUST NOT Rules (Absolute Prohibitions)

**The following content MUST NOT appear in specifications:**

| Prohibited Content | Example | Belongs In |
|--------------------|---------|------------|
| Status tracking | "COMPLETE", "IN PROGRESS", "PENDING" | Implementation Report |
| Checkboxes | `- [ ] Task`, `- [x] Done` | Implementation Report |
| Percentages | "80% complete", "3/4 done" | Implementation Report |
| Dates/Timelines | "Target: 2025-12-30", "Sprint 5" | Implementation Report |
| Assignees | "@alice", "Team A owns this" | Implementation Report |
| Phase status | "Phase 1: COMPLETE" | Implementation Report |
| Implementation code | Actual implementation snippets | Source code |
| Algorithm details | Step-by-step procedures | Design documents |

### 2.3 SHOULD Rules (Strong Recommendations)

| Rule | Rationale |
|------|-----------|
| Specifications SHOULD include examples | Clarifies intent |
| Specifications SHOULD use tables for structured data | Scannability |
| Specifications SHOULD have numbered Parts | Enables precise cross-references |
| Specifications SHOULD include decision rationale in appendices | Historical context |
| Specifications SHOULD define all technical terms | Unambiguous interpretation |

### 2.4 MAY Rules (Optional)

| Rule | When Applicable |
|------|-----------------|
| Specifications MAY include industry precedents | Validates design decisions |
| Specifications MAY include rejected alternatives | Documents decision process |
| Specifications MAY use YAML frontmatter | For machine-parseable metadata |

---

## Part 3: RFC 2119 Keywords

### 3.1 Keyword Definitions

| Keyword | Synonyms | Meaning | Use When |
|---------|----------|---------|----------|
| **MUST** | REQUIRED, SHALL | Absolute requirement | Non-negotiable for compliance |
| **MUST NOT** | SHALL NOT | Absolute prohibition | Behavior that causes harm or breaks interop |
| **SHOULD** | RECOMMENDED | Strong recommendation | Default behavior; exceptions require justification |
| **SHOULD NOT** | NOT RECOMMENDED | Strong discouragement | Acceptable rarely with careful evaluation |
| **MAY** | OPTIONAL | Truly optional | Implementations may differ; interop required regardless |

### 3.2 Critical Usage Rules

1. **Case Sensitivity**: Keywords have normative meaning **ONLY when UPPERCASE**
   - `MUST` = absolute requirement
   - `must` = ordinary English (no special meaning)

2. **Required Boilerplate**: Every specification with requirements MUST include:
   ```
   The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
   "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
   "OPTIONAL" in this document are to be interpreted as described in
   BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals.
   ```

3. **Usage Constraints**:
   - Use ONLY where required for interoperability or safety
   - NEVER use to impose implementation methods
   - Document security implications of not following MUST/SHOULD

### 3.3 Examples

**Correct:**
```markdown
The system MUST authenticate users before granting access.
The system SHOULD cache responses for performance.
The system MAY support multiple authentication providers.
```

**Incorrect (implementation-coupled):**
```markdown
The system MUST use bcrypt with cost factor 12.
The system MUST query the PostgreSQL users table.
```

---

## Part 4: Document Types

### 4.1 Specification (SPEC)

**Purpose**: Define requirements, contracts, and constraints

**Contains**:
- Behavioral requirements (WHAT the system does)
- Data formats and schemas (WHAT shape)
- Error codes and conditions (WHAT failures)
- Acceptance criteria (WHAT defines success)
- Constraints and invariants (WHAT limits)

**Does NOT Contain**:
- Implementation status
- Timelines or dates
- Assignees or ownership
- Progress tracking

**Naming**: `[DOMAIN]-SPEC.md` or `[DOMAIN]-[FEATURE]-SPEC.md`

### 4.2 Implementation Report

**Purpose**: Track progress against a specification

**Contains**:
- Status (done/pending/in-progress/blocked)
- Checklists with checkboxes
- Phase tracking and milestones
- Completion percentages
- Assignees and ownership
- Timeline targets

**Does NOT Contain**:
- New requirements (those go in spec)
- Design decisions (those go in spec)

**Naming**: `[SPEC-NAME]-IMPLEMENTATION-REPORT.md`

### 4.3 Relationship

```
SPECIFICATION                    IMPLEMENTATION REPORT
     │                                    │
     │  "See Implementation Report        │
     │   for status tracking"             │
     │ ─────────────────────────────────► │
     │                                    │
     │  "Implements requirements          │
     │   from [SPEC.md]"                  │
     │ ◄───────────────────────────────── │
     │                                    │
```

---

## Part 5: Status Lifecycle

### 5.1 Valid Status Values

| Status | Meaning | Can Change | Amendments |
|--------|---------|------------|------------|
| **DRAFT** | Work in progress | Yes, frequently | Direct edits OK |
| **APPROVED** | Endorsed, ready for implementation | Yes, with version bump | Formal amendments |
| **IMMUTABLE** | Locked forever, reference document | NEVER | Must supersede |
| **ACTIVE** | Current design, may evolve | Yes, carefully | Minor version bumps |
| **DEPRECATED** | No longer valid, historical only | No | N/A |

### 5.2 Lifecycle Flow

```
                    ┌─────────────┐
                    │   DRAFT     │
                    └──────┬──────┘
                           │ (team approval)
                           ▼
          ┌────────────────┴────────────────┐
          │                                 │
          ▼                                 ▼
   ┌─────────────┐                  ┌─────────────┐
   │  APPROVED   │                  │   ACTIVE    │
   └──────┬──────┘                  └──────┬──────┘
          │ (finalization)                 │ (evolution)
          ▼                                │
   ┌─────────────┐                         │
   │  IMMUTABLE  │◄────────────────────────┘
   └──────┬──────┘     (when stabilized)
          │
          ▼ (replacement)
   ┌─────────────┐
   │ DEPRECATED  │
   └─────────────┘
```

### 5.3 Amendment Rules

| Status | Amendment Process |
|--------|-------------------|
| **DRAFT** | Direct edits allowed |
| **APPROVED** | Version bump required (1.0 → 1.1); document changes |
| **IMMUTABLE** | Cannot amend; must create new superseding spec |
| **ACTIVE** | Minor version bumps (2.0 → 2.1); document changes |
| **DEPRECATED** | No amendments; historical record |

---

## Part 6: Document Structure Template

### 6.1 Required Sections

Every specification MUST include:

```markdown
# [Title]

**Version**: X.Y.Z
**Status**: [DRAFT | APPROVED | IMMUTABLE | ACTIVE | DEPRECATED]
**Effective**: vX.Y.Z+ (or date)
**Last Updated**: YYYY-MM-DD

---

## RFC 2119 Conformance

[Boilerplate text - see Part 3.2]

---

## Preamble

[Why this document exists, context, authority level]

---

## Executive Summary

[Mission, core principles, key decisions summary]

---

## Part 1: [First Major Topic]

[Content...]

---

## Part N: [Last Major Topic]

[Content...]

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [Spec Name](file.md) | [AUTHORITATIVE for X | Defers to this | Implements | Related] |
| [Implementation Report](file.md) | Tracks status |

---

*End of Specification*
```

### 6.2 Optional Sections

```markdown
## Appendix A: Decision Rationale

| Decision | Alternatives Considered | Why Chosen |
|----------|------------------------|------------|

## Appendix B: Industry Precedents

| System | Pattern | Relevance |
|--------|---------|-----------|

## Appendix C: Rejected Alternatives

| Alternative | Why Rejected |
|-------------|--------------|

## Appendix D: Version History

| Version | Date | Changes |
|---------|------|---------|
```

### 6.3 Error Code Section (When Applicable)

```markdown
## Error Codes

### Exit Codes

| Code | Constant | Meaning | Recoverable |
|------|----------|---------|-------------|
| 0 | EXIT_SUCCESS | Operation completed | N/A |
| 1 | EXIT_GENERAL_ERROR | Unspecified error | Yes |

### Error Strings

| Code | Exit Code | Description |
|------|-----------|-------------|
| `E_TASK_NOT_FOUND` | 4 | Task ID does not exist |
```

---

## Part 7: Cross-Reference Standards

### 7.1 Link Format

```markdown
# File reference
[Document Name](filename.md)

# Section reference
[Document Name](filename.md#section-anchor)

# Internal reference
See **Part 3.2** for details

# Inline callout
**Cross-reference**: [Document](file.md) defines [topic]
```

### 7.2 Relationship Language

| Relationship | Phrasing |
|--------------|----------|
| Authoritative | "**AUTHORITATIVE** for [domain]" |
| Defers to | "Defers to [spec] for [domain]" |
| Implements | "Implements [spec]" |
| Depends on | "Depends on [spec]" |
| Related | "Related: [connection]" |
| Tracks | "Tracks implementation status" |

### 7.3 Avoiding Redundancy

**Problem**: Information duplicated across specs leads to inconsistency.

**Solution**: Mark ONE spec as AUTHORITATIVE for each domain.

```markdown
> **AUTHORITATIVE SOURCE**:
> [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md)
> defines the ID system. This spec defers to it on conflicts.
```

---

## Part 8: Implementation Report Structure

When creating an Implementation Report:

```markdown
# [Spec Name] Implementation Report

**Purpose**: Track implementation progress
**Related Spec**: [Spec Name](spec-file.md)
**Last Updated**: YYYY-MM-DD

---

## Summary

| Metric | Value |
|--------|-------|
| Overall Progress | XX% |
| Components Complete | X/Y |
| Current Phase | [Phase Name] |

---

## Component Status

| Component | Status | Notes |
|-----------|--------|-------|
| Feature 1 | COMPLETE | Shipped v0.17.0 |
| Feature 2 | IN PROGRESS | 80% done |
| Feature 3 | PENDING | Blocked by #123 |

---

## Phase Tracking

### Phase 1: [Name] - [STATUS]

- [x] Task 1
- [x] Task 2
- [ ] Task 3

### Phase 2: [Name] - [STATUS]

- [ ] Task 1
- [ ] Task 2

---

## Milestones

| Milestone | Target | Status |
|-----------|--------|--------|
| Alpha | 2025-12-01 | COMPLETE |
| Beta | 2025-12-30 | IN PROGRESS |
| GA | 2026-01-15 | PENDING |

---

## Blockers

| Issue | Impact | Mitigation |
|-------|--------|------------|
| [#123] | Blocks Feature 2 | Workaround in progress |

---

## How to Update

1. Run compliance check: `dev/check-compliance.sh`
2. Update status tables
3. Update Last Updated date
```

---

## Part 9: Naming Conventions

### 9.1 File Naming

| Type | Pattern | Example |
|------|---------|---------|
| Design Spec | `[DOMAIN]-SPEC.md` | `LLM-AGENT-FIRST-SPEC.md` |
| Feature Spec | `[DOMAIN]-[FEATURE]-SPEC.md` | `TASK-HIERARCHY-SPEC.md` |
| System Spec | `[DOMAIN]-SYSTEM-DESIGN-SPEC.md` | `LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md` |
| Implementation Report | `[SPEC-NAME]-IMPLEMENTATION-REPORT.md` | `LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md` |
| Guidelines | `[DOMAIN]-GUIDELINES.md` | `SPEC-BIBLE-GUIDELINES.md` |

### 9.2 Section Numbering

```markdown
## Part 1: Major Topic
### 1.1 Subtopic
#### 1.1.1 Detail
```

**Rationale**: Enables precise citations ("See Part 5.3.2")

### 9.3 Version Format

**Semantic Versioning**: `MAJOR.MINOR.PATCH`

| Change Type | Version Bump | Example |
|-------------|--------------|---------|
| Breaking/major design change | MAJOR | 1.0.0 → 2.0.0 |
| Backward-compatible addition | MINOR | 1.0.0 → 1.1.0 |
| Clarification/typo fix | PATCH | 1.0.0 → 1.0.1 |

---

## Part 10: Anti-Patterns

### 10.1 What vs How Violation

**Wrong** (prescribes implementation):
```markdown
The system SHALL use bcrypt with cost factor 12 for password hashing.
The system SHALL query the PostgreSQL users table.
```

**Correct** (specifies behavior):
```markdown
The system SHALL securely hash passwords before storage.
The system SHALL verify credentials against the user store.
```

### 10.2 Status in Specification

**Wrong**:
```markdown
## Implementation Status

- [x] Feature 1 - COMPLETE
- [ ] Feature 2 - IN PROGRESS (80%)
- [ ] Feature 3 - PENDING
```

**Correct**:
```markdown
## Implementation Reference

> Implementation status is tracked separately.
> See [Implementation Report](SPEC-IMPLEMENTATION-REPORT.md)
```

### 10.3 Timeline in Specification

**Wrong**:
```markdown
### Phase 1 (v0.15.0 - Target: Dec 2025)
- Feature 1: 2 weeks
- Feature 2: 1 week
```

**Correct**:
```markdown
### Phase 1 Requirements

Feature 1 MUST:
- [requirement 1]
- [requirement 2]

Feature 2 SHOULD:
- [requirement 1]
```

---

## Part 11: Compliance Checklist

Use this checklist to validate specification compliance:

### Document Structure
- [ ] Has version and status metadata
- [ ] Has RFC 2119 conformance section (if requirements exist)
- [ ] Has Preamble or Executive Summary
- [ ] Has numbered Parts for major sections
- [ ] Has Related Specifications section
- [ ] Links to Implementation Report for status

### Content Rules
- [ ] NO status tracking (done/pending/in-progress)
- [ ] NO checklists with `[ ]` or `[x]`
- [ ] NO completion percentages
- [ ] NO timeline estimates or dates
- [ ] NO assignee names
- [ ] Uses RFC 2119 keywords correctly (UPPERCASE only)
- [ ] Defines WHAT, not HOW

### Cross-References
- [ ] Uses markdown links for file references
- [ ] Uses Part numbers for internal references
- [ ] Declares AUTHORITATIVE source where applicable
- [ ] Avoids content duplication with other specs

---

## Part 12: Quick Reference Card

### Specification Contains

| YES | NO |
|-----|-----|
| Requirements (MUST/SHOULD/MAY) | Status (done/pending) |
| Constraints and limits | Checklists [ ] |
| Data formats and schemas | Percentages (80%) |
| Error codes and conditions | Dates and timelines |
| Behavioral contracts | Assignee names |
| Acceptance criteria | Implementation code |

### RFC 2119 Quick Guide

```
MUST     = Absolute requirement (non-negotiable)
MUST NOT = Absolute prohibition
SHOULD   = Recommended (exceptions need justification)
MAY      = Optional (implementation choice)
```

### Status Quick Guide

```
DRAFT      = Work in progress, editable
APPROVED   = Endorsed, amendments need version bump
IMMUTABLE  = Locked forever, cannot change
ACTIVE     = Current design, careful evolution
DEPRECATED = Historical only, do not use
```

---

## Appendix A: Industry Precedents

| Organization | Practice | Our Adoption |
|--------------|----------|--------------|
| **IETF** | RFCs never change; status tracked separately | IMMUTABLE specs + Implementation Reports |
| **W3C** | Specs use RFC 2119; clear conformance sections | RFC 2119 in all specs |
| **Kubernetes** | KEPs separate spec from status in header | Metadata headers |
| **Python** | PEPs become historical after acceptance | APPROVED/IMMUTABLE lifecycle |
| **ECMAScript** | Spec separate from compatibility tables | Spec + Implementation Report |

## Appendix B: Sources

- [RFC 2119 - Key words for RFCs](https://www.rfc-editor.org/rfc/rfc2119)
- [RFC 8174 - Uppercase vs Lowercase](https://www.rfc-editor.org/rfc/rfc8174)
- [RFC 7322 - RFC Style Guide](https://www.rfc-editor.org/rfc/rfc7322)
- [W3C Manual of Style](https://www.w3.org/guide/manual-of-style/)
- [Semantic Versioning 2.0.0](https://semver.org/)
- [Kubernetes Enhancement Proposals](https://www.kubernetes.dev/resources/keps/)
- [PEP 1 - PEP Purpose and Guidelines](https://peps.python.org/pep-0001/)

## Appendix C: Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2025-12-17 | Initial IMMUTABLE release |

---

## Related Specifications

| Document | Relationship |
|----------|--------------|
| [LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md](LLM-TASK-ID-SYSTEM-DESIGN-SPEC.md) | Example of IMMUTABLE spec |
| [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) | Example of ACTIVE spec |
| [LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md](LLM-TASK-ID-SYSTEM-DESIGN-IMPLEMENTATION-REPORT.md) | Example of Implementation Report |

---

*End of Specification*
