# Archive Directory

**Purpose**: Historical reference for completed work, superseded designs, and development lifecycle artifacts.

**Last Updated**: 2026-01-02

---

## Directory Structure

```
archive/
├── ARCHIVE-POLICY.md      # Retention policy and archival guidelines
├── README.md              # This file
│
├── dev-lifecycle/         # Test reports, bug fixes, implementation guides
│   └── (68 files)         # Migrated from claudedocs/.archive/
│
├── development-process/   # Development findings, orchestration summaries
│   ├── CriticalFindingsSummary.md
│   ├── DELIVERABLES-SUMMARY.md
│   └── FinalOrchestrationSummary.md
│
├── early-design/          # Initial schemas, prompts, design validation
│   └── cladue-todo-plans/ # Original system design (pre-CLEO)
│
├── epic-analysis/         # Completed epic analysis docs
│   ├── CLEO-CI-CD-PIPELINE-SYSTEM.md
│   ├── Project-Lifecycle-Research.txt
│   ├── T1028-DEEP-ANALYSIS-Epic-Report.md
│   └── T1028-EPIC-Enhanced-Epic.md
│
├── legacy-docs/           # Old system documentation
│   └── old-system-readme.md
│
├── meta-docs/             # CLAUDE.md templates and optimization guides
│   └── claude-md/
│
├── planning/              # Implementation roadmaps
│   └── IMPLEMENTATION-ROADMAP.md
│
├── quality-assurance/     # Validation reports, QA sign-offs
│   └── FINAL-VALIDATION-REPORT.md
│
└── specs/                 # Superseded specifications (empty)
```

---

## Category Descriptions

### dev-lifecycle/
Test reports, bug fixes, and implementation guides from active development phases. Includes:
- `*-test-report.md` - Feature and regression test results
- `T###-*.md` - Task-specific fixes and implementations
- `P#-*.md` - Priority-based bug fixes
- Security audit documentation

### development-process/
High-level development process documentation including critical findings, deliverables summaries, and orchestration patterns.

### early-design/
Initial system design artifacts from before the CLEO rebrand. Includes:
- Original schema designs
- Initial system prompts
- Design validation reports

### epic-analysis/
Completed epic analysis documents. When epics complete, their T-prefixed analysis docs may be moved here after manual review.

### legacy-docs/
Documentation from previous system versions, preserved for historical reference.

### meta-docs/
CLAUDE.md optimization guides and templates. Reference material for agent configuration.

### planning/
Implementation roadmaps and planning documents. Historical record of project planning.

### quality-assurance/
QA validation reports and sign-offs. Documents the validation journey and quality gates.

### specs/
Superseded or deprecated specifications. When a spec is replaced, the old version moves here.

---

## Usage Guidelines

1. **Reference only** - Archive contents are historical reference, not active documentation
2. **Link appropriately** - When referencing archived content, use relative links: `[Doc](../archive/category/file.md)`
3. **Add archive headers** - All archived files should have the standard archive header (see ARCHIVE-POLICY.md)
4. **Respect retention** - See ARCHIVE-POLICY.md for retention periods and cleanup schedule

---

## Related Documentation

| Document | Location |
|----------|----------|
| Archive Policy | `archive/ARCHIVE-POLICY.md` |
| Active Specs | `docs/specs/` |
| Internal Docs | `claudedocs/` |
| User Docs | `docs/` |
