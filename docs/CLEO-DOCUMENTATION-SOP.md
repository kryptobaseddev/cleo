# CLEO Documentation Standard Operating Procedures

**Version**: 2026.4.8
**Status**: APPROVED
**Scope**: All documentation within the CLEO project

---

## 1. Purpose

This document defines the standards for creating, organizing, naming, and maintaining documentation in the CLEO project. All contributors — human and agent — MUST follow these procedures to ensure consistency, discoverability, and long-term maintainability.

Key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" follow RFC 2119 semantics when used in specifications.

---

## 2. File Organization

Documentation lives under `docs/` and is organized into six categories. ADRs are managed separately by CLEO.

| Directory | Purpose | Naming Convention |
|-----------|---------|-------------------|
| `docs/specs/` | Normative specifications, formal contracts, and integration plans | `UPPER-KEBAB-CASE.md` |
| `docs/guides/` | User-facing reference guides, tutorials, and how-to documents | `lower-kebab-case.md` |
| `docs/concepts/` | Identity, vision, manifesto, and foundational explainers | `UPPER-KEBAB-CASE.md` |
| `docs/plans/` | Active engineering plans (ULTRAPLAN, blueprints, execution logs) | `UPPER-KEBAB-CASE.md` |
| `docs/architecture/` | ERDs, type contracts, and config platform design | `lower-kebab-case.md` or `UPPER-KEBAB-CASE.md` |
| `docs/generated/` | Auto-generated API docs from `forge-ts` | Various (machine-generated) |
| `.cleo/adrs/` | Architecture Decision Records (managed by `cleo adr` commands) | `ADR-NNN-short-description.md` |

### ADR Location

ADRs live at `.cleo/adrs/`, NOT under `docs/`. They are managed by `cleo adr` CLI commands. Do NOT create ADRs manually in `docs/` or any subdirectory of it.

### Root-Level Docs

Project-level documents in the `docs/` root use `UPPER-KEBAB-CASE.md`:
- `docs/CLEO-DOCUMENTATION-SOP.md` (this file)

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

Examples: `migration-safety.md`, `task-system-hardening.md`, `CANT-REFERENCE.md`

### Plans (`docs/plans/`)

Format: `UPPER-KEBAB-CASE.md`

Plans MUST be active. Superseded plans are deleted (git history preserves them).

### Architecture (`docs/architecture/`)

Format: `lower-kebab-case.md` or `UPPER-KEBAB-CASE.md`

Examples: `config-platform.md`, `DATABASE-ERDS.md`, `TYPE-CONTRACTS.md`

### Architecture Decision Records (`.cleo/adrs/`)

Format: `ADR-NNN-short-description.md`

The sequence number `NNN` is zero-padded to three digits. Use `cleo adr` to create new ADRs.

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
**Status**: DRAFT | REVIEW | APPROVED | STABLE | SUPERSEDED
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
DRAFT --> REVIEW --> APPROVED --> STABLE --> (delete when superseded)
```

| Status | Meaning |
|--------|---------|
| `DRAFT` | Work in progress, not yet ready for review |
| `REVIEW` | Content complete, under review for accuracy |
| `APPROVED` | Reviewed and accepted, may still receive minor updates |
| `STABLE` | Mature, no changes expected without a formal process |
| `SUPERSEDED` | Replaced by a newer document — DELETE the old file |

### Transition Rules

- `DRAFT` -> `REVIEW`: Author marks content as complete
- `REVIEW` -> `APPROVED`: Reviewer verifies accuracy and completeness
- `APPROVED` -> `STABLE`: Document survives at least one release cycle without changes
- Any status -> `SUPERSEDED`: A replacement document is published; the old file is DELETED

### No Archive Directory

CLEO does not maintain an archive directory. When a document is superseded or its work is complete, the file is deleted. Git history preserves the full content for historical reference. This prevents documentation drift and keeps the `docs/` tree honest.

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
- Historical documents (analysis reports, epic summaries, wave reports) are deleted when work completes

---

## 8. Deletion Policy

When a document is superseded or its work is complete:

1. DELETE the file from the repository
2. Git history preserves the full content for anyone who needs it
3. If the new document replaces an old one, add a "Supersedes" note in the new document's References section

Documents MUST NOT be kept "for historical reference" in the working tree. The `docs/` directory contains only current, verifiable documentation.

### What Gets Deleted

- **Completion reports**: Wave reports, validation reports, audit summaries — deleted after work ships
- **Epic docs**: Coordination summaries, epic tracking docs — deleted after all tasks complete
- **Superseded plans**: Deleted when a replacement plan is published
- **Working docs**: Research notes, draft audits — deleted when absorbed into specs or abandoned

---

## 9. Generated Documentation

The `docs/generated/` directory contains API documentation produced by `forge-ts`. These files are regenerated on significant API changes and MUST NOT be edited by hand.

To regenerate:

```bash
pnpm run forge-ts  # or the project-specific generation command
```

---

## 10. ADR Format

Architecture Decision Records follow a minimal structure and are managed at `.cleo/adrs/`:

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

ADRs are immutable once accepted. If a decision is reversed, create a new ADR that supersedes the original rather than editing it. Use `cleo adr` commands to manage ADRs.

---

## 11. Guide Format

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
