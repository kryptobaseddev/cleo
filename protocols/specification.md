# Specification Protocol

**Provenance**: @task T3155, @epic T3147
**Version**: 1.0.1
**Type**: Conditional Protocol
**Max Active**: 3 protocols (including base)

---

## Trigger Conditions

This protocol activates when the task involves:

| Trigger | Keywords | Context |
|---------|----------|---------|
| Design | "spec", "specification", "design", "architect" | System design |
| Contract | "contract", "interface", "API", "schema" | Interface definition |
| Definition | "define", "formalize", "standardize" | Precise semantics |
| Protocol | "protocol", "workflow", "process" | Behavioral rules |

**Explicit Override**: `--protocol specification` flag on task creation.

---

## Requirements (RFC 2119)

### MUST

| Requirement | Description |
|-------------|-------------|
| SPEC-001 | MUST use RFC 2119 keywords for requirements |
| SPEC-002 | MUST include version number and status |
| SPEC-003 | MUST define scope and authority |
| SPEC-004 | MUST include conformance criteria |
| SPEC-005 | MUST document related specifications |
| SPEC-006 | MUST use structured format (tables, schemas) |
| SPEC-007 | MUST set `agent_type: "specification"` in manifest |

### SHOULD

| Requirement | Description |
|-------------|-------------|
| SPEC-010 | SHOULD include examples for each requirement |
| SPEC-011 | SHOULD document failure modes |
| SPEC-012 | SHOULD specify error handling |
| SPEC-013 | SHOULD include changelog |

### MAY

| Requirement | Description |
|-------------|-------------|
| SPEC-020 | MAY include implementation guidance |
| SPEC-021 | MAY reference external standards |
| SPEC-022 | MAY define extension points |

---

## Output Format

### Specification Structure

```markdown
# {Specification Title}

**Version**: X.Y.Z
**Status**: DRAFT|ACTIVE|DEPRECATED
**Created**: YYYY-MM-DD
**Updated**: YYYY-MM-DD
**Epic**: T####

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this
document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174].

---

## Part 1: Preamble

### 1.1 Purpose

{Why this specification exists}

### 1.2 Scope

{What this specification covers and excludes}

### 1.3 Authority

This specification is **AUTHORITATIVE** for:
- {Area 1}
- {Area 2}

This specification **DEFERS TO**:
- {Related spec 1}
- {Related spec 2}

---

## Part 2: {Main Content}

### 2.1 {Section}

{Content with RFC 2119 requirements}

| Requirement | Description |
|-------------|-------------|
| REQ-001 | {MUST/SHOULD/MAY} {requirement} |

### 2.2 Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.com/schema.json",
  "type": "object",
  "properties": {}
}
```

---

## Part 3: Conformance

### 3.1 Conformance Classes

A conforming implementation MUST:
- {Requirement 1}
- {Requirement 2}

A conforming implementation MAY:
- {Optional extension}

---

## Part 4: Related Specifications

| Document | Relationship |
|----------|--------------|
| {Spec Name} | {AUTHORITATIVE|DEFERS TO|Related} |

---

## Appendix A: Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | YYYY-MM-DD | Initial specification |

---

*End of Specification*
```

### Version Semantics

| Version Change | When |
|----------------|------|
| Major (X.0.0) | Breaking changes to requirements |
| Minor (X.Y.0) | New requirements, backward compatible |
| Patch (X.Y.Z) | Clarifications, typo fixes |

### Status Lifecycle

```
DRAFT -> ACTIVE -> DEPRECATED
          |
          +-> SUPERSEDED (by new spec)
```

### File Output

```markdown
# {Specification Title}

**Task**: T####
**Date**: YYYY-MM-DD
**Status**: complete|partial|blocked
**Agent Type**: specification

---

## Summary

{2-3 sentence summary of what this spec defines}

## Key Definitions

| Term | Definition |
|------|------------|
| {Term} | {Definition} |

## Requirements Summary

| ID | Level | Requirement |
|----|-------|-------------|
| REQ-001 | MUST | {Requirement} |

## Open Questions

- {Questions needing resolution}
```

### Manifest Entry

@skills/_shared/manifest-operations.md

Use `cleo research add` to create the manifest entry:

```bash
cleo research add \
  --title "Specification: Title" \
  --file "YYYY-MM-DD_specification.md" \
  --topics "specification,design" \
  --findings "12 MUST requirements,5 SHOULD requirements,Schema defined" \
  --status complete \
  --task T#### \
  --actionable \
  --agent-type specification
```

---

## Integration Points

### Base Protocol

- Inherits task lifecycle (focus, execute, complete)
- Inherits manifest append requirement
- Inherits error handling patterns

### Protocol Interactions

| Combined With | Behavior |
|---------------|----------|
| research | Research informs spec decisions |
| consensus | Consensus resolves spec ambiguities |
| implementation | Spec guides implementation |

### Review Patterns

| Aspect | Review Focus |
|--------|--------------|
| Completeness | All requirements have RFC 2119 level |
| Testability | Requirements can be verified |
| Consistency | No contradicting requirements |
| Scope | Authority boundaries clear |

---

## Example

**Task**: Define protocol stack architecture

**Manifest Entry Command**:
```bash
cleo research add \
  --title "Specification: Protocol Stack Architecture" \
  --file "2026-01-26_protocol-stack-spec.md" \
  --topics "protocol,architecture,subagent" \
  --findings "Base protocol always loaded,Max 3 active protocols,Conditional loading defined" \
  --status complete \
  --task T2401 \
  --epic T2392 \
  --actionable \
  --needs-followup T2404 \
  --agent-type specification
```

---

## Anti-Patterns

| Pattern | Why Avoid |
|---------|-----------|
| Vague requirements without levels | Cannot verify compliance |
| Missing version number | Cannot track changes |
| Undefined scope | Unclear authority |
| No examples | Hard to implement correctly |
| Skipping RFC 2119 declaration | Ambiguous requirement levels |

---

*Protocol Version 1.0.0 - Specification Protocol*
