# Archive Retention Policy

**Version**: 1.0.0
**Effective**: 2026-01-02
**Last Updated**: 2026-01-02

---

## Purpose

This document defines the retention policy for archived documentation in the CLEO project. The archive serves as historical reference for completed work, superseded designs, and development lifecycle artifacts.

---

## Archive Structure

```
archive/
├── development-process/   # Development findings, orchestration summaries
├── dev-lifecycle/         # Test reports, bug fixes, implementation guides
├── early-design/          # Initial schemas, prompts, design validation
├── epic-analysis/         # T-prefixed epic analysis (when completed)
├── legacy-docs/           # Old system documentation
├── meta-docs/             # CLAUDE.md templates and optimization guides
├── planning/              # Implementation roadmaps, planning docs
├── quality-assurance/     # Validation reports, QA sign-offs
└── specs/                 # Superseded or deprecated specifications
```

---

## What Gets Archived

### ARCHIVE (move to archive/)

| Content Type | Trigger | Destination |
|--------------|---------|-------------|
| Test reports | Tests passing, feature complete | `dev-lifecycle/` |
| Bug fix summaries | Fix verified and released | `dev-lifecycle/` |
| Epic analysis docs | Epic completed | `epic-analysis/` |
| Superseded specs | New spec replaces old | `specs/` |
| Completed project docs | Project finished | Appropriate category |
| Planning documents | Plan executed | `planning/` |

### DO NOT ARCHIVE

| Content Type | Reason |
|--------------|--------|
| Active specs | Still governing implementation |
| Proposals/drafts | Potential future work |
| Reference documentation | Actively used |
| T-prefixed docs for open epics | Work in progress |

---

## Retention Periods

| Category | Retention | Rationale |
|----------|-----------|-----------|
| `dev-lifecycle/` | 6 months | Test/bug history useful for regression analysis |
| `early-design/` | Indefinite | Historical record of project origins |
| `epic-analysis/` | 1 year | May inform future similar work |
| `specs/` | Indefinite | Legal/compliance reference |
| `planning/` | 6 months | Planning patterns may be reused |
| `quality-assurance/` | 1 year | Audit trail |
| `meta-docs/` | Indefinite | Template reference |

---

## Archival Process

### Before Archiving

1. Verify content is no longer actively referenced
2. Check for broken links that would result from move
3. Add archive header to document:

```markdown
> **ARCHIVED DOCUMENT**
>
> **Archived**: YYYY-MM-DD
> **Reason**: [Why this was archived]
> **Superseded by**: [Link to replacement if applicable]
>
> This document is preserved for historical reference only.
```

### During Archive

1. Move file to appropriate category directory
2. Update any references in active docs to point to archive location
3. Remove from active indexes (SPEC-INDEX.json, etc.)

### After Archive

1. Verify file accessible in new location
2. Confirm no broken links in active documentation

---

## Cleanup Schedule

| Frequency | Action |
|-----------|--------|
| Monthly | Review `dev-lifecycle/` for files >6 months old |
| Quarterly | Review `planning/` and `epic-analysis/` for cleanup |
| Annually | Full archive audit, delete expired content |

---

## Referencing Archived Documents

Archived documents MAY be referenced from active docs when:
- Providing historical context
- Explaining design evolution
- Pointing to superseded approaches

Use relative links: `[Old Design](../archive/early-design/example.md)`

---

## Manual Review Policy

When epics complete (T-prefixed docs), use manual review:

1. Flag T-prefixed docs for review when epic status → done
2. Review within 2 weeks of epic completion
3. Archive or keep based on ongoing reference value
4. Document decision in commit message

---

## Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-01-02 | Initial policy established |
