# Issue Lifecycle Specification

**Version**: 1.0.0
**Status**: DRAFT
**Created**: 2025-12-29
**Related**: RELEASE-MANAGEMENT-SPEC.md, IMPLEMENTATION-ORCHESTRATION-SPEC.md, PROJECT-LIFECYCLE-SPEC.md

---

## RFC 2119 Conformance

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT",
"SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and
"OPTIONAL" in this document are to be interpreted as described in
BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all
capitals, as shown here.

[RFC 2119]: https://www.rfc-editor.org/rfc/rfc2119
[RFC 8174]: https://www.rfc-editor.org/rfc/rfc8174.html

---

## Preamble

### Purpose

This specification defines the **Issue Lifecycle Protocol** for CLEO, covering how external inputs (bug reports, feature requests, security issues) are ingested, triaged, tracked, and resolved. Issues are tracked as Tasks/Epics within CLEO's existing hierarchy, using the `origin` field to maintain provenance.

### Authority

This specification is **AUTHORITATIVE** for:

- Issue origin schema (`origin` field)
- Issue lifecycle states and transitions
- Triage workflow and severity classification
- Issue-to-Task/Epic relationships
- Verification and closure criteria
- External reference linking (GitHub, JIRA, etc.)
- Exit codes 60-69 (Issue Management)

This specification **DEFERS TO**:

- [IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md) for task verification
- [RELEASE-MANAGEMENT-SPEC.md](RELEASE-MANAGEMENT-SPEC.md) for release tracking
- [LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md) for JSON output standards

### Core Principle

> **Issues ARE Tasks.** CLEO does not have a separate "issue" entity. Issues are Tasks or Epics with an `origin` field that tracks their external source.

---

## Part 1: Architecture Overview

### 1.1 Issue Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                           ISSUE LIFECYCLE FLOW                                       │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  EXTERNAL INPUT                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Bug Report ───────┐                                                          │   │
│  │  Feature Request ──┼──► ct issue create "Title" --type bug --ref GH-123       │   │
│  │  Security Issue ───┤                                                          │   │
│  │  Technical Debt ───┘                                                          │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                       │                                              │
│                                       ▼                                              │
│  TRIAGE                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  ct issue triage T500 --severity major --phase maintenance                    │   │
│  │                                                                               │   │
│  │  • Assign severity (critical/major/minor/trivial)                             │   │
│  │  • Assign phase (where in lifecycle to fix)                                   │   │
│  │  • Assign priority (relative to other work)                                   │   │
│  │  • Link to affected Epic (optional)                                           │   │
│  │  • Determine scope: Task (simple fix) or Epic (complex fix)                   │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                    ┌────────────────────┴────────────────────┐                      │
│                    │                                         │                      │
│                    ▼                                         ▼                      │
│  SIMPLE FIX (Task)                           COMPLEX FIX (Epic)                     │
│  ┌──────────────────────────┐                ┌──────────────────────────┐           │
│  │  Single task, quick fix  │                │  Epic with multiple tasks │           │
│  │  Direct implementation   │                │  RCSD pipeline for spec   │           │
│  └────────────┬─────────────┘                └────────────┬─────────────┘           │
│               │                                           │                          │
│               └─────────────────┬─────────────────────────┘                          │
│                                 │                                                    │
│                                 ▼                                                    │
│  IMPLEMENTATION                                                                     │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  Implementation Orchestration Pipeline                                        │   │
│  │  Coder → Testing → QA → Cleanup → Security → Docs                             │   │
│  │                                                                               │   │
│  │  Task: verification.passed = true                                             │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  VERIFICATION                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  ct issue verify T500                                                         │   │
│  │                                                                               │   │
│  │  • Confirm fix resolves the reported issue                                    │   │
│  │  • Regression test added                                                      │   │
│  │  • Original reporter notified (if applicable)                                 │   │
│  └──────────────────────────────────────┬───────────────────────────────────────┘   │
│                                         │                                            │
│                                         ▼                                            │
│  CLOSURE                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  ct issue close T500 --resolution fixed                                       │   │
│  │                                                                               │   │
│  │  Task: status = "done"                                                        │   │
│  │  Task: origin.resolution = "fixed"                                            │   │
│  │  Task: origin.fixedIn = "v0.42.1"                                             │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Issue Types

| Type | Description | Typical Scope | Priority Default |
|------|-------------|---------------|------------------|
| `bug-report` | Something is broken | Task or Epic | Based on severity |
| `feature-request` | User wants new functionality | Epic | medium |
| `security` | Security vulnerability | Task (urgent) | critical |
| `technical-debt` | Internal improvement | Task or Epic | low |
| `dependency` | External dependency issue | Task | Based on severity |
| `regression` | Previously working, now broken | Task | high |

---

## Part 2: Schema Definition

### 2.1 Origin Field

Add to task definition:

```json
{
  "origin": {
    "type": ["object", "null"],
    "default": null,
    "description": "External origin tracking for issues, bugs, and feature requests.",
    "additionalProperties": false,
    "properties": {
      "type": {
        "type": "string",
        "enum": ["internal", "bug-report", "feature-request", "security", "technical-debt", "dependency", "regression"],
        "description": "How this work was initiated"
      },
      "ref": {
        "type": ["string", "null"],
        "maxLength": 100,
        "pattern": "^[A-Z]+-\\d+$|^#\\d+$|^[a-f0-9]{7,40}$",
        "description": "External reference (GH-123, JIRA-456, #123, commit hash)"
      },
      "url": {
        "type": ["string", "null"],
        "format": "uri",
        "description": "URL to external issue tracker"
      },
      "reportedAt": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "When issue was originally reported"
      },
      "reporter": {
        "type": ["string", "null"],
        "maxLength": 100,
        "description": "Who reported (username, email, 'anonymous')"
      },
      "severity": {
        "type": ["string", "null"],
        "enum": ["critical", "major", "minor", "trivial", null],
        "description": "Issue severity (for bug-report, security, regression)"
      },
      "affectedVersion": {
        "type": ["string", "null"],
        "pattern": "^v?\\d+\\.\\d+\\.\\d+",
        "description": "Version where issue was discovered"
      },
      "affectedEpic": {
        "type": ["string", "null"],
        "pattern": "^T\\d{3,}$",
        "description": "Epic whose functionality is affected"
      },
      "resolution": {
        "type": ["string", "null"],
        "enum": ["fixed", "wontfix", "duplicate", "invalid", "cannot-reproduce", null],
        "description": "How issue was resolved"
      },
      "fixedIn": {
        "type": ["string", "null"],
        "pattern": "^v\\d+\\.\\d+\\.\\d+",
        "description": "Release version containing the fix"
      },
      "duplicateOf": {
        "type": ["string", "null"],
        "pattern": "^T\\d{3,}$",
        "description": "If duplicate, which task is the original"
      },
      "verifiedAt": {
        "type": ["string", "null"],
        "format": "date-time",
        "description": "When fix was verified"
      },
      "verifiedBy": {
        "type": ["string", "null"],
        "maxLength": 100,
        "description": "Who verified the fix"
      }
    },
    "required": ["type"]
  }
}
```

### 2.2 Issue Lifecycle in Task Status

Issues use existing task `status` field with additional semantics:

| Status | Issue Meaning |
|--------|---------------|
| `pending` | Reported, awaiting triage |
| `active` | Being worked on |
| `blocked` | Blocked by dependency or unclear requirements |
| `done` | Fixed and verified (check `origin.resolution`) |
| `cancelled` | Closed without fix (check `origin.resolution` for reason) |

---

## Part 3: Issue Lifecycle States

### 3.1 State Machine

```
                    ┌───────────────────────────────────────────────────────────┐
                    │                    ISSUE LIFECYCLE                         │
                    └───────────────────────────────────────────────────────────┘

                              ct issue create
                    ┌───────────┐ ─────────────────► ┌─────────────┐
                    │ EXTERNAL  │                    │  REPORTED   │
                    │  SOURCE   │                    │ (pending)   │
                    └───────────┘                    └──────┬──────┘
                                                           │
                                                 ct issue triage
                                                           │
                                 ┌─────────────────────────┼─────────────────────────┐
                                 │                         │                         │
                                 ▼                         ▼                         ▼
                          ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
                          │   TRIAGED   │          │   INVALID   │          │  DUPLICATE  │
                          │  (pending)  │          │ (cancelled) │          │ (cancelled) │
                          └──────┬──────┘          └─────────────┘          └─────────────┘
                                 │
                            ct focus set
                                 │
                                 ▼
                          ┌─────────────┐
                          │  IN WORK    │◄────────────────────────┐
                          │  (active)   │                         │
                          └──────┬──────┘                         │
                                 │                                │
                       Implementation complete                    │
                                 │                         Fix rejected
                                 ▼                                │
                          ┌─────────────┐                         │
                          │  VERIFYING  │─────────────────────────┘
                          │  (active)   │
                          └──────┬──────┘
                                 │
                           ct issue verify
                                 │
                                 ▼
                          ┌─────────────┐
                          │   FIXED     │
                          │   (done)    │
                          └──────┬──────┘
                                 │
                            ct release ship
                                 │
                                 ▼
                          ┌─────────────┐
                          │  RELEASED   │
                          │   (done)    │
                          └─────────────┘
```

### 3.2 Resolution Types

| Resolution | Meaning | Final Status |
|------------|---------|--------------|
| `fixed` | Issue resolved with code change | `done` |
| `wontfix` | Will not fix (by design, out of scope) | `cancelled` |
| `duplicate` | Same as another issue | `cancelled` |
| `invalid` | Not actually a bug/issue | `cancelled` |
| `cannot-reproduce` | Cannot recreate the issue | `cancelled` |

---

## Part 4: CLI Commands

### 4.1 Issue Management

```bash
# Create an issue
ct issue create <title> [OPTIONS]
  --type <bug-report|feature-request|security|technical-debt|dependency|regression>
  --ref <external-ref>        # GH-123, JIRA-456, #123
  --url <external-url>        # Link to external tracker
  --severity <critical|major|minor|trivial>
  --reporter <username>
  --affected-version <version>
  --affected-epic <epic-id>   # Which Epic's functionality is broken
  --description <text>
  --phase <phase>             # Where to fix (default: maintenance)
  --priority <priority>       # Override default priority

# Triage an issue
ct issue triage <task-id> [OPTIONS]
  --severity <severity>       # Set/update severity
  --priority <priority>       # Set priority
  --phase <phase>             # Assign to phase
  --affected-epic <epic-id>   # Link to affected Epic
  --promote-to-epic           # Convert to Epic (for complex fixes)

# List issues
ct issue list [OPTIONS]
  --type <type>               # Filter by origin type
  --severity <severity>       # Filter by severity
  --status <status>           # Filter by status
  --unverified                # Show fixed but unverified
  --format <text|json|markdown>

# Verify an issue fix
ct issue verify <task-id> [OPTIONS]
  --verified-by <username>
  --notes <text>

# Close an issue
ct issue close <task-id> --resolution <resolution> [OPTIONS]
  --duplicate-of <task-id>    # Required if resolution=duplicate
  --notes <text>

# Reopen a closed issue
ct issue reopen <task-id> --reason <text>

# Link issue to release
ct issue link-release <task-id> <version>
```

### 4.2 Examples

```bash
# Report a bug from GitHub
ct issue create "Login fails with special characters" \
  --type bug-report \
  --ref GH-456 \
  --severity major \
  --affected-version v0.41.0 \
  --phase maintenance

# Triage the issue
ct issue triage T500 \
  --priority high \
  --affected-epic T998

# After fix is implemented and tested
ct issue verify T500 --verified-by @qa-team

# Close when released
ct issue close T500 --resolution fixed
ct issue link-release T500 v0.41.1

# Handle a duplicate
ct issue close T501 --resolution duplicate --duplicate-of T500
```

---

## Part 5: Severity and Priority

### 5.1 Severity Classification

| Severity | Definition | Response Time | Examples |
|----------|------------|---------------|----------|
| `critical` | System unusable, data loss, security breach | Immediate | Auth bypass, data corruption |
| `major` | Major functionality broken | Within 24h | Cannot complete core workflow |
| `minor` | Minor functionality broken, workaround exists | Within sprint | UI glitch with workaround |
| `trivial` | Cosmetic, no functional impact | Best effort | Typo, minor styling |

### 5.2 Severity to Priority Mapping

| Severity | Default Priority | Rationale |
|----------|------------------|-----------|
| `critical` | `critical` | Stop everything, fix now |
| `major` | `high` | Fix soon, may block users |
| `minor` | `medium` | Schedule in upcoming work |
| `trivial` | `low` | Fix when convenient |

### 5.3 Security Issue Handling

Security issues (`origin.type = security`) have special handling:

1. **Always `critical` priority** regardless of severity
2. **Private by default** - not shown in public roadmaps
3. **Fast-track verification** - security team must verify
4. **Coordinated disclosure** - track disclosure timeline

```bash
# Create security issue
ct issue create "SQL injection in user search" \
  --type security \
  --severity critical \
  --priority critical \
  --phase maintenance
```

---

## Part 6: Issue-Epic Relationship

### 6.1 Affected Epic Tracking

When a bug affects functionality delivered by an Epic:

```json
{
  "id": "T500",
  "title": "Fix: Session timeout too short",
  "origin": {
    "type": "bug-report",
    "ref": "GH-789",
    "severity": "major",
    "affectedEpic": "T998",
    "affectedVersion": "v0.41.0"
  }
}
```

### 6.2 Epic Regression Tracking

Epics can track their "health" based on linked issues:

```bash
# Show Epic health
ct show T998 --include-issues

# Output:
# Epic T998: Multi-Session Support
# Status: released (v0.41.0)
#
# Open Issues: 2
#   T500 [major] Session timeout too short
#   T502 [minor] Focus not restored on resume
#
# Fixed Issues: 3
#   T499 [major] Fixed in v0.41.1
#   ...
```

---

## Part 7: Verification Protocol

### 7.1 Verification Requirements

Before an issue can be marked as verified:

1. **Fix implemented** - Task `verification.passed = true`
2. **Regression test added** - Test that would catch recurrence
3. **Original scenario tested** - Exact reported scenario works
4. **No side effects** - Related functionality still works

### 7.2 Verification Command

```bash
ct issue verify T500 \
  --verified-by @qa-team \
  --notes "Tested with special chars: !@#$%^&*(). All pass."
```

This sets:
- `origin.verifiedAt = now()`
- `origin.verifiedBy = "@qa-team"`
- Adds note to task notes

### 7.3 Unverified Issue Tracking

```bash
# List fixed but unverified issues
ct issue list --status done --unverified

# Block release if unverified issues exist
ct release verify v0.42.0
# ERROR: 2 issues fixed but not verified: T500, T502
```

---

## Part 8: External Integration

### 8.1 GitHub Integration

```bash
# Import issue from GitHub
ct issue import --github owner/repo#123

# Sync status back to GitHub
ct issue sync T500 --github
# Updates GH-123 with CLEO status

# Auto-close GitHub issue on release
# Configured via hooks
```

### 8.2 Reference Format Support

| Format | Platform | Example |
|--------|----------|---------|
| `GH-<num>` | GitHub | GH-123 |
| `#<num>` | GitHub (short) | #123 |
| `JIRA-<num>` | Jira | PROJ-456 |
| `BUG-<num>` | Generic | BUG-789 |
| `<hash>` | Git commit | abc1234 |

---

## Part 9: Error Codes (60-69)

| Code | Constant | Meaning |
|------|----------|---------|
| 60 | `E_ISSUE_CREATE_FAILED` | Failed to create issue |
| 61 | `E_INVALID_ORIGIN_TYPE` | Unknown origin type |
| 62 | `E_INVALID_SEVERITY` | Unknown severity level |
| 63 | `E_INVALID_RESOLUTION` | Unknown resolution type |
| 64 | `E_ALREADY_VERIFIED` | Issue already verified |
| 65 | `E_NOT_FIXED` | Cannot verify unfixed issue |
| 66 | `E_DUPLICATE_NOT_FOUND` | Duplicate-of task doesn't exist |
| 67 | `E_CANNOT_REOPEN` | Cannot reopen (wrong state) |
| 68 | `E_EXTERNAL_SYNC_FAILED` | Failed to sync with external tracker |
| 69 | `E_ISSUE_LOCKED` | Issue is locked (released) |

---

## Part 10: Reporting

### 10.1 Issue Metrics

```bash
ct issue stats [OPTIONS]
  --since <date>            # Filter by date range
  --until <date>
  --by-type                 # Group by origin type
  --by-severity             # Group by severity
  --by-resolution           # Group by resolution
  --format <text|json>
```

**Output Example**:
```
ISSUE STATISTICS (Last 30 days)
═══════════════════════════════════════════════════════════════════════════════

Total Issues: 47
  Open: 12
  Fixed: 32
  Won't Fix: 3

By Type:
  bug-report:      28 (60%)
  feature-request: 12 (26%)
  security:         4 (8%)
  technical-debt:   3 (6%)

By Severity:
  critical:  3 (6%)
  major:    15 (32%)
  minor:    22 (47%)
  trivial:   7 (15%)

Average Time to Fix:
  critical: 4 hours
  major:    2 days
  minor:    5 days
  trivial:  12 days

Top Affected Epics:
  T998 Multi-Session: 8 issues
  T850 Auth System:   5 issues
```

---

## Part 11: Conformance

### 11.1 Conformance Requirements

A conforming implementation MUST:

- Support `origin` schema field (Part 2)
- Support all issue CLI commands (Part 4)
- Support severity classification (Part 5)
- Support verification workflow (Part 7)
- Use exit codes 60-69 (Part 9)

A conforming implementation SHOULD:

- Support external reference formats (Part 8)
- Support issue metrics (Part 10)
- Track affected Epics (Part 6)

A conforming implementation MAY:

- Support external tracker sync (GitHub, Jira)
- Support custom severity levels
- Support custom resolution types

---

## Part 12: Related Specifications

| Document | Relationship |
|----------|--------------|
| **[RELEASE-MANAGEMENT-SPEC.md](RELEASE-MANAGEMENT-SPEC.md)** | **Downstream**: Issues feed into releases |
| **[IMPLEMENTATION-ORCHESTRATION-SPEC.md](IMPLEMENTATION-ORCHESTRATION-SPEC.md)** | **Implementation**: How fixes are implemented |
| **[PROJECT-LIFECYCLE-SPEC.md](PROJECT-LIFECYCLE-SPEC.md)** | **Context**: Greenfield/brownfield patterns |
| **[LLM-AGENT-FIRST-SPEC.md](LLM-AGENT-FIRST-SPEC.md)** | **AUTHORITATIVE**: JSON output standards |

---

## Appendix A: Quick Reference

### Issue Commands

```bash
# Create
ct issue create "Title" --type bug-report --severity major

# Triage
ct issue triage T500 --priority high --phase maintenance

# Work
ct focus set T500
# ... implement fix ...
ct complete T500

# Verify
ct issue verify T500 --verified-by @qa

# Close
ct issue close T500 --resolution fixed
```

### Issue Flow

```
create → triage → implement → verify → close → release
```

### Severity Levels

```
critical > major > minor > trivial
```

### Resolution Types

```
fixed | wontfix | duplicate | invalid | cannot-reproduce
```

---

## Appendix B: Version History

### Version 1.0.0 (2025-12-29)

- Initial specification
- Origin schema for issue tracking
- Triage workflow
- Verification protocol
- Severity classification
- External reference support
- Exit codes 60-69

---

*End of Specification*
