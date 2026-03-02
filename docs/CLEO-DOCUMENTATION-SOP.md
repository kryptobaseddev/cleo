# CLEO Documentation Standard Operating Procedures

**Version**: 2026.3.2
**Status**: APPROVED
**Scope**: All documentation within the CLEO project

---

## 1. Purpose

This document defines the standards for creating, organizing, naming, and maintaining documentation in the CLEO project. All contributors — human and agent — MUST follow these procedures to ensure consistency, discoverability, and long-term maintainability.

Key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" follow RFC 2119 semantics when used in specifications.

---

## 2. File Organization

Documentation lives under `docs/` and is organized into four categories:

| Directory | Purpose | Naming Convention |
|-----------|---------|-------------------|
| `docs/specs/` | Canonical specifications and formal contracts | `UPPER-KEBAB-CASE.md` |
| `docs/guides/` | User guides, tutorials, and how-to documents | `lower-kebab-case.md` |
| `docs/adrs/` | Architecture Decision Records | `ADR-NNN-short-description.md` |
| `docs/concepts/` | Foundational material, explainers, and vision docs | `lower-kebab-case.md` |

### Root-Level Docs

Project-level documents in the `docs/` root use `UPPER-KEBAB-CASE.md`:
- `docs/RECOVERY-RUNBOOK.md`
- `docs/SUMMARY.md`
- `docs/INDEX.md`

### Source-Adjacent Docs

`CLAUDE.md` and `AGENTS.md` files live at the repository root per their respective tooling requirements. These are not duplicated into `docs/`.

---

## 3. Naming Conventions

### Specifications (`docs/specs/`)

Format: `UPPER-KEBAB-CASE.md`

Suffix conventions:
- `-SPEC.md` for formal specifications (e.g., `CLEO-DATA-INTEGRITY-SPEC.md`)
- `-SPECIFICATION.md` for full-length server/protocol specs (e.g., `MCP-SERVER-SPECIFICATION.md`)
- No suffix for reference documents (e.g., `VERB-STANDARDS.md`, `SCHEMA-AUTHORITY.md`)

### Guides (`docs/guides/`)

Format: `lower-kebab-case.md`

Examples: `migration-safety.md`, `protocol-enforcement.md`, `task-fields.md`

### Architecture Decision Records (`docs/adrs/`)

Format: `ADR-NNN-short-description.md`

The sequence number `NNN` is zero-padded to three digits. Use the next available number when creating a new ADR.

### General Rules

- Use hyphens (`-`) as word separators, never underscores or spaces
- Filenames MUST NOT contain version numbers (versions go in frontmatter)
- No trailing punctuation in filenames

---

## 4. Spec Template

All specifications in `docs/specs/` SHOULD include these sections:

```markdown
# Title

**Version**: YYYY.MM.DD or semver
**Status**: DRAFT | REVIEW | APPROVED | STABLE | SUPERSEDED | ARCHIVED
**Date**: YYYY-MM-DD
**Authors**: Contributors

---

## 1. Overview

Brief summary of what this specification covers and why it exists.

## 2. Terminology

Key terms and definitions used in this document.

## 3. Specification

The normative content. Use RFC 2119 keywords (MUST, SHOULD, MAY)
for requirements.

## 4. Examples

Concrete examples demonstrating the specification in practice.

## 5. References

- Links to related specs, ADRs, and external resources
- Task references where applicable (e.g., T1234)
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| Version | Yes | CalVer (`YYYY.MM.DD`) or semver for specs |
| Status | Yes | Current lifecycle stage (see Section 5) |
| Date | Recommended | Last-modified date |
| Authors | Recommended | Primary contributors |
| Task | Recommended | Originating CLEO task ID (e.g., T1234) |

---

## 5. Document Lifecycle

Documents progress through the following stages:

```
DRAFT ──► REVIEW ──► APPROVED ──► STABLE
                                     │
                                     ▼
                                 SUPERSEDED ──► ARCHIVED
```

| Status | Meaning |
|--------|---------|
| `DRAFT` | Work in progress, not yet ready for review |
| `REVIEW` | Content complete, under review for accuracy |
| `APPROVED` | Reviewed and accepted, may still receive minor updates |
| `STABLE` | Mature, no changes expected without a formal process |
| `SUPERSEDED` | Replaced by a newer document (see Section 8) |
| `ARCHIVED` | No longer relevant, retained for historical reference |

### Transition Rules

- `DRAFT` → `REVIEW`: Author marks content as complete
- `REVIEW` → `APPROVED`: Reviewer verifies accuracy and completeness
- `APPROVED` → `STABLE`: Document survives at least one release cycle without changes
- Any status → `SUPERSEDED`: A replacement document is published
- `SUPERSEDED` → `ARCHIVED`: After a deprecation period (minimum one release cycle)

---

## 6. Cross-References

### Internal References

Use relative paths from the referencing document:

```markdown
See [Verb Standards](specs/VERB-STANDARDS.md) for canonical verb definitions.
```

From AGENTS.md or CLAUDE.md, use the `@` directive for auto-inclusion:

```markdown
@docs/CLEO-DOCUMENTATION-SOP.md
```

### Bidirectional References

When document A references document B, document B SHOULD include a back-reference in its References section. This ensures discoverability in both directions.

### Task References

All documentation created as part of a CLEO task MUST include the task ID in the frontmatter or header. Format: `(T####)`.

### External References

External URLs SHOULD be placed in the References section, not inline, to simplify link maintenance.

---

## 7. Quality Standards

### Language

- Specifications MUST use RFC 2119 keywords (MUST, SHOULD, MAY) for normative requirements
- Guides SHOULD use clear, direct language without RFC 2119 formality
- All docs MUST avoid time estimates (no hours, days, or duration predictions)

### Content

- Every specification MUST have a clear scope statement
- Code examples MUST be syntactically valid and tested where possible
- Tables are preferred over prose for structured data (verb matrices, field definitions, status enums)

### Formatting

- Use ATX-style headers (`#`, `##`, `###`)
- Use fenced code blocks with language identifiers
- One blank line between sections
- No trailing whitespace

### Maintenance

- Documents MUST be updated when the features they describe change
- Stale documentation is treated as a bug
- Commit messages for documentation changes use `docs:` type prefix

---

## 8. Deprecation Policy

When a document is superseded:

1. Add a deprecation notice at the top of the old document:

```markdown
> **SUPERSEDED**: This document has been replaced by
> [New Document](path/to/new-document.md) as of YYYY-MM-DD.
> Retained for historical reference.
```

2. Update the `Status` frontmatter field to `SUPERSEDED`
3. Add a "Supersedes" reference in the new document's frontmatter or References section
4. Do NOT delete the old document — it serves as historical context
5. After one release cycle, the status MAY be changed to `ARCHIVED`

---

## 9. ADR Format

Architecture Decision Records follow a minimal structure:

```markdown
# ADR-NNN: Title

**Status**: Proposed | Accepted | Deprecated | Superseded
**Date**: YYYY-MM-DD
**Task**: T####

## Context

What is the issue or situation that motivates this decision?

## Decision

What is the change being proposed or enacted?

## Consequences

What are the positive, negative, and neutral outcomes of this decision?
```

ADRs are immutable once accepted. If a decision is reversed, create a new ADR that supersedes the original rather than editing it.

---

## 10. Guide Format

Guides in `docs/guides/` follow a practical, task-oriented structure:

```markdown
# Title

**Task**: T####
**Epic**: T####

---

## Overview

What this guide covers and when to use it.

## Prerequisites

What you need before starting.

## Steps / Architecture / Details

The main content, organized by topic.

## Troubleshooting

Common issues and solutions.
```

Guides prioritize practical examples and step-by-step instructions over formal specification language.

---

## References

- [VERB-STANDARDS.md](specs/VERB-STANDARDS.md) — Canonical verb standards
- [MCP-SERVER-SPECIFICATION.md](specs/MCP-SERVER-SPECIFICATION.md) — MCP server contract
- [AGENTS.md](/AGENTS.md) — Repository guidelines (references this SOP)
- RFC 2119 — Key words for use in RFCs to indicate requirement levels
