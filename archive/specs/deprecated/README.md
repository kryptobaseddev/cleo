# Deprecated Specifications Archive

**Purpose**: Preserve historical specifications that were never implemented or were superseded by operational reality.

---

## Archival Policy

Specifications are archived here when they meet **any** of these criteria:

1. **Never Implemented**: Spec was approved but zero implementation occurred
2. **Operational Conflict**: Actual working system diverged from spec fundamentally
3. **Superseded**: Replaced by newer specification with different approach
4. **Research-Only**: Created for exploration, not intended for implementation

---

## Archive Structure

Each archived spec includes:
- Original content preserved verbatim
- Deprecation header at top with:
  - Deprecation date
  - Reason for archival
  - Superseding document (if applicable)
  - Historical context

---

## Current Archive

| File | Version | Archived | Reason | Superseded By |
|------|---------|----------|--------|---------------|
| RELEASE-VERSION-MANAGEMENT-SPEC.md | 2.0.0 | 2026-01-27 | Zero implementation, conflicts with operational reality | RELEASE-MANAGEMENT-SPEC.md v2.0.0 |

---

## Usage Guidelines

### For LLM Agents

**DO NOT** reference these specs for implementation guidance. They represent historical design decisions that were not adopted.

**DO** reference them for:
- Understanding why certain approaches were rejected
- Learning from design evolution
- Historical context for current system

### For Developers

Archived specs are **read-only historical records**. They should not be:
- Modified (except to fix broken links)
- Used as implementation guidance
- Referenced in active specifications

---

## Related Documentation

- **Active Specs**: `docs/specs/` (authoritative source)
- **SPEC-INDEX.json**: Tracks deprecated specs with `status: "DEPRECATED"`
- **RELEASE-MANAGEMENT-SPEC.md**: Current authoritative release workflow

---

*Archive maintained by CLEO project | Last updated: 2026-01-27*
